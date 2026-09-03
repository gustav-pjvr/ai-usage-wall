/**
 * Main process. Owns windows, the desktop layer, data loading and hotkeys.
 *
 * One frameless transparent window PER MONITOR, each rendering the slice of the
 * wall for that monitor. One window stretched across the virtual desktop was
 * rejected: it breaks on mixed-DPI setups (Windows scales the whole surface by
 * the primary monitor's factor) and it forces a full repaint of every monitor
 * when one card changes.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, screen, shell, nativeImage, nativeTheme } from 'electron';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { watch as watchFs, type FSWatcher } from 'node:fs';

import { detectCapability, type Capability } from './capability';
import { loadSettings, saveSettings, type Settings } from './settings';
import { PRODUCT_NAME, isStatsOnly } from '../shared/edition';
import { checkNow, installNow, startUpdater, stopUpdater, updateLabel, updateState } from './updater';
import * as projection from './projection';
import { loadClients, watchClients, type StoreSnapshot } from './data/store';
import {
  PROJECTS_DIR,
  emptyIndex,
  loadIndex,
  refreshIndex,
  saveIndex,
  type IndexProgress,
  type UsageIndex,
} from './data/usage';
import {
  applyLayerMode,
  detach,
  inputReachesWall,
  ensureDpiAwareness,
  sinkToBottom,
  verifyLayer,
  type LayerMode,
} from './win32/desktop-layer';
import { hwndFromBuffer, isAvailable as win32Available, readHkcuDword, unavailableReason } from './win32/ffi';

const isDev = !app.isPackaged;

/** The mode a failed or unknown layer setting is healed back to. */
const DEFAULT_LAYER_MODE: LayerMode = 'desktop';

interface WallWindow {
  win: BrowserWindow;
  displayId: number;
  hwnd: number | null;
  /** The mode actually in force, which may differ from the requested one. */
  effectiveMode: LayerMode;
  /** Whether Windows hit-tests to this window, i.e. whether clicks work. */
  inputReachable: boolean;
}

let windows: WallWindow[] = [];
let tray: Tray | null = null;
/** Which tray art is currently installed, so a no-op theme event costs nothing. */
let trayIsDark = false;
let themeTimer: NodeJS.Timeout | null = null;
let settings: Settings;
let capability: Capability;
let snapshot: StoreSnapshot | null = null;
let stopWatching: (() => void) | null = null;
let focusMode = false;
let hidden = false;
let usage: UsageIndex = emptyIndex();
let usageWatcher: FSWatcher | null = null;
let usageTimer: NodeJS.Timeout | null = null;
let usageBusy = false;
let usageDirty = false;
let usageLastRun = 0;
let usageLastSave = 0;

/*
 * Whether a cold index is still running.
 *
 * refreshIndex mutates the index IN PLACE, so a partially built index is
 * observable while it works. The renderer must not infer readiness from "has
 * some data": doing that showed 5 transcripts and 11.5M tokens as if they were
 * the final figures. Readiness is stated explicitly instead.
 */
let usageIndexing = false;

/*
 * The cache only exists to make the NEXT cold start fast, so writing it on
 * every refresh was pure churn: a 170 KB file rewritten about once a second
 * during an active session. It is written periodically and on quit instead.
 */
const USAGE_SAVE_INTERVAL_MS = 60_000;

/*
 * Floor on how often the dashboard is allowed to change.
 *
 * The watcher fires on every transcript write, so during an active session the
 * numbers were updating about once a second. That is accurate but restless to
 * look at, and the wall is meant to be glanceable. Work is coalesced into at
 * most one refresh per interval; nothing is missed, it just lands together.
 */
const USAGE_MIN_INTERVAL_MS = 4000;

// ── Paths ──────────────────────────────────────────────────────────────────

/**
 * Two roots, and the distinction matters once packaged.
 *
 *  - bundledRoot is read-only shipped content (the tray icon, the seed data).
 *    In a packaged app that is `resources/`, which lives under Program Files
 *    and is NOT writable.
 *  - userRoot is where client JSON actually lives, because the whole point is
 *    that these files get hand-edited. In a packaged app that is userData.
 *
 * In development both collapse to the repo, so editing `data/clients/` works
 * exactly as it does now.
 */
