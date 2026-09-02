/**
 * Main process. Owns windows, the desktop layer, data loading and hotkeys.
 *
 * One frameless transparent window PER MONITOR, each rendering the slice of the
 * wall for that monitor. One window stretched across the virtual desktop was
 * rejected: it breaks on mixed-DPI setups (Windows scales the whole surface by
 * the primary monitor's factor) and it forces a full repaint of every monitor
 * when one card changes.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, screen, shell, nativeImage } from 'electron';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

import { detectCapability, type Capability } from './capability';
import { loadSettings, saveSettings, type Settings } from './settings';
import { loadClients, watchClients, type StoreSnapshot } from './data/store';
import {
  applyLayerMode,
  detach,
  ensureDpiAwareness,
  sinkToBottom,
  type LayerMode,
} from './win32/desktop-layer';
import { hwndFromBuffer, isAvailable as win32Available, unavailableReason } from './win32/ffi';

const isDev = !app.isPackaged;

interface WallWindow {
  win: BrowserWindow;
  displayId: number;
  hwnd: number | null;
  /** The mode actually in force, which may differ from the requested one. */
  effectiveMode: LayerMode;
}

let windows: WallWindow[] = [];
let tray: Tray | null = null;
let settings: Settings;
let capability: Capability;
let snapshot: StoreSnapshot | null = null;
let stopWatching: (() => void) | null = null;
let focusMode = false;
let hidden = false;

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

