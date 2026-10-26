/**
 * Main process. Owns windows, the desktop layer, data loading and hotkeys.
 *
 * One frameless transparent window PER MONITOR, each rendering the slice of the
 * wall for that monitor. One window stretched across the virtual desktop was
 * rejected: it breaks on mixed-DPI setups (Windows scales the whole surface by
 * the primary monitor's factor) and it forces a full repaint of every monitor
 * when one card changes.
 */

import { refreshT3, withT3, type T3Snapshot } from './data/t3-usage';
import { currentPeak, loadPeak, offerPeak } from './data/peak';
import { evaluateMilestones, loadMilestones, markMilestonesSeen, milestonesForRenderer } from './data/milestones';
import { velocityOf } from '../shared/velocity';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, screen, shell, nativeImage, nativeTheme } from 'electron';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { watch as watchFs, type FSWatcher } from 'node:fs';

import { detectCapability, type Capability } from './capability';
import { loadSettings, saveSettings, type Settings, normaliseSettings } from './settings';
import { PRODUCT_NAME, isStatsOnly } from '../shared/edition';
import {
  checkNow,
  installNow,
  startUpdater,
  stopUpdater,
  updateLabel,
  updateState,
  type UpdateState,
} from './updater';
import * as projection from './projection';
import { loadClients, watchClients, type StoreSnapshot } from './data/store';
import {
  PROJECTS_DIR,
  emptyIndex,
  loadIndex,
  refreshIndex,
  saveIndex,
  type FileContribution,
  type IndexProgress,
  type UsageIndex,
} from './data/usage';
import { currentHistory, historyPort, loadHistory } from './data/history';
import { mergeHistory } from '../shared/usage-merge';
import { collectDay, offeredDays, todaySlotsOf } from '../shared/intraday';
import {
  CODEX_SESSIONS_DIR,
  codexHistory,
  createCodexViewKeeper,
  emptyCodexIndex,
  loadCodexIndex,
  refreshCodexIndex,
  saveCodexIndex,
  type CodexContribution,
  type CodexIndex,
} from './data/codex-usage';
import type { CodexView } from '../shared/codex-view';
import { activeTime, type ActiveTime } from '../shared/active-time';
import {
  applyLayerMode,
  detach,
  inputReachesWall,
  ensureDpiAwareness,
  sinkToBottom,
  verifyLayer,
  type LayerMode,
} from './win32/desktop-layer';
import { assessPlacement, placeAboveDesktop } from './win32/desktop-watch';
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
  /**
   * True while the notes bar in this window has an open edit.
   *
   * The wall is `focusable: false` and carries `WS_EX_NOACTIVATE`, which is
   * what lets it sit behind everything without stealing focus, and which also
   * means it can never receive a keystroke. A text input in it would otherwise
   * be exactly the trap the pairing window exists to avoid: the field would
   * paint its editing state, show no caret, and every character typed would go
   * to whatever window was actually active.
   *
   * So an edit borrows focus for its duration and gives it straight back. While
   * this is set, `applyLayer` leaves the window alone, because re-asserting
   * WS_EX_NOACTIVATE mid-edit would take the caret away without telling anyone.
   */
  notesEditing: boolean;
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
let t3Usage: T3Snapshot | undefined;
/*
 * Contributions from a cache of an older INDEX_VERSION, waiting for a refresh
 * with a readable history store to archive the ones whose transcript is gone.
 * Kept until then: dropping them is exactly how 0.9.13 halved the wall.
 */
let staleFiles: Record<string, FileContribution> = {};
let usageWatcher: FSWatcher | null = null;
let usageSweep: NodeJS.Timeout | null = null;
let usageWatchFailures = 0;
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
 * Codex: a second index with its own cache, history store, watch and
 * busy/dirty flags (src/main/data/codex-usage.ts). Nothing here is shared
 * with Claude's state, so a slow or broken Codex read can never hold up or
 * change Claude's numbers.
 */