const bundledRoot = () => (app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..'));
const userRoot = () => (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..', '..'));

function resolveClientsDir(): string {
  return settings.clientsDir ?? path.join(userRoot(), 'data', 'clients');
}
function resolveAssetsDir(): string {
  return settings.assetsDir ?? path.join(userRoot(), 'assets', 'clients');
}

/**
 * First run of a packaged build: copy the shipped demonstration data into the
 * writable location. Never overwrites, so an upgrade cannot clobber real client
 * files, and deleting a client stays deleted.
 */
async function seedUserData(): Promise<void> {
  if (!app.isPackaged) return;
  /*
   * The shareable build ships no client records and must never create the
   * folder either. Seeding someone else's machine with MuchBetter's clients is
   * the single most embarrassing thing this app could do.
   */
  if (isStatsOnly) return;
  for (const [from, to] of [
    [path.join(bundledRoot(), 'data', 'clients'), resolveClientsDir()],
    [path.join(bundledRoot(), 'assets', 'clients'), resolveAssetsDir()],
  ]) {
    try {
      await fs.access(to);
      continue; // already seeded, leave it alone
    } catch {
      /* not present, seed it */
    }
    try {
      await fs.mkdir(to, { recursive: true });
      // The assets folder is legitimately optional: a wall with no logos on
      // file is a normal state, so an absent source is not a problem worth
      // reporting. Create the empty target and move on.
      const hasSource = await fs
        .access(from)
        .then(() => true)
        .catch(() => false);
      if (!hasSource) continue;
      await fs.cp(from, to, { recursive: true, force: false, errorOnExist: false });
      console.log(`[main] seeded ${to}`);
    } catch (err) {
      console.warn(`[main] could not seed ${to}: ${(err as Error).message}`);
    }
  }
}

// ── Claude usage ───────────────────────────────────────────────────────────

const usageCacheFile = () => path.join(app.getPath('userData'), 'usage-index.json');

/**
 * Refresh the usage index and push it to the renderer.
 *
 * Serialised with a busy flag: a burst of file events during an active Claude
 * session must not start overlapping scans over the same bytes.
 */
async function refreshUsage(reason: string): Promise<void> {
  if (usageBusy) {
    usageDirty = true;
    return;
  }
  const since = Date.now() - usageLastRun;
  if (usageLastRun && since < USAGE_MIN_INTERVAL_MS) {
    // Too soon. Mark dirty and let the trailing pass pick it up.
    if (!usageDirty) {
      usageDirty = true;
      setTimeout(() => {
        if (!usageDirty) return;
        usageDirty = false;
        void refreshUsage('coalesced');
      }, USAGE_MIN_INTERVAL_MS - since);
    }
    return;
  }
  usageBusy = true;
  usageLastRun = Date.now();
  try {
    const result = await refreshIndex(usage, (p) => pushUsageProgress(p));
    usage = result.index;
    usageIndexing = false;
    if (result.rebuilt) console.log('[usage] a transcript shrank, index rebuilt from scratch');
    if (Date.now() - usageLastSave > USAGE_SAVE_INTERVAL_MS) {
      usageLastSave = Date.now();
      await saveIndex(usageCacheFile(), usage).catch((err) =>
        console.warn('[usage] could not write cache:', (err as Error).message),
      );
    }
    if (usage.unavailable) {
      console.warn(`[usage] source unavailable: ${usage.unavailableReason}`);
    } else {
      console.log(
        `[usage] ${reason}: ${usage.totals.requests.toLocaleString()} requests, ` +
          `${Object.keys(usage.sessions).length} sessions, scan ${usage.lastScanMs}ms`,
      );
    }
    pushUsage();
  } catch (err) {
    usageIndexing = false;
    console.error('[usage] refresh failed:', (err as Error).message);
  } finally {
    usageBusy = false;
    if (usageDirty) {
      usageDirty = false;
      void refreshUsage('coalesced');
    }
  }
}

/**
 * Watch the transcript tree natively and recursively.
 *
 * Windows supports recursive fs.watch, so one watcher covers all 419 files
 * without chokidar walking the 960 MB tree. Debounced, because a single
 * assistant turn produces several writes.
 */
function startUsageWatch(): void {
  try {
    usageWatcher = watchFs(PROJECTS_DIR, { recursive: true, persistent: true }, () => {
      if (usageTimer) clearTimeout(usageTimer);
      usageTimer = setTimeout(() => {
        usageTimer = null;
        void refreshUsage('transcript changed');
      }, 900);
    });
    usageWatcher.on('error', (err) => console.warn('[usage] watcher error:', err.message));
    console.log('[usage] watching', PROJECTS_DIR);
  } catch (err) {
    console.warn('[usage] could not watch transcripts:', (err as Error).message);
  }
}

// ── Asset protocol ─────────────────────────────────────────────────────────

/**
 * Serve client assets over a custom protocol instead of file://.
 *
 * The renderer never gets filesystem access, and every request is resolved
 * against the assets root and rejected if it escapes. A crafted logo path like
 * '../../../../Users/x/.ssh/id_rsa' therefore cannot read anything, which
 * matters because client JSON is hand-edited and its paths are not trusted.
 */
function registerAssetProtocol(): void {
  const { protocol, net } = require('electron') as typeof import('electron');
  protocol.handle('mbw-asset', async (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const root = path.resolve(resolveAssetsDir());
      const target = path.resolve(root, rel);
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        console.warn('[assets] blocked traversal attempt:', rel);
        return new Response('forbidden', { status: 403 });
      }
      await fs.access(target);
      return net.fetch(`file://${target.replace(/\\/g, '/')}`);
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

// ── Tray icon ──────────────────────────────────────────────────────────────

/**
 * Is the TASKBAR dark? Not the same question as "is the app theme dark".
 *
 * Windows keeps two independent settings under Themes\Personalize:
 * `AppsUseLightTheme` for application chrome and `SystemUsesLightTheme` for the
 * taskbar and the tray. A user can run light apps on a dark taskbar, and many
 * do. Electron's `nativeTheme.shouldUseDarkColors` reports the APP one, so
 * using it to pick a TRAY icon is picking the icon by the wrong setting, and it
 * is wrong precisely for the people who mix the two.
 *
 * Read synchronously: this runs once at startup and once per theme change, and
 * the tray icon must not flash the wrong art while a promise resolves.
 */
function taskbarIsDark(): boolean {
  if (process.platform !== 'win32') return nativeTheme.shouldUseDarkColors;
  const v = readHkcuDword(THEME_KEY, 'SystemUsesLightTheme');
  // Absent means light, which is the Windows default when the value was never
  // written. Unreadable means fall back to the app theme, which is at least a
  // related answer rather than a guess.
  if (v === null) return nativeTheme.shouldUseDarkColors;
  return v === 0;
}

/**
 * Watch for the taskbar theme changing.
 *
 * `nativeTheme.on('updated')` is NOT sufficient on its own, and this was tested
 * rather than assumed: flipping SystemUsesLightTheme, even with a
 * WM_SETTINGCHANGE / ImmersiveColorSet broadcast, did not raise the event.
 * Electron's nativeTheme tracks the APP theme, so a taskbar-only change is
 * invisible to it.
 *
 * So the event is kept for the common case (Settings changes both at once, and
 * that path is instant) and a slow poll covers the taskbar-only case. The poll
 * is affordable ONLY because the read is an in-process RegGetValueW rather than
 * a reg.exe spawn: it is a few microseconds every half minute.
 */
// String.raw, because a registry path is the one string where every separator
// is a backslash and a plain quoted literal silently eats all of them.
const THEME_KEY = String.raw`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`;
const THEME_POLL_MS = 30_000;

function syncTrayTheme(reason: string): void {
  if (!tray || tray.isDestroyed()) return;
  const dark = taskbarIsDark();
  if (dark === trayIsDark) return;
  trayIsDark = dark;
  tray.setImage(trayIcon());
  console.log(`[tray] taskbar theme changed (${reason}), switched to the ${dark ? 'dark' : 'light'} mark`);
}

function trayIcon(): Electron.NativeImage {
  /*
   * tray.png is 16px and Electron picks up tray@2x.png automatically for HiDPI
   * displays via the @2x naming convention, so one path covers both.
   *
   * Two sets exist, one per taskbar theme: the mark's plate is white in the
   * light set and near-black in the dark set. A single white chip on a dark
   * taskbar is a glaring rectangle, and a single dark chip on a light one
   * disappears, so the art is chosen rather than compromised.
   */
  const dark = taskbarIsDark();
  const file = path.join(bundledRoot(), 'assets', dark ? 'tray-dark.png' : 'tray.png');
  try {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
    console.warn(`[tray] icon at ${file} is empty; run \`npm run logo\``);
  } catch (err) {
    console.warn(`[tray] could not load ${file}: ${(err as Error).message}`);
  }
  return nativeImage.createEmpty();
}

function buildTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip(PRODUCT_NAME);
    refreshTrayMenu();
    tray.on('double-click', () => toggleHidden());
    trayIsDark = taskbarIsDark();
    console.log(`[tray] using the ${trayIsDark ? 'dark' : 'light'} mark`);

    nativeTheme.on('updated', () => syncTrayTheme('app theme event'));
    themeTimer = setInterval(() => syncTrayTheme('poll'), THEME_POLL_MS);
    themeTimer.unref?.();
  } catch (err) {
    console.error('[tray] could not create tray icon:', (err as Error).message);
  }
}

/**
 * The Projection submenu.
 *
 * Built fresh each time the tray opens, so it always reflects the real state
 * rather than a cached idea of it.
 */
/*
 * The pairing window: the one focusable window this app has.
 *
 * The wall's windows are created `focusable: false` so they can sit behind
 * everything without stealing focus, which makes a text input in them a trap.
 * Typing a code needs a real window, so this is a small one, closable with
 * Escape or its own title bar (rule 17).
 */
let pairWindow: BrowserWindow | null = null;
let pairMode: 'source' | 'screen' = 'source';

function openPairWindow(mode: 'source' | 'screen'): void {
  pairMode = mode;
  if (pairWindow && !pairWindow.isDestroyed()) {
    pairWindow.webContents.send('pair:status', projection.projectionStatus());
    pairWindow.focus();
    return;
  }

  pairWindow = new BrowserWindow({
    width: 460,
    height: mode === 'source' ? 560 : 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: 'Projection',
    backgroundColor: '#26262b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDev,
    },
  });
  pairWindow.setMenu(null);
  void pairWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pair.html'));
  pairWindow.on('closed', () => {
    pairWindow = null;
  });
}

function pushPairStatus(): void {
  if (pairWindow && !pairWindow.isDestroyed()) {
    pairWindow.webContents.send('pair:status', projection.projectionStatus());
  }
}

function projectionMenu(): Electron.MenuItemConstructorOptions[] {
  const status = projection.projectionStatus();
  const head: Electron.MenuItemConstructorOptions[] = [
    { label: projection.projectionLabel(), enabled: false },
    { type: 'separator' },
  ];

  if (status.role === 'off') {
    return [
      ...head,
      {
        label: 'Project this machine to another screen...',
        click: () => {
          void (async () => {
            if (await projection.enableSource(require('node:os').hostname())) openPairWindow('source');
          })();
        },
      },
      {
        label: 'Show another machine here...',
        click: () => {
          if (projection.enableScreen()) openPairWindow('screen');
        },
      },
    ];
  }

  if (status.role === 'source') {
    const screens: Electron.MenuItemConstructorOptions[] = status.screens.length
      ? status.screens.map((sc) => ({
          label: `${sc.label}${sc.online ? '  (connected)' : '  (offline)'}${sc.confirmed ? '' : '  (unconfirmed)'}`,
          submenu: [{ label: 'Remove this screen', click: () => void projection.revokeScreen(sc.screenId) }],
        }))
      : [{ label: 'No screens paired yet', enabled: false }];

    return [
      ...head,
      { label: 'Show a pairing code...', click: () => openPairWindow('source') },
      { type: 'separator' },
      ...screens,
      { type: 'separator' },
      {
        label: 'Send project folder names',
        type: 'checkbox',
        checked: projection.shareProjectNames(),
        click: () => void projection.setShareProjectNames(!projection.shareProjectNames()),
      },
      { type: 'separator' },
      {
        label: 'Stop projecting and forget all screens',
        click: () => void projection.disableProjection(true),
      },
    ];
  }

  return [
    ...head,
    { label: 'Unpair from this source', click: () => void projection.unpairScreen() },
  ];
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const layerItem = (mode: LayerMode, label: string) => ({
    label,
    type: 'radio' as const,
    checked: settings.layerMode === mode,
    click: () => void updateSettings({ layerMode: mode }),
  });

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `${PRODUCT_NAME}  v${app.getVersion()}${isDev ? '  (dev)' : ''}`,
        enabled: false,
      },
      ...(isStatsOnly
        ? []
        : [{ label: `${snapshot?.clients.length ?? 0} records loaded`, enabled: false } as const]),
      { type: 'separator' },
      ...(isStatsOnly ? [] : [{
        label: 'View',
        submenu: [
          {
            label: 'Claude Stats',
            type: 'radio' as const,
            checked: settings.mode === 'stats',
            click: () => void updateSettings({ mode: 'stats' }),
          },
          {
            label: 'MuchBetter Clients',
            type: 'radio' as const,
            checked: settings.mode === 'clients',
            click: () => void updateSettings({ mode: 'clients' }),
          },
        ],
      }]),
      { label: hidden ? 'Show wall' : 'Hide wall', click: () => toggleHidden() },
      { label: focusMode ? 'Leave focus mode' : 'Focus mode', click: () => toggleFocusMode() },
      { type: 'separator' },
      {
        label: 'Desktop layer',
        submenu: [
          layerItem('desktop', 'Behind apps, interactive  (recommended)'),
          layerItem('top', 'Always on top'),
          { type: 'separator' as const },
          // The question the removed "Wallpaper layer, no input" option was
          // being asked to answer, pointed at the setting that answers it.
          { label: 'For a wall that ignores the mouse, use Click-through', enabled: false },
        ],
      },
      {
        label: 'Background',
        submenu: (['gradient', 'plain', 'none'] as const).map((mode) => ({
          label:
            mode === 'gradient'
              ? 'Gradient  (recommended)'
              : mode === 'plain'
                ? 'Solid'
                : 'None, show the wallpaper through',
          type: 'radio' as const,
          checked: settings.background === mode,
          click: () => void updateSettings({ background: mode }),
        })),
      },
      {
        label: 'Click-through',
        type: 'checkbox',
        checked: settings.clickThrough,
        click: () => void updateSettings({ clickThrough: !settings.clickThrough }),
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: settings.startWithWindows,
        click: () => void updateSettings({ startWithWindows: !settings.startWithWindows }),
      },
      { type: 'separator' },
      ...(isStatsOnly
        ? []
        : [
            { label: 'Reload clients', click: () => void reloadData() },
            { label: 'Open client data folder', click: () => void shell.openPath(resolveClientsDir()) },
          ]),
      /*
       * Projection. The submenu shape follows the role, so an off machine is
       * offered two choices and a running one is offered what it can actually
       * do. The first line always states the current state plainly, including
       * "no network", because that is the claim the product makes.
       */
      {
        label: 'Projection',
        submenu: projectionMenu(),
      },
      { type: 'separator' as const },

      /*
       * Updates. Only the shareable build has anything to do here, so the item
       * is absent entirely in the full build rather than present and inert.
       */
      ...(isStatsOnly
        ? [
            {
              label: updateLabel(),
              enabled: updateState().phase === 'ready' || updateState().phase === 'idle' || updateState().phase === 'none' || updateState().phase === 'error',
              click: () => (updateState().phase === 'ready' ? installNow() : checkNow()),
            },
            { type: 'separator' as const },
          ]
        : []),
      {
        label: 'Diagnostics overlay',
        type: 'checkbox',
        checked: settings.debug,
        click: () => void updateSettings({ debug: !settings.debug }),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => quit() },
    ]),
  );
}