function trayIcon(): Electron.NativeImage {
  /*
   * tray.png is 16px and Electron picks up tray@2x.png automatically for HiDPI
   * displays via the @2x naming convention, so this one path covers both.
   * The tray art is the simplified four-tile variant: the plated mark is
   * illegible at 16px, which is the whole reason two variants exist.
   */
  const file = path.join(bundledRoot(), 'assets', 'tray.png');
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
    tray.setToolTip('MuchBetter Client Wall');
    refreshTrayMenu();
    tray.on('double-click', () => toggleFocusMode());
  } catch (err) {
    console.error('[tray] could not create tray icon:', (err as Error).message);
  }
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
      { label: `MuchBetter Client Wall  (${snapshot?.clients.length ?? 0} clients)`, enabled: false },
      { type: 'separator' },
      { label: hidden ? 'Show wall' : 'Hide wall', click: () => toggleHidden() },
      { label: focusMode ? 'Leave focus mode' : 'Focus mode', click: () => toggleFocusMode() },
      { type: 'separator' },
      {
        label: 'Desktop layer',
        submenu: [
          layerItem('desktop', 'Behind apps, interactive  (recommended)'),
          layerItem('wallpaper', 'Wallpaper layer, no input'),
          layerItem('top', 'Always on top'),
        ],
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
      { label: 'Reload clients', click: () => void reloadData() },
      { label: 'Open client data folder', click: () => void shell.openPath(resolveClientsDir()) },
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

  const wall: WallWindow = { win, displayId: display.id, hwnd: null, effectiveMode: settings.layerMode };

  win.once('ready-to-show', () => {
    win.showInactive();
    try {
      wall.hwnd = hwndFromBuffer(win.getNativeWindowHandle());
    } catch (err) {
      console.error('[main] could not read HWND:', (err as Error).message);
    }
    applyLayer(wall);
    pushState(wall);
    maybeCapture(wall);
  });

  // Re-assert bottom placement only on the events that can disturb it.
  win.on('show', () => {
    if (!focusMode && settings.layerMode === 'desktop' && wall.hwnd) sinkToBottom(wall.hwnd);
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

function applyLayer(wall: WallWindow): void {
  if (!wall.hwnd) return;
  const mode: LayerMode = focusMode ? 'top' : settings.layerMode;
  const display = screen.getAllDisplays().find((d) => d.id === wall.displayId);

  // WorkerW parenting needs physical pixels, not DIPs.
  const bounds =
    display && mode === 'wallpaper'
      ? {
          x: Math.round(display.bounds.x * display.scaleFactor),
          y: Math.round(display.bounds.y * display.scaleFactor),
          width: Math.round(display.bounds.width * display.scaleFactor),
          height: Math.round(display.bounds.height * display.scaleFactor),
        }
      : undefined;

  let result = applyLayerMode(wall.hwnd, mode, bounds);

  // Wallpaper mode depends on Explorer exposing a WorkerW, which not every
  // shell configuration does. Falling back to the bottom-most desktop layer
  // keeps the wall visible and interactive rather than leaving a blank desktop.
  if (!result.ok && mode === 'wallpaper') {
    console.warn(`[main] wallpaper layer unavailable (${result.reason}); falling back to 'desktop'`);
    result = applyLayerMode(wall.hwnd, 'desktop');
    if (result.ok) wall.effectiveMode = 'desktop';
  } else if (result.ok) {
    wall.effectiveMode = mode;
  }

  if (!result.ok) console.warn(`[main] layer mode '${mode}' failed: ${result.reason}`);

  // In wallpaper mode the desktop owns input, so mouse handling is moot.
  const ignore = settings.clickThrough || mode === 'wallpaper';
  wall.win.setIgnoreMouseEvents(ignore, { forward: true });
  wall.win.setOpacity(focusMode ? 1 : settings.opacity);
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
    effectiveLayerMode: wall.effectiveMode,
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
  await saveSettings(settings).catch((err) => console.error('[settings] save failed:', err));

  if (patch.startWithWindows !== undefined) applyStartup();
  if (patch.performance !== undefined) capability = detectCapability(settings.performance);

  const needsRewatch =
    patch.clientsDir !== undefined || patch.vaultPath !== undefined || patch.useVault !== undefined;
  if (needsRewatch) {
    stopWatching?.();
    startWatching();
    await reloadData();
  }

  if (patch.monitors !== undefined) rebuildWindows();
  else {
    for (const w of windows) applyLayer(w);
  }

  if (patch.hotkeyFocus !== undefined || patch.hotkeyToggle !== undefined) registerHotkeys();
  if (before.layerMode !== settings.layerMode) console.log(`[main] layer mode -> ${settings.layerMode}`);

  refreshTrayMenu();
  pushState();
}

// ── Modes ──────────────────────────────────────────────────────────────────

function toggleFocusMode(): void {
  focusMode = !focusMode;
  for (const w of windows) {
    applyLayer(w);
    // Focus mode is the only state where the wall accepts real interaction.
    w.win.setIgnoreMouseEvents(focusMode ? false : settings.clickThrough || settings.layerMode === 'wallpaper', {
      forward: true,
    });
  }
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
function applyStartup(): void {
  try {
    // openAsHidden is macOS-only. On Windows the wall is inherently quiet at
    // startup: it has no taskbar button and never takes focus.
    app.setLoginItemSettings({
      openAtLogin: settings.startWithWindows,
      args: ['--wall-autostart'],
    });
  } catch (err) {
    console.error('[startup] could not update login item:', (err as Error).message);
  }
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
  ipcMain.handle('wall:toggleFocus', () => {
    toggleFocusMode();
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
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider');
// We load only local files over our own protocol, never remote origins, so
// per-site renderer processes buy nothing and cost a process each.
app.commandLine.appendSwitch('disable-site-isolation-trials');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Must happen before any window exists.
  ensureDpiAwareness();

  app.on('second-instance', () => {
    if (hidden) toggleHidden();
  });

  app.whenReady().then(async () => {
    settings = await loadSettings();
    console.log(`[main] userData: ${app.getPath('userData')}`);
    console.log(`[main] clients dir: ${resolveClientsDir()}`);
    capability = detectCapability(settings.performance);
    console.log(`[main] capability tier '${capability.tier}': ${capability.reasons.join('; ')}`);
    if (!win32Available()) console.warn(`[main] Win32 layer unavailable: ${unavailableReason()}`);

    registerAssetProtocol();
    registerIpc();
    await seedUserData();
    await reloadData();
    startWatching();

    windows = targetDisplays().map(createWindowForDisplay);
    buildTray();
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