let codexUsage: CodexIndex = emptyCodexIndex();
let codexStale: Record<string, CodexContribution> = {};
let codexWatcher: FSWatcher | null = null;
let codexSweep: NodeJS.Timeout | null = null;
let codexTimer: NodeJS.Timeout | null = null;
let codexBusy = false;
let codexDirty = false;
let codexLastRun = 0;
let codexLastSave = 0;
const codexViews = createCodexViewKeeper();
/** Whether the last pass found the sessions folder, so its absence is logged once, not every sweep. */
let codexPresent: boolean | null = null;

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
    const port = historyPort();
    // A store unreadable at launch is retried here, never assumed empty.
    if (!port.ready) await loadHistory(app.getPath('userData'));
    const result = await refreshIndex(usage, (p) => pushUsageProgress(p), { history: port, staleFiles });
    usage = result.index;
    t3Usage = await refreshT3(app.getPath('userData'), t3Usage);
    if (port.ready && Object.keys(staleFiles).length) {
      // Settled: archived, or back in the live index. Anything else (locked) waits.
      staleFiles = Object.fromEntries(
        Object.entries(staleFiles).filter(([p]) => !port.has(p) && !usage.files[p]),
      );
    }
    usageIndexing = false;
    if (result.rebuilt) console.log('[usage] a transcript shrank, index rebuilt from scratch');
    /*
     * Offer the reading to the record. A scan runs when a transcript is
     * written, which is exactly when a peak can happen, so sampling here
     * catches bursts without a timer of its own. A rebuild does not reset the
     * record: peak.ts persists separately for precisely that reason.
     */
    if (await offerPeak(velocityOf(usage.recent))) {
      console.log(`[peak] new record: ${Math.round(currentPeak()?.velocity ?? 0).toLocaleString()} tokens/min`);
    }
    /*
     * Milestones, on the COMPLETED index only. refreshIndex has resolved, so
     * this pass is whole; `unavailable` means there is nothing real to judge.
     * A screen never gets here: it does not index while paired.
     */
    // Not while the history store is unread: the merged totals are short by it.
    await evaluateMilestones(
      mergedUsage(),
      !usage.unavailable && !usageIndexing && port.ready,
      Date.now(),
      currentHistory().seed?.createdAt ?? null,
    );
    if (Date.now() - usageLastSave > USAGE_SAVE_INTERVAL_MS) {
      usageLastSave = Date.now();
      await saveIndex(usageCacheFile(), withPending(usage)).catch((err) =>
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
/**
 * How often to scan anyway, whatever the watcher did or did not report.
 *
 * The watcher was the ONLY trigger for a refresh, so a single missed event left
 * the dashboard stale until the next write happened to arrive, with no way to
 * tell that from a genuinely quiet machine. On Windows a recursive fs.watch is
 * ReadDirectoryChangesW, whose buffer drops events under churn rather than
 * queueing them, and the watcher can also die and never come back.
 *
 * This bounds staleness to the interval regardless. It is a safety net and not
 * the mechanism: when the watcher is working, every tick finds a recent scan
 * and does nothing.
 *
 * TO BE CLEAR ABOUT WHAT THIS DOES NOT FIX: a headless `claude -p` run writes
 * its transcript in occasional batches, with gaps over two minutes, so during a
 * background agent's run there is nothing new on disk to find. Measured on
 * 2026-09-04: a five minute run wrote at t+5s, t+2m11s and at exit. Sweeping
 * more often cannot surface work that has not been written. That was very
 * nearly shipped as a fix for exactly that symptom.
 *
 * SIXTY SECONDS, AND WHY NOT LESS. A sweep that finds nothing changed still
 * stats every transcript: measured at 168 to 188 ms across 459 files on this
 * machine, and that grows with the tree. Thirty seconds would spend about 0.6
 * percent of a core forever on a machine doing nothing, which is the wrong
 * trade for a wall that is supposed to be unobtrusive. Sixty halves it, and
 * bounding staleness at a minute is already the difference between a bounded
 * delay and an indefinite one. The cost only lands when the machine is idle:
 * while the watcher is delivering events, every tick sees a recent scan and
 * returns without touching the disk.
 */
const USAGE_SWEEP_MS = 60_000;

function startUsageWatch(): void {
  try {
    usageWatcher = watchFs(PROJECTS_DIR, { recursive: true, persistent: true }, () => {
      // Any event at all is proof the watcher works, so stop counting failures.
      usageWatchFailures = 0;
      if (usageTimer) clearTimeout(usageTimer);
      usageTimer = setTimeout(() => {
        usageTimer = null;
        void refreshUsage('transcript changed');
      }, 900);
    });
    usageWatcher.on('error', (err) => {
      /*
       * This used to log and stop there, which left the app with a dead watcher
       * and no way back short of a restart. Backoff is capped and reset by the
       * first event a new watcher delivers, so a permanently broken watch costs
       * one attempt a minute rather than a restart loop.
       */
      console.warn('[usage] watcher error, will restart:', err.message);
      try {
        usageWatcher?.close();
        if (usageSweep) clearInterval(usageSweep);
        usageSweep = null;
      } catch {
        /* already gone */
      }
      usageWatcher = null;
      const delay = Math.min(60_000, 2000 * 2 ** Math.min(usageWatchFailures++, 5));
      const retry = setTimeout(() => {
        if (!usageWatcher) startUsageWatch();
      }, delay);
      retry.unref?.();
    });
    console.log('[usage] watching', PROJECTS_DIR);
  } catch (err) {
    console.warn('[usage] could not watch transcripts:', (err as Error).message);
  }

  if (!usageSweep) {
    usageSweep = setInterval(() => {
      // Cheap when the watcher is doing its job: this finds a recent scan and
      // returns without touching the disk.
      if (Date.now() - usageLastRun < USAGE_SWEEP_MS) return;
      void refreshUsage('sweep');
    }, USAGE_SWEEP_MS);
    usageSweep.unref?.();
  }
}

// ── Codex usage ────────────────────────────────────────────────────────────

const codexCacheFile = () => path.join(app.getPath('userData'), 'codex-usage-index.json');

/**
 * Refresh the Codex index and push. The same serialising and coalescing as
 * refreshUsage, on flags of its own. A machine with no `~/.codex/sessions`
 * costs one failed access per sweep and says so once.
 */
async function refreshCodex(reason: string): Promise<void> {
  if (codexBusy) {
    codexDirty = true;
    return;
  }
  const since = Date.now() - codexLastRun;
  if (codexLastRun && since < USAGE_MIN_INTERVAL_MS) {
    if (!codexDirty) {
      codexDirty = true;
      setTimeout(() => {
        if (!codexDirty) return;
        codexDirty = false;
        void refreshCodex('coalesced');
      }, USAGE_MIN_INTERVAL_MS - since);
    }
    return;
  }
  codexBusy = true;
  codexLastRun = Date.now();
  try {
    const port = codexHistory.port();
    if (!port.ready) await codexHistory.load(app.getPath('userData'));
    let announced = false;
    const result = await refreshCodexIndex(
      codexUsage,
      (p) => {
        // ANY cold report, the zero-byte one a rebuild opens with included, marks a rebuild.
        codexViews.progress(p);
        if (p.cold && p.bytesTotal > 0 && !announced) {
          announced = true;
          pushUsage();
        }
      },
      { history: port, staleFiles: codexStale, archived: () => codexHistory.current().entries },
    );
    codexUsage = result.index;
    if (port.ready && Object.keys(codexStale).length) {
      codexStale = Object.fromEntries(Object.entries(codexStale).filter(([p]) => !port.has(p) && !codexUsage.files[p]));
    }
    codexViews.settle();
    if (result.rebuilt) console.log('[codex] a rollout shrank or was deleted, index rebuilt');
    const present = !codexUsage.unavailable;
    if (present !== codexPresent) {
      console.log(present ? `[codex] reading ${CODEX_SESSIONS_DIR}` : `[codex] no Codex sessions folder at ${CODEX_SESSIONS_DIR}`);
      codexPresent = present;
    }
    if (present) {
      console.log(`[codex] ${reason}: ${codexUsage.totals.requests.toLocaleString()} responses, scan ${codexUsage.lastScanMs}ms`);
      if (!codexWatcher) startCodexWatch();
    }
    if (Date.now() - codexLastSave > USAGE_SAVE_INTERVAL_MS) {
      codexLastSave = Date.now();
      await saveCodexIndex(codexCacheFile(), withCodexPending(codexUsage)).catch((err) =>
        console.warn('[codex] could not write cache:', (err as Error).message),
      );
    }
    pushUsage();
  } catch (err) {
    codexViews.settle();
    console.error('[codex] refresh failed:', (err as Error).message);
  } finally {
    codexBusy = false;
    if (codexDirty) {
      codexDirty = false;
      void refreshCodex('coalesced');
    }
  }
}

/** The Codex index as saved: with any unsettled stale contributions, so a restart keeps them. */
function withCodexPending(u: CodexIndex): CodexIndex {
  return Object.keys(codexStale).length ? { ...u, pendingStale: codexStale } : u;
}

/**
 * Watch `~/.codex/sessions` recursively, debounced like Claude's. When the
 * folder does not exist there is nothing to watch: the sweep below keeps
 * looking once a minute, and the first pass that finds it starts the watch.
 */
function startCodexWatch(): void {
  if (!codexWatcher) {
    try {
      codexWatcher = watchFs(CODEX_SESSIONS_DIR, { recursive: true, persistent: true }, () => {
        if (codexTimer) clearTimeout(codexTimer);
        codexTimer = setTimeout(() => {
          codexTimer = null;
          void refreshCodex('rollout changed');
        }, 900);
      });
      codexWatcher.on('error', (err) => {
        // Dropped, not retried in a loop: the sweep restarts it on its next pass.
        console.warn('[codex] watcher error, the sweep will restart it:', err.message);
        try {
          codexWatcher?.close();
        } catch {
          /* already gone */
        }
        codexWatcher = null;
      });
    } catch {
      codexWatcher = null; // no folder yet; quiet, the sweep covers it
    }
  }
  if (!codexSweep) {
    codexSweep = setInterval(() => {
      if (Date.now() - codexLastRun < USAGE_SWEEP_MS) return;
      void refreshCodex('sweep');
    }, USAGE_SWEEP_MS);
    codexSweep.unref?.();
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
    /*
     * Clicking the notification acts on it. The balloon is shared with the
     * layer-mode warning, so the update state is what decides, not the click:
     * anything other than a staged update must do nothing rather than restart
     * the wall out from under someone dismissing an unrelated message.
     */
    tray.on('balloon-click', () => {
      if (updateState().phase === 'ready') installNow();
    });
    trayIsDark = taskbarIsDark();
    console.log(`[tray] using the ${trayIsDark ? 'dark' : 'light'} mark`);

    nativeTheme.on('updated', () => syncTrayTheme('app theme event'));
    themeTimer = setInterval(() => syncTrayTheme('poll'), THEME_POLL_MS);
    themeTimer.unref?.();
  } catch (err) {
    console.error('[tray] could not create tray icon:', (err as Error).message);
  }
}

/** Messages, with the unread count when there is one. */
function messagesLabel(): string {
  const n = projection.unreadChat();
  return n > 0 ? `Messages (${n})` : 'Messages...';
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

/*
 * The messages window.
 *
 * Separate from the pairing window on purpose. The pairing panel is asymmetric:
 * the source shows a code there and the screen only ever sees it once, while
 * redeeming. Hanging the conversation off it would have left the receiving
 * machine with no way in. Both roles open this the same way, from the tray.
 *
 * Focusable and normal, for the same reason the pairing window is: the wall's
 * own windows cannot take focus, so a text input in them is a trap.
 */
let chatWindow: BrowserWindow | null = null;

function openChatWindow(): void {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return;
  }
  chatWindow = new BrowserWindow({
    width: 460,
    height: 620,
    minWidth: 340,
    minHeight: 380,
    title: 'Messages',
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
  chatWindow.setMenu(null);
  void chatWindow.loadFile(path.join(__dirname, '..', 'renderer', 'chat.html'));
  chatWindow.on('closed', () => {
    chatWindow = null;
  });
}

/** Nudge the window to reload its threads. Cheap, and it owns the rendering. */
function pushChatChanged(): void {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat:changed');
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
      ...(projection.chatAvailable() ? [{ label: messagesLabel(), click: () => openChatWindow() }] : []),
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
    { label: messagesLabel(), click: () => openChatWindow() },
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

  const wall: WallWindow = {
    win,
    displayId: display.id,
    hwnd: null,
    effectiveMode: settings.layerMode,
    inputReachable: false,
    notesEditing: false,
  };

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

  // Re-assert bottom placement on the one window event that can disturb it.
  // Show Desktop disturbs it with no event at all; startDesktopWatch() covers that.
  win.on('show', () => {
    // effectiveMode, not settings.layerMode: what the window is actually in is
    // what decides whether re-anchoring above Progman is the right move.
    if (!focusMode && wall.effectiveMode === 'desktop' && wall.hwnd) sinkToBottom(wall.hwnd);
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('wall:update', updateState());
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
  // An open notes edit holds focus on purpose. Re-asserting WS_EX_NOACTIVATE
  // here would silently end it, and saving the note calls updateSettings, which
  // calls this for every window, so the edit would kill itself on the way out.
  if (wall.notesEditing) return { ok: true };
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

// ── Update notification ───────────────────────────────────────

/*
 * Two surfaces, because they answer two different questions.
 *
 * The TOAST floats above other applications and answers "is something
 * happening". It appears while a download runs, cannot be focused or clicked,
 * and hides itself once there is nothing to report. It is deliberately not the
 * thing you act on: a window that steals a click while you are working in
 * another app is exactly the behaviour this project keeps refusing to ship.
 *
 * The PILL on the wall answers "do I want this now" and is the only place the
 * install can actually be triggered, so the decision happens on the surface the
 * user chose to look at, in their own time.
 *
 * Both are driven by the same pushUpdate(), so they can never disagree.
 */
let toastWindow: BrowserWindow | null = null;

const TOAST_W = 268;
const TOAST_H = 88;
const TOAST_MARGIN = 18;

function ensureToastWindow(): void {
  if (toastWindow && !toastWindow.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  toastWindow = new BrowserWindow({
    width: TOAST_W,
    height: TOAST_H,
    x: area.x + area.width - TOAST_W - TOAST_MARGIN,
    y: area.y + area.height - TOAST_H - TOAST_MARGIN,
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
    // Keeps it out of Alt+Tab, same reasoning as the wall.
    type: 'toolbar',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: isDev,
    },
  });
  toastWindow.setMenu(null);
  // Above other apps, but never taking a click away from them.
  toastWindow.setAlwaysOnTop(true, 'screen-saver');
  toastWindow.setIgnoreMouseEvents(true);
  toastWindow.on('closed', () => {
    toastWindow = null;
  });
  void toastWindow.loadFile(path.join(__dirname, '..', 'renderer', 'toast.html'));
}

/**
 * How long the "ready" toast stays up before it withdraws.
 *
 * It has to withdraw. 'ready' persists until the user installs, which may be
 * days, and a panel that floats above every other window for days is not a
 * notification, it is a nuisance. The Install pill on the wall is the part that
 * is meant to persist, because the wall is a surface you choose to look at.
 */
const TOAST_READY_LINGER_MS = 9_000;
let toastLinger: NodeJS.Timeout | null = null;

function hideToast(): void {
  if (toastLinger) {
    clearTimeout(toastLinger);
    toastLinger = null;
  }
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.hide();
}

/** Show the toast only while there is something in flight worth showing. */
function syncToast(u: UpdateState): void {
  // A notice has the window for its two seconds. The timer calls back here
  // afterwards, so nothing is lost by waiting.
  if (noticeTimer) return;
  const wanted = u.phase === 'downloading' || u.phase === 'ready';
  if (!wanted) {
    hideToast();
    return;
  }
  ensureToastWindow();
  if (!toastWindow || toastWindow.isDestroyed()) return;
  if (!toastWindow.isVisible()) toastWindow.showInactive();
  toastWindow.webContents.send('wall:update', u);

  if (u.phase === 'ready') {
    // Announce once, then withdraw and leave the pill to it.
    if (!toastLinger) toastLinger = setTimeout(hideToast, TOAST_READY_LINGER_MS);
  } else if (toastLinger) {
    // A download that started again outranks a pending withdrawal.
    clearTimeout(toastLinger);
    toastLinger = null;
  }
}

/*
 * Message arrival notices, shown in the same window as the download toast.
 *
 * One always-on-top window rather than two: a second would have to negotiate
 * position with this one and could overlap it. A notice takes the window for
 * two seconds and then hands it back to whatever the updater was showing, so a
 * download in progress reappears rather than being cancelled by a message.
 *
 * The notice carries a name and a count and NEVER the message text. It floats
 * above other applications, so its content is readable by anyone glancing at
 * the screen, and the point of the channel is that the words are private.
 */
const NOTICE_MS = 2000;
let noticeTimer: NodeJS.Timeout | null = null;
let noticeCount = 0;
let noticeFrom = '';

function notifyMessage(label: string): void {
  /*
   * Nothing to announce if the conversation is already on screen and in front
   * of you. A popup telling you about a message you are watching arrive is
   * noise, and this window is the one surface that interrupts.
   */
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible() && chatWindow.isFocused()) return;

  // A burst is one notice with a count, not a stack of them fighting for the
  // same corner.
  noticeCount = noticeFrom === label ? noticeCount + 1 : 1;
  noticeFrom = label;

  ensureToastWindow();
  if (!toastWindow || toastWindow.isDestroyed()) return;
  if (!toastWindow.isVisible()) toastWindow.showInactive();
  toastWindow.webContents.send('wall:notice', { from: label, count: noticeCount });

  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    noticeCount = 0;
    noticeFrom = '';
    // Hand the window back to the updater, which hides it if it has nothing.
    syncToast(updateState());
  }, NOTICE_MS);
  noticeTimer.unref?.();
}

/** One push, every surface. Safe to call on every state change. */
function pushUpdate(): void {
  const u = updateState();
  for (const w of windows) {
    if (!w.win.isDestroyed()) w.win.webContents.send('wall:update', u);
  }
  syncToast(u);
}

// ── Show Desktop watchdog ──────────────────────────────────────

/*
 * Show Desktop (the strip at the far right of the taskbar, or Win+D) does not
 * touch the wall: it is a tool window with no minimise box, and on the machine
 * where this was measured it stayed visible, placed and non-iconic through both
 * MinimizeAll and ToggleDesktop. What moves is the DESKTOP. The shell puts it
 * above the windows that did not minimise, the wall included, and the wall is
 * then behind the wallpaper until the show-desktop state ends.
 *
 * Gustav found it on a second machine and pinned the mechanism without a
 * debugger: the wall comes back only when you open an app and then minimise it,
 * which is exactly the gesture that cancels the show-desktop state, and the
 * tray icon never goes away. A painting fault would have been cured by any
 * repaint; only that one state transition cures this.
 *
 * The wall gets no window message for that, so it polls. Each tick walks the
 * Z order DOWN from the wall to the desktop host, one or two steps when all is
 * well, and acts on exactly two findings:
 *
 *   - the host is not below the wall: it has been raised over it. Put the wall
 *     directly above wherever the host is now.
 *   - an ordinary visible window sits between the wall and the host: the wall
 *     is above an app, which desktop mode never wants. Same placement, which
 *     drops the wall back under that app.
 *
 * Edge-triggered: a situation is acted on once, keyed by what was seen. If the
 * placement did not take, the same situation is not retried every tick, and a
 * legitimately odd shell layout costs one SetWindowPos, not a fight. Focus
 * mode, a non-desktop layer mode and a hidden wall are skipped outright, so the
 * Control+Alt+W hotkey never has to compete with this.
 */
const DESKTOP_WATCH_MS = 250;
let desktopWatch: NodeJS.Timeout | null = null;
/** Per wall HWND: the last placement signature seen, acted on or not. */
const desktopWatchSeen = new Map<number, string>();

function watchDesktopOnce(): void {
  if (focusMode || hidden) {
    desktopWatchSeen.clear();
    return;
  }
  const own = new Set<number>();
  for (const w of windows) if (w.hwnd) own.add(w.hwnd);
  for (const key of desktopWatchSeen.keys()) if (!own.has(key)) desktopWatchSeen.delete(key);

  for (const wall of windows) {
    if (!wall.hwnd || wall.effectiveMode !== 'desktop' || wall.win.isDestroyed()) continue;
    try {
      const seen = assessPlacement(wall.hwnd, own);
      if (!seen) continue;
      const wrong = seen.desktopAbove || seen.between.length > 0;
      if (!wrong || desktopWatchSeen.get(wall.hwnd) === seen.signature) {
        desktopWatchSeen.set(wall.hwnd, seen.signature);
        continue;
      }
      const ok = placeAboveDesktop(wall.hwnd, seen.host);
      console.log(
        `[desktop-watch] ${
          seen.desktopAbove
            ? 'desktop was above the wall'
            : `${seen.between.length} window(s) between the wall and the desktop`
        }; re-placed above ${seen.hostClass} ${ok ? 'ok' : 'FAILED'}`,
      );
      const after = assessPlacement(wall.hwnd, own);
      desktopWatchSeen.set(wall.hwnd, after?.signature ?? seen.signature);
    } catch (err) {
      console.warn('[desktop-watch] check failed:', (err as Error).message);
    }
  }
}

function startDesktopWatch(): void {
  if (!win32Available() || desktopWatch) return;
  desktopWatch = setInterval(watchDesktopOnce, DESKTOP_WATCH_MS);
  desktopWatch.unref?.();
}

function stopDesktopWatch(): void {
  if (desktopWatch) clearInterval(desktopWatch);
  desktopWatch = null;
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

/** The index as saved: with any unsettled stale contributions, so a restart keeps them. */
function withPending(u: UsageIndex): UsageIndex {
  return Object.keys(staleFiles).length ? { ...u, pendingStale: staleFiles } : u;
}

/**
 * The live index plus the history store: what every consumer reads.
 *
 * `usage` itself stays live only, because refreshIndex updates it in place and
 * history merged into it would be counted again on the next pass. The merge is
 * a few thousand keys, cheap next to a push, so it is recomputed rather than
 * cached and can never be stale.
 */
function mergedUsage() {
  return withT3(mergeHistory(usage, currentHistory()), currentHistory(), historyPort().ready ? t3Usage : undefined, staleFiles);
}

/**
 * The renderer never reads the per-file offset map, and that map is half the
 * payload: 170 KB was crossing the IPC boundary on every refresh, roughly once
 * a second during an active session. Send a projection instead.
 */
/**
 * Hours Claude has run, from every live and archived transcript's stretches of
 * work (src/shared/active-time.ts). A merge of a few thousand stretches, done
 * once per push rather than kept, so it can never be stale.
 */
function activeTimeNow(): ActiveTime {
  return activeTime(mergedUsage().files, currentHistory().entries);
}

/**
 * Codex for the renderer and the projector (src/shared/codex-view.ts): the
 * live index merged with its own history store. Null (and so absent from the
 * payload) when this machine has no Codex response on record, which keeps a
 * wall without Codex exactly as it was. Never on a screen: it does not index.
 */
function codexNow(): CodexView | null {
  if (projection.isScreen()) return null;
  return codexViews.view(codexUsage, codexHistory.current().entries);
}

/**
 * Claude's tokens per five-minute slot of today, the simple view's lane. Not
 * while a cold index or a rebuild is running (rule 15): the day is partial, or
 * a file is for a moment in both the index and history.
 */
function claudeTodaySlots(merged: ReturnType<typeof mergedUsage>): number[] | null {
  if (usageIndexing || usage.unavailable) return null;
  return todaySlotsOf(merged.files, currentHistory().entries);
}

function usageForRenderer(merged = mergedUsage(), active = activeTimeNow(), codex = codexNow()): Record<string, unknown> {
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
  const { files, pendingStale: _pending, ...rest } = merged;
  void _pending;
  const todaySlots = claudeTodaySlots(merged);
  return {
    ...rest,
    ...(codex ? { codex } : {}),
    ...(todaySlots ? { todaySlots } : {}),
    peak: currentPeak(),
    // This machine's own ledger. A screen has none: it is not indexing, and the
    // paired machine's milestones are not projected.
    milestones: milestonesForRenderer(merged, usageIndexing),
    activeTime: active,
    // Transcripts on disk. Archived ones are counted in `history`, never here.
    fileCount: Object.keys(files).filter((p) => !p.startsWith('t3:')).length,
    indexing: usageIndexing,
    projection: projection.projectionStatus(),
  };
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
  const merged = mergedUsage();
  const active = activeTimeNow();
  const codex = codexNow();
  // The wire builds its optional `codex` block from this, masking projects
  // like Claude's (src/shared/projection-wire.ts).
  projection.offerUsage({ ...merged, activeTime: active, ...(codex ? { codex } : {}) }, usageIndexing);
  const payload = usageForRenderer(merged, active, codex);
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
  /*
   * Normalised here, not only in saveSettings.
   *
   * The in-memory object is what `wallState()` pushes to every renderer, so an
   * unnormalised patch reached the UI even though it could never reach disk.
   * `{ notes: 12345 }` would throw inside the notes bar on the first push and
   * take the whole render with it, on every window, until a restart. Only the
   * app's own IPC can produce a patch today, so this is depth rather than a
   * live hole, but the cost of closing it is one function call.
   */
  settings = normaliseSettings({ ...settings, ...patch });

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
  stopDesktopWatch();
  if (toastLinger) clearTimeout(toastLinger);
  if (noticeTimer) clearTimeout(noticeTimer);
  if (toastWindow && !toastWindow.isDestroyed()) toastWindow.destroy();
  projection.stopProjection();
  if (usageTimer) clearTimeout(usageTimer);
  usageWatcher?.close();
  // Persist whatever the periodic save has not yet flushed.
  void saveIndex(usageCacheFile(), withPending(usage)).catch(() => undefined);
  if (codexTimer) clearTimeout(codexTimer);
  codexWatcher?.close();
  if (codexSweep) clearInterval(codexSweep);
  // Only once something was read: an empty index must not overwrite a good cache.
  if (codexLastRun) void saveCodexIndex(codexCacheFile(), withCodexPending(codexUsage)).catch(() => undefined);
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

  /*
   * Lend the wall keyboard focus for the length of a notes edit.
   *
   * `setFocusable(true)` is what actually clears WS_EX_NOACTIVATE; without it
   * the field would take DOM focus, paint the editing state, and route every
   * keystroke to whichever application was really in front. Giving it back runs
   * applyLayer again, which re-asserts the ex-styles and the z-order anchor, so
   * the window returns to being the thing that never steals focus.
   */
  ipcMain.handle('wall:notesEdit', (event, active: boolean) => {
    const wall = windows.find((w) => w.win.webContents.id === event.sender.id);
    if (!wall || wall.win.isDestroyed()) return false;
    if (active) {
      wall.notesEditing = true;
      wall.win.setFocusable(true);
      wall.win.focus();
      return wall.win.isFocused();
    }
    wall.notesEditing = false;
    wall.win.setFocusable(false);
    applyLayer(wall);
    return false;
  });
  ipcMain.handle('wall:reload', () => reloadData());
  ipcMain.handle('wall:getUsage', () => usageForRenderer());
  ipcMain.handle('wall:setMode', (_e, mode: 'stats' | 'clients') =>
    // There is only one view in the shareable build, so a stale settings file
    // or a stray renderer message can never strand it on an empty client wall.
    updateSettings({ mode: !isStatsOnly && mode === 'clients' ? 'clients' : 'stats' }),
  );
  /*
   * Opening the milestone list clears the badge. The ledger is the authority,
   * so the renderer only learns it is cleared from the next push.
   */
  ipcMain.handle('wall:milestonesSeen', async () => {
    if (await markMilestonesSeen()) pushUsage();
  });

  /*
   * The time-lapse, on demand only. Five-minute detail never rides on a usage
   * push: a year of it is about half a megabyte, and pushes were already cut
   * from 170 KB for being too big. One day is under 20 KB and asked for when a
   * day is picked. Refused (null) while indexing, when a day is not complete
   * yet (rule 15), and on a paired screen, which has none of this machine's
   * detail (docs/privacy-wire.md).
   */
  const timelapseReady = (): boolean => !usageIndexing && !usage.unavailable && !projection.isScreen();
  ipcMain.handle('wall:timelapseDays', () =>
    timelapseReady() ? offeredDays(mergedUsage().activeDays, mergedUsage().files, currentHistory().entries) : null,
  );
  ipcMain.handle('wall:timelapseDay', (_e, day: unknown) => {
    if (!timelapseReady() || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    try {
      return collectDay(day, mergedUsage().files, currentHistory().entries, mergedUsage().activeDays[day] ?? 0, Date.now());
    } catch (err) {
      // Only a broken live/archived invariant throws. Say so in the log; the
      // renderer shows "Could not read that day" rather than a wrong curve.
      console.error(`[timelapse] could not read ${day}:`, err);
      throw err;
    }
  });

  ipcMain.handle('wall:installUpdate', () => {
    // Guarded on state, not on the caller: the pill is only rendered when an
    // update is staged, but a stale renderer must not be able to quit the app.
    if (updateState().phase === 'ready') installNow();
  });

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

  // ── Messages ─────────────────────────────────────────────────────────────

  /*
   * One preload serves every window, so `chat` is reachable from the wall and
   * the pairing window too. Only the messages window has any business calling
   * these, and checking the sender costs one comparison. It is defence in depth
   * rather than a known hole: exploiting it would need a renderer compromise
   * first, and every window runs with contextIsolation on and no innerHTML.
   */
  const fromChatWindow = (e: { sender: Electron.WebContents }): boolean =>
    !!chatWindow && !chatWindow.isDestroyed() && e.sender.id === chatWindow.webContents.id;

  ipcMain.handle('chat:load', (e) => (fromChatWindow(e) ? projection.chatThreads() : { threads: [], role: 'off', reachable: [] }));
  ipcMain.handle('chat:send', (e, peerId: string, text: string) => {
    if (!fromChatWindow(e)) return { ok: false, delivered: false };
    const r = projection.sendChat(String(peerId ?? ''), text);
    // The tray label carries the unread count, and sending can clear it.
    refreshTrayMenu();
    return r;
  });
  ipcMain.handle('chat:markRead', (e, peerId: string) => {
    if (!fromChatWindow(e)) return;
    projection.markChatRead(String(peerId ?? ''));
    refreshTrayMenu();
  });
  ipcMain.handle('chat:close', (e) => {
    if (fromChatWindow(e) && chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
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
    /*
     * A message that arrives while the window is shut is not announced with a
     * balloon. The tray label carries the count, and this app has one standing
     * rule about interrupting: it does not, unless the user asked to be
     * interrupted. A chat message from your own other machine is not that.
     */
    projection.setChatListener((_peerId, label) => {
      pushChatChanged();
      refreshTrayMenu();
      notifyMessage(label);
      console.log(`[chat] message from ${label}`);
    });

    await projection.startProjection({
      onStatus: () => {
        refreshTrayMenu();
        pushPairStatus();
        pushChatChanged();
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
          void refreshCodex('projection-off').then(startCodexWatch);
        }
      },
      onUsage: () => pushUsage(),
      notify: (title, content) => {
        console.log(`[projection] ${title}: ${content}`);
        tray?.displayBalloon?.({ title, content });
      },
    });

    // History before the index: the first refresh must be able to archive.
    await loadHistory(app.getPath('userData'));
    ({ index: usage, staleFiles } = await loadIndex(usageCacheFile()));
    // Codex the same way, from its own files: its history store, then its cache.
    await codexHistory.load(app.getPath('userData'));
    ({ index: codexUsage, staleFiles: codexStale } = await loadCodexIndex(codexCacheFile()));
    await loadPeak(app.getPath('userData'));
    await loadMilestones(app.getPath('userData'));
    if (projection.isScreen()) {
      console.log('[usage] not indexing: this machine is a projection screen');
    } else {
      void refreshUsage('startup').then(startUsageWatch);
      void refreshCodex('startup').then(startCodexWatch);
    }
    if (!isStatsOnly) startWatching();

    windows = targetDisplays().map(createWindowForDisplay);
    startDesktopWatch();
    buildTray();
    // After the tray, so a state change has a menu to refresh.
    startUpdater(
      () => {
        refreshTrayMenu();
        pushUpdate();
        // The tooltip is the one update surface visible without opening a menu.
        const u = updateState();
        if (tray && !tray.isDestroyed()) {
          tray.setToolTip(u.phase === 'ready' ? `${PRODUCT_NAME}  ·  update ready, restart to install` : PRODUCT_NAME);
        }
      },
      (title, content) => tray?.displayBalloon?.({ title, content }),
    );
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