// ── Windows ────────────────────────────────────────────────────────────────

function targetDisplays(): Electron.Display[] {
  const all = screen.getAllDisplays();
  if (settings.monitors.length === 0) return all;
  const chosen = all.filter((d) => settings.monitors.includes(d.id));
  return chosen.length ? chosen : all;
}

function createWindowForDisplay(display: Electron.Display): WallWindow {
  const { x, y, width, height } = display.bounds;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    hasShadow: false,
    acceptFirstMouse: true,
    // 'toolbar' keeps it out of Alt+Tab on Windows.
    type: 'toolbar',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Default (true) is what we want: Chromium stops animating this window
      // when it is fully occluded by other apps, which is most of the time.
      backgroundThrottling: true,
      spellcheck: false,
      devTools: isDev,
    },
  });

  win.setMenu(null);
  win.setIgnoreMouseEvents(settings.clickThrough, { forward: true });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((err) => {
    console.error('[main] renderer failed to load:', err);
  });

  const wall: WallWindow = { win, displayId: display.id, hwnd: null, effectiveMode: settings.layerMode, inputReachable: false };

  win.once('ready-to-show', () => {
    win.showInactive();
    try {
      wall.hwnd = hwndFromBuffer(win.getNativeWindowHandle());
    } catch (err) {
      console.error('[main] could not read HWND:', (err as Error).message);
    }
    const layer = applyLayer(wall);
    // Startup self-heal. Whatever is in settings.json, the wall that comes up
    // is one that verified, so a bad mode can never survive a restart.
    if (!layer.ok) healLayerMode(wall, layer.reason);
    pushState(wall);
    if (!wall.win.isDestroyed()) wall.win.webContents.send('wall:usage', usageForRenderer());
    if (usageIndexing && !wall.win.isDestroyed()) {
      // Opened while a cold index is running: keep the loading state up.
      wall.win.webContents.send('wall:usageProgress', {
        done: 0,
        total: 0,
        bytesDone: 0,
        bytesTotal: 0,
        cold: true,
      });
    }
    maybeCapture(wall);
  });

  // Re-assert bottom placement only on the events that can disturb it.
  win.on('show', () => {
    // effectiveMode, not settings.layerMode: what the window is actually in is
    // what decides whether re-anchoring above Progman is the right move.
    if (!focusMode && wall.effectiveMode === 'desktop' && wall.hwnd) sinkToBottom(wall.hwnd);
  });

  win.on('closed', () => {
    windows = windows.filter((w) => w.win !== win);
  });

  return wall;
}

/**
 * Development capture hook.
 *
 * The wall normally sits below every other window, so a desktop screenshot is
 * not a reliable way to see what it actually rendered. capturePage() reads the
 * window's own surface directly, which makes visual verification possible
 * without disturbing the layering. Enabled only by env var, never in normal use.
 */
function maybeCapture(wall: WallWindow): void {
  const target = process.env.MBW_CAPTURE;
  if (!target) return;
  const delay = Number(process.env.MBW_CAPTURE_DELAY ?? 2600);
  // Lets the capture exercise the detail overlay, which cannot otherwise be
  // reached without a real click.
  if (process.env.MBW_CAPTURE_DETAIL) {
    setTimeout(() => {
      wall.win.webContents.send('wall:debugOpenDetail', process.env.MBW_CAPTURE_DETAIL);
    }, Math.max(400, delay - 1200));
  }
  setTimeout(() => {
    wall.win.webContents
      .capturePage()
      .then(async (image) => {
        const file = windows.length > 1 ? target.replace(/\.png$/i, `-${wall.displayId}.png`) : target;
        await fs.writeFile(file, image.toPNG());
        console.log(`[capture] wrote ${file}`);
        if (process.env.MBW_CAPTURE_EXIT === '1') quit();
      })
      .catch((err) => {
        console.error('[capture] failed:', err);
        if (process.env.MBW_CAPTURE_EXIT === '1') quit();
      });
  }, delay);
}

/**
 * Apply a layer mode AND prove the window can still be on screen afterwards.
 *
 * There is deliberately no unverified variant. A layer mode that is applied but
 * never checked is how the wall ended up invisible: the old code trusted a
 * SetParent success that had not happened, then wrote the failing mode to disk,
 * so every restart repeated it. Nothing reaches settings.json now until this
 * function has said ok.
 */
function applyLayer(wall: WallWindow): { ok: boolean; reason?: string } {
  if (!wall.hwnd) return { ok: false, reason: 'no HWND yet' };
  const mode: LayerMode = focusMode ? 'top' : settings.layerMode;
  const display = screen.getAllDisplays().find((d) => d.id === wall.displayId);

  const result = applyLayerMode(wall.hwnd, mode);

  if (result.repaired && display) {
    // It was living inside another window, so its coordinates were relative to
    // that window. Put it back where it belongs now that it owns itself again.
    wall.win.setBounds(display.bounds);
  }

  if (!result.ok) {
    console.warn(`[main] layer mode '${mode}' failed: ${result.reason}`);
    return { ok: false, reason: result.reason };
  }
  wall.effectiveMode = mode;

  const physical = display
    ? {
        x: Math.round(display.bounds.x * display.scaleFactor),
        y: Math.round(display.bounds.y * display.scaleFactor),
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor),
      }
    : { x: 0, y: 0, width: 1, height: 1 };

  const check = verifyLayer(wall.hwnd, { expectVisible: !hidden, display: physical });

  /*
   * Placement is not input. Ask Windows who actually owns a pixel inside our
   * bounds. ADVISORY ONLY: any app the user has open over that point makes it
   * false for a perfectly good reason, so it is reported, never enforced.
   */
  let inputNote = '';
  if (check.ok && !hidden) {
    const probe = inputReachesWall(wall.hwnd, physical);
    wall.inputReachable = probe.reachable;
    inputNote = probe.reachable ? ', input reaches the wall' : `, input goes to '${probe.ownerClass}'`;
  }

  // Click-through is the only thing that suppresses mouse handling now, and
  // focus mode is the only thing that overrides it. This used to also test the
  // REQUESTED layer mode, which meant a mode that had fallen back still left
  // the wall click-through.
  wall.win.setIgnoreMouseEvents(focusMode ? false : settings.clickThrough, { forward: true });
  wall.win.setOpacity(focusMode ? 1 : settings.opacity);

  if (check.ok) {
    const r = check.rect;
    console.log(
      `[main] layer '${mode}' verified: top-level, ${hidden ? 'hidden as asked' : 'visible'}` +
        `${r ? `, ${r.width}x${r.height} at ${r.x},${r.y}` : ''}${inputNote}`,
    );
  } else {
    console.warn(`[main] layer '${mode}' FAILED verification: ${check.failures.join('; ')}`);
  }
  return { ok: check.ok, reason: check.failures.join('; ') };
}

/**
 * Last line of defence: a persisted layer mode that cannot pass verification is
 * replaced with the default and written back, once, so the next launch starts
 * from a mode that works. Idempotent, because every display's window calls it.
 */
function healLayerMode(wall: WallWindow, reason: string | undefined): void {
  if (settings.layerMode === DEFAULT_LAYER_MODE) {
    console.error(
      `[main] layer '${settings.layerMode}' failed verification (${reason}) and there is nothing safer to fall back to`,
    );
    return;
  }
  console.warn(`[main] layer '${settings.layerMode}' failed verification (${reason}); healing to '${DEFAULT_LAYER_MODE}'`);
  settings = { ...settings, layerMode: DEFAULT_LAYER_MODE };
  applyLayer(wall);
  void saveSettings(settings).catch((err) => console.error('[settings] save failed:', err));
  refreshTrayMenu();
}

function rebuildWindows(): void {
  for (const w of windows) {
    if (w.hwnd) detach(w.hwnd);
    if (!w.win.isDestroyed()) w.win.destroy();
  }
  windows = targetDisplays().map(createWindowForDisplay);
}

// ── State push ─────────────────────────────────────────────────────────────

function wallState(wall: WallWindow) {
  const display = screen.getAllDisplays().find((d) => d.id === wall.displayId);
  return {
    clients: snapshot?.clients ?? [],
    problems: snapshot?.problems ?? [],
    vault: snapshot?.vault ?? { available: false, scanned: 0, matched: 0 },
    settings,
    capability,
    focusMode,
    mode: settings.mode,
    appVersion: app.getVersion(),
    effectiveLayerMode: wall.effectiveMode,
    inputReachable: wall.inputReachable,
    display: display
      ? {
          id: display.id,
          width: display.bounds.width,
          height: display.bounds.height,
          scaleFactor: display.scaleFactor,
          isPrimary: display.id === screen.getPrimaryDisplay().id,
          index: screen.getAllDisplays().findIndex((d) => d.id === display.id),
          total: screen.getAllDisplays().length,
        }
      : null,
    win32: { available: win32Available(), reason: unavailableReason() },
  };
}

/**
 * The renderer never reads the per-file offset map, and that map is half the
 * payload: 170 KB was crossing the IPC boundary on every refresh, roughly once
 * a second during an active session. Send a projection instead.
 */
function usageForRenderer(): Record<string, unknown> {
  /*
   * A SCREEN shows the source's numbers, not its own. It does not index its own
   * transcripts at all while paired, so `usage` here is an empty index and
   * returning it would paint a wall of zeros, which rule 12 forbids.
   */
  if (projection.isScreen()) {
    const projected = projection.projectedUsage();
    if (projected) return { ...projected, projection: projection.projectionStatus() };
    // Paired but nothing received yet. Say so rather than showing an empty index.
    return { ...emptyIndex(), fileCount: 0, indexing: false, projection: projection.projectionStatus() };
  }
  const { files, ...rest } = usage;
  return { ...rest, fileCount: Object.keys(files).length, indexing: usageIndexing, projection: projection.projectionStatus() };
}

/**
 * Progress for the loading state. Only meaningful during a cold index; an
 * incremental top-up finishes faster than anything could be drawn.
 */
function pushUsageProgress(p: IndexProgress): void {
  if (!p.cold) return;
  usageIndexing = true;
  for (const w of windows) {
    if (w.win.isDestroyed()) continue;
    w.win.webContents.send('wall:usageProgress', p);
  }
}

function pushUsage(): void {
  /*
   * Hand the projector a copy before anything else. It returns synchronously
   * after setting a flag; the encrypting and sending happen on a later tick, so
   * a relay outage can never slow the local dashboard down (rule 30).
   */
  projection.offerUsage(usage, usageIndexing);
  const payload = usageForRenderer();
  for (const w of windows) {
    if (w.win.isDestroyed()) continue;
    w.win.webContents.send('wall:usage', payload);
  }
}

function pushState(wall?: WallWindow): void {
  const targets = wall ? [wall] : windows;
  for (const w of targets) {
    if (w.win.isDestroyed()) continue;
    w.win.webContents.send('wall:state', wallState(w));
  }
}

async function reloadData(): Promise<void> {
  snapshot = await loadClients({
    clientsDir: resolveClientsDir(),
    vaultPath: settings.vaultPath,
    useVault: settings.useVault,
  });
  const errs = snapshot.problems.filter((p) => p.issues.some((i) => i.severity === 'error'));
  console.log(
    `[main] loaded ${snapshot.clients.length} clients in ${snapshot.durationMs}ms` +
      (errs.length ? `, ${errs.length} failed` : '') +
      (snapshot.vault.available ? `, vault matched ${snapshot.vault.matched}/${snapshot.vault.scanned}` : ''),
  );
  for (const p of snapshot.problems) {
    for (const i of p.issues) {
      console[i.severity === 'error' ? 'error' : 'warn'](`[data] ${p.id}: ${i.field}: ${i.message}`);
    }
  }
  refreshTrayMenu();
  pushState();
}

async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const before = settings;
  settings = { ...settings, ...patch };

  /*
   * The write moved to the END of this function on purpose.
   *
   * It used to be the first thing that happened, so a layer mode that then
   * failed to apply was already on disk, and restarting the app replayed the
   * failure instead of escaping it. settings.json now mirrors state the wall
   * has verified, never state that was merely requested.
   */

  if (patch.startWithWindows !== undefined) applyStartup();
  if (patch.performance !== undefined) capability = detectCapability(settings.performance);

  const needsRewatch =
    patch.clientsDir !== undefined || patch.vaultPath !== undefined || patch.useVault !== undefined;
  if (needsRewatch) {
    stopWatching?.();
    startWatching();
    await reloadData();
  }

  let failure: string | undefined;
  if (patch.monitors !== undefined) rebuildWindows();
  else {
    for (const w of windows) {
      const outcome = applyLayer(w);
      if (!outcome.ok && failure === undefined) failure = outcome.reason ?? 'unknown';
    }
  }

  // A layer mode that cannot verify never becomes the persisted mode. Revert in
  // memory first, re-apply the mode that was working, and only then let the
  // write at the end of this function record it.
  if (patch.layerMode !== undefined && failure !== undefined) {
    console.warn(`[main] layer mode '${settings.layerMode}' rejected (${failure}); staying on '${before.layerMode}'`);
    settings = { ...settings, layerMode: before.layerMode };
    for (const w of windows) applyLayer(w);
    tray?.displayBalloon?.({
      title: 'Layer mode not applied',
      content: `${settings.layerMode} kept: the requested mode could not be verified (${failure})`,
    });
  } else if (before.layerMode !== settings.layerMode) {
    console.log(`[main] layer mode -> ${settings.layerMode}`);
  }

  if (patch.hotkeyFocus !== undefined || patch.hotkeyToggle !== undefined) registerHotkeys();

  await saveSettings(settings).catch((err) => console.error('[settings] save failed:', err));

  refreshTrayMenu();
  pushState();
}

// ── Modes ──────────────────────────────────────────────────────────────────

function toggleFocusMode(): void {
  focusMode = !focusMode;
  // applyLayer owns setIgnoreMouseEvents now, so there is no second call here
  // to drift out of step with it.
  for (const w of windows) applyLayer(w);
  refreshTrayMenu();
  pushState();
}

function toggleHidden(): void {
  hidden = !hidden;
  for (const w of windows) {
    if (w.win.isDestroyed()) continue;
    if (hidden) w.win.hide();
    else w.win.showInactive();
  }
  refreshTrayMenu();
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const bind = (accel: string, fn: () => void, label: string) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) console.warn(`[hotkey] ${label} '${accel}' already in use`);
    } catch (err) {
      console.warn(`[hotkey] ${label} '${accel}' invalid: ${(err as Error).message}`);
    }
  };
  bind(settings.hotkeyFocus, toggleFocusMode, 'focus');
  bind(settings.hotkeyToggle, toggleHidden, 'toggle');
}

/**
 * Startup registration.
 *
 * Uses Electron's setLoginItemSettings, which writes the HKCU Run key. That is
 * per-user, needs no elevation, and is trivially inspectable and removable,
 * unlike a scheduled task. openAsHidden keeps the launch quiet.
 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/*
 * Per EDITION, not per app. Both builds shared one value name, so launching the
 * stats build with its own settings (startWithWindows off by default) deleted
 * the full build's login entry. Two products that install side by side must not
 * share a single registry value.
 */
const RUN_VALUE = isStatsOnly ? 'ClaudeStatsWall' : 'MuchBetterClientWall';

/**
 * Register (or clear) the launch-at-login entry by writing HKCU\...\Run directly.
 *
 * We do NOT use app.setLoginItemSettings(). It silently does nothing on this
 * machine: it neither throws nor registers, and getLoginItemSettings() keeps
 * reporting openAtLogin false. The cause is visible in what it reports for
 * OTHER apps' existing entries, where an unquoted Run value under a profile
 * path containing spaces comes back split, e.g. path "C:\\Users\\HP" with args
 * ["865", "G10\\AppData\\..."]. Electron's Windows implementation is not
 * space-safe, and this user profile has spaces in it.
 *
 * Writing the key ourselves is also just more honest: it is one value a person
 * can see in regedit or Task Manager's Startup tab and delete by hand.
 *
 * Skipped in development, where registering the dev Electron binary to launch
 * at login would be actively unhelpful.
 */
function applyStartup(): void {
  if (process.platform !== 'win32') return;

  if (!app.isPackaged) {
    if (settings.startWithWindows) {
      console.log('[startup] skipped: only a packaged build registers itself at login');
    }
    return;
  }

  // Quoted so a path with spaces survives; the wall's own path certainly has them.
  const command = `"${process.execPath}" --wall-autostart`;
  const args = settings.startWithWindows
    ? ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f']
    : ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'];

  execFile('reg.exe', args, (err, _stdout, stderr) => {
    if (err) {
      // Deleting an entry that is not there is a normal no-op, not a failure.
      if (!settings.startWithWindows && /unable to find|cannot find/i.test(stderr || '')) return;
      console.error(`[startup] reg ${args[0]} failed: ${(stderr || err.message).trim()}`);
      return;
    }
    console.log(
      settings.startWithWindows
        ? `[startup] registered at login: ${command}`
        : '[startup] login entry removed',
    );
  });
}

function startWatching(): void {
  stopWatching = watchClients(
    { clientsDir: resolveClientsDir(), vaultPath: settings.vaultPath, useVault: settings.useVault },
    (snap) => {
      snapshot = snap;
      const failed = snap.problems.filter((p) => p.issues.some((i) => i.severity === 'error'));
      console.log(
        `[main] data changed, ${snap.clients.length} clients` +
          (failed.length ? `, ${failed.length} failed` : ''),
      );
      // Log problems on reload too. Without this, a client that breaks after a
      // hot edit disappears from the count with no explanation in the log.
      for (const p of failed) {
        for (const i of p.issues.filter((x) => x.severity === 'error')) {
          console.error(`[data] ${p.id}: ${i.field}: ${i.message}`);
        }
      }
      refreshTrayMenu();
      pushState();
    },
  );
}

function quit(): void {
  stopUpdater();
  projection.stopProjection();
  if (usageTimer) clearTimeout(usageTimer);
  usageWatcher?.close();
  // Persist whatever the periodic save has not yet flushed.
  void saveIndex(usageCacheFile(), usage).catch(() => undefined);
  for (const w of windows) if (w.hwnd) detach(w.hwnd);
  stopWatching?.();
  globalShortcut.unregisterAll();
  tray?.destroy();
  app.quit();
}

// ── IPC ────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle('wall:getState', (event) => {
    const wall = windows.find((w) => w.win.webContents.id === event.sender.id);
    return wall ? wallState(wall) : null;
  });
  ipcMain.handle('wall:updateSettings', (_e, patch: Partial<Settings>) => updateSettings(patch ?? {}));
  ipcMain.handle('wall:reload', () => reloadData());
  ipcMain.handle('wall:getUsage', () => usageForRenderer());
  ipcMain.handle('wall:setMode', (_e, mode: 'stats' | 'clients') =>
    // There is only one view in the shareable build, so a stale settings file
    // or a stray renderer message can never strand it on an empty client wall.
    updateSettings({ mode: !isStatsOnly && mode === 'clients' ? 'clients' : 'stats' }),
  );
  ipcMain.handle('wall:toggleFocus', () => {
    toggleFocusMode();
  });
  // The renderer sends this on Escape. Leaving focus mode must always be
  // possible without hunting for the tray.
  ipcMain.handle('wall:exitFocus', () => {
    if (focusMode) toggleFocusMode();
  });
  ipcMain.handle('pair:mode', () => pairMode);
  ipcMain.handle('pair:status', () => projection.projectionStatus());
  ipcMain.handle('pair:newCode', () => projection.beginPairing());
  ipcMain.handle('pair:cancelCode', () => projection.cancelPairing());
  ipcMain.handle('pair:redeem', (_e, code: string) => projection.redeemCode(String(code ?? '')));
  ipcMain.handle('pair:revoke', (_e, screenId: string) => projection.revokeScreen(String(screenId ?? '')));
  ipcMain.handle('pair:copy', (_e, text: string) => {
    const { clipboard } = require('electron') as typeof import('electron');
    clipboard.writeText(String(text ?? ''));
  });
  ipcMain.handle('pair:close', () => {
    if (pairWindow && !pairWindow.isDestroyed()) pairWindow.close();
  });

  ipcMain.handle('wall:openExternal', (_e, url: string) => {
    // Only ever open http(s). Client JSON is hand-edited and untrusted.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────

/*
 * Chromium switches, applied before ready.
 *
 * The wall is a always-on display of local content, so a lot of what Chromium
 * budgets memory for is dead weight here: multiple renderers, site isolation
 * across origins, background networking, component updates. Trimming these is
 * the difference between a browser that happens to show cards and a widget.
 *
 * NOT trimmed: CalculateNativeWinOcclusion, which is what lets Chromium stop
 * painting the wall while it is covered by other windows. That is the single
 * biggest idle-CPU win and must stay on.
 */
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=128');
app.commandLine.appendSwitch('renderer-process-limit', '1');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-breakpad');
/*
 * Give the stats edition its own identity BEFORE anything asks for a path.
 *
 * electron-builder writes the repo's package.json into both editions' asar, so
 * both reported productName "MuchBetter Client Wall" and therefore resolved to
 * the SAME userData folder and the same single-instance lock. Two consequences,
 * both bad: the shareable build read the full build's settings and client data
 * folder, and the second edition to launch exited with "another instance is
 * already running" on any machine running both, which is exactly the projection
 * setup.
 *
 * setName must run before app is ready and before any getPath('userData'), so
 * it lives here at module scope rather than in a start function.
 */
if (isStatsOnly) app.setName(PRODUCT_NAME);

app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider');
// We load only local files over our own protocol, never remote origins, so
// per-site renderer processes buy nothing and cost a process each.
app.commandLine.appendSwitch('disable-site-isolation-trials');

if (!app.requestSingleInstanceLock()) {
  // Another instance already owns the lock, which is keyed on userData, so a
  // packaged install and a dev run collide. Say so: exiting silently with code
  // 0 looks exactly like a crash and wasted real debugging time.
  console.log('[main] another instance is already running, exiting');
  app.quit();
} else {
  // Must happen before any window exists.
  ensureDpiAwareness();

  app.on('second-instance', () => {
    if (hidden) toggleHidden();
  });

  app.whenReady().then(async () => {
    settings = await loadSettings();
    if (isStatsOnly && settings.mode !== 'stats') settings = { ...settings, mode: 'stats' };
    console.log(`[main] userData: ${app.getPath('userData')}`);
    console.log(`[main] clients dir: ${resolveClientsDir()}`);
    capability = detectCapability(settings.performance);
    console.log(`[main] capability tier '${capability.tier}': ${capability.reasons.join('; ')}`);
    if (!win32Available()) console.warn(`[main] Win32 layer unavailable: ${unavailableReason()}`);

    registerAssetProtocol();
    registerIpc();
    await seedUserData();
    // No client store and no Obsidian bridge in the shareable build. This is
    // not just a hidden view: nothing is read from disk, so the app cannot
    // touch a vault or a client folder it has no business touching.
    if (!isStatsOnly) await reloadData();

    /*
     * Load the cached usage index first so the dashboard has real numbers on
     * screen immediately, then refresh in the background. A cold index is
     * several seconds of parsing and must never gate the window appearing.
     */
    /*
     * Projection starts BEFORE the indexer, because its role decides whether
     * there is any point indexing at all: a screen shows another machine's
     * numbers and must not read its own transcripts while paired.
     */
    await projection.startProjection({
      onStatus: () => {
        refreshTrayMenu();
        pushPairStatus();
        pushState();

        /*
         * UNCONDITIONAL, and that matters.
         *
         * This was gated on `isScreen()`, which is false at exactly the moment
         * it needs to be true: unpairing nulls the screen BEFORE it publishes
         * the "off" status, so the one push that would have cleared the wall
         * never happened. A machine that had been a screen went on showing
         * "LIVE from <source>" at full brightness for ever, with numbers that
         * had stopped arriving. Status changes are rare; an extra push is free.
         */
        pushUsage();

        /*
         * Coming back from being a screen, this machine has not indexed its own
         * transcripts since it was paired, so `usage` is whatever was cached at
         * startup. Start reading again rather than leaving old numbers up.
         */
        if (projection.projectionStatus().role === 'off' && !usageWatcher && !isDev) {
          console.log('[usage] projection off, resuming local indexing');
          void refreshUsage('projection-off').then(startUsageWatch);
        }
      },
      onUsage: () => pushUsage(),
      notify: (title, content) => {
        console.log(`[projection] ${title}: ${content}`);
        tray?.displayBalloon?.({ title, content });
      },
    });

    usage = await loadIndex(usageCacheFile());
    if (projection.isScreen()) {
      console.log('[usage] not indexing: this machine is a projection screen');
    } else {
      void refreshUsage('startup').then(startUsageWatch);
    }
    if (!isStatsOnly) startWatching();

    windows = targetDisplays().map(createWindowForDisplay);
    buildTray();
    // After the tray, so a state change has a menu to refresh.
    startUpdater(() => refreshTrayMenu());
    registerHotkeys();
    applyStartup();

    // Displays changing is one of the few things that genuinely disturbs both
    // window geometry and z-order, so rebuild rather than patch.
    const onDisplayChange = () => {
      console.log('[main] display configuration changed, rebuilding windows');
      rebuildWindows();
    };
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);
    screen.on('display-metrics-changed', onDisplayChange);
  });

  app.on('window-all-closed', () => {
    // The wall lives in the tray. Closing windows must not quit the app.
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
