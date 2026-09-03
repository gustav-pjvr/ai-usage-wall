/**
 * Automatic updates for the shareable build.
 *
 * WHY THIS EXISTS NOW, WHEN ARCHITECTURE.md SAYS IT WAS REJECTED
 *
 * It was rejected for a good reason that has since stopped being true. The
 * argument was: electron-updater needs a release feed it can read without a
 * human, this repo is private, so the app would have to ship a GitHub token, a
 * real secret inside a binary handed to strangers. That trade was not worth it.
 *
 * There is now a public download site backed by an R2 bucket. A generic feed on
 * that bucket needs no credential at all: the app fetches a YAML file and an
 * installer over plain HTTPS, exactly as a browser would. The objection is gone
 * and the reason for it is recorded here so nobody re-litigates it from memory.
 *
 * WHAT IT DOES NOT DO
 *
 *  - It never updates the FULL build. That one lives on one machine and is
 *    installed by `npm run deploy`, which is still the only install path for it
 *    (rule 18). Two update mechanisms racing for the same install is exactly
 *    the "multiple installations" problem this project already solved once.
 *  - It never installs behind the user's back while they are looking at the
 *    wall. The download is silent; the install waits for quit.
 *  - It never blocks startup. A failed check is a log line.
 */

import { app, dialog } from 'electron';
import { isStatsOnly, PRODUCT_NAME } from '../shared/edition';

/** Where the feed lives. Public, unauthenticated, same origin as the download page. */
const FEED_URL = 'https://claude-stats-wall.gustavpjvr.workers.dev/updates/';

/** First check after this long, so it never competes with the cold index. */
const FIRST_CHECK_MS = 15_000;
/*
 * Then every minute, at Gustav's request, so a release reaches a running wall
 * in about a minute instead of up to six hours.
 *
 * What this costs, since "will this eat into a limit somewhere" was the actual
 * question: nothing that touches Claude. The feed is Gustav's own Cloudflare
 * Worker in front of an R2 bucket, and a check is one conditional GET of a
 * latest.yml a few hundred bytes long. One install is 1,440 requests a day
 * against a free-plan allowance of 100,000 Worker requests a day and 10 million
 * R2 reads a month, so roughly sixty installs would fit inside the Worker
 * allowance before anything had to change. The installer itself is only fetched
 * when the version actually moves.
 */
const RECHECK_MS = 60_000;

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'none'; checkedAt: number }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string; checkedAt: number };

/**
 * How the user is TOLD, as opposed to how the tray menu is refreshed.
 *
 * The updater checked, downloaded and staged an update entirely correctly and
 * entirely invisibly: the only sign was a label inside a tray menu nobody had a
 * reason to open. An update that installs itself is fine; an update the user
 * cannot know about is not, because "restart when convenient" is their decision
 * to make and they were never offered it.
 */
type Announce = (title: string, body: string) => void;
let tell: Announce = () => {};

let state: UpdateState = { phase: 'idle' };
let timer: NodeJS.Timeout | null = null;
let onChange: (s: UpdateState) => void = () => {};
let installing = false;

export const updateState = (): UpdateState => state;

function set(next: UpdateState): void {
  state = next;
  try {
    onChange(next);
  } catch {
    /* a listener must never break the updater */
  }
}

/**
 * Start checking. Safe to call in any edition: it returns immediately unless
 * this is a packaged stats build.
 */
export function startUpdater(notify: (s: UpdateState) => void, announce?: Announce): void {
  onChange = notify;
  if (announce) tell = announce;

  if (!app.isPackaged) {
    console.log('[update] skipped: development build');
    return;
  }
  if (!isStatsOnly) {
    // The full build is Gustav's, installed by npm run deploy. See rule 18.
    console.log('[update] skipped: the full build updates via npm run deploy');
    return;
  }

  let autoUpdater: typeof import('electron-updater').autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater') as typeof import('electron-updater'));
  } catch (err) {
    console.warn('[update] electron-updater unavailable:', (err as Error).message);
    return;
  }

  autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL });
  autoUpdater.autoDownload = true;
  /*
   * The one thing that must NOT be automatic. Quitting to install without being
   * asked would tear the wall off the screen mid-session, and this app is
   * deliberately something you leave running for weeks.
   */
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[update]', m),
    warn: (m: unknown) => console.warn('[update]', m),
    error: (m: unknown) => console.error('[update]', m),
    debug: () => {},
  } as never;

  autoUpdater.on('checking-for-update', () => set({ phase: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ phase: 'none', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) =>
    set({ phase: 'downloading', version: state.phase === 'downloading' ? state.version : '', percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-available', (info) => {
    console.log(`[update] ${info.version} available, downloading`);
    set({ phase: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[update] ${info.version} ready, will install on quit`);
    set({ phase: 'ready', version: info.version });
    tell(
      `${PRODUCT_NAME} ${info.version} is ready`,
      'It installs when you next quit, or right away from the tray menu.',
    );
  });
  autoUpdater.on('error', (err) => {
    // Offline, a proxy, or a feed that is not there yet. None of these are
    // worth interrupting anyone over, so they are a log line and a tray label.
    console.warn('[update] check failed:', err?.message ?? String(err));
    set({ phase: 'error', message: err?.message ?? 'unknown error', checkedAt: Date.now() });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {
      /* the error event already reported it */
    });
  };

  timer = setTimeout(() => {
    check();
    timer = setInterval(check, RECHECK_MS);
    timer.unref?.();
  }, FIRST_CHECK_MS);
  timer.unref?.();

  console.log(`[update] watching ${FEED_URL}`);
}

/** Tray action: check now, whatever the timer is doing. */
export function checkNow(): void {
  if (!app.isPackaged || !isStatsOnly) {
    set({ phase: 'error', message: 'updates only apply to an installed Claude Stats Wall', checkedAt: Date.now() });
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.checkForUpdates().catch(() => {});
  } catch {
    /* reported by the error handler */
  }
}

/**
 * Tray action: restart into the new version.
 *
 * Asks first. The wall is a thing people leave running, and quitting it without
 * warning to install something is the kind of surprise this project's rules
 * exist to prevent.
 */
export function installNow(): void {
  if (state.phase !== 'ready' || installing) return;
  const version = state.version;

  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Restart and update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: `Update ${PRODUCT_NAME}?`,
    message: `Version ${version} is ready.`,
    detail:
      `${PRODUCT_NAME} will close, install the update and start again. This takes a few seconds.\n\n` +
      'If you would rather not now, it installs by itself the next time you quit.',
  });
  if (choice !== 0) return;

  installing = true;
  try {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    // isSilent: true, isForceRunAfter: true. Nothing to click, comes back up.
    autoUpdater.quitAndInstall(true, true);
  } catch (err) {
    installing = false;
    console.error('[update] could not install:', (err as Error).message);
  }
}

export function stopUpdater(): void {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
}

/** One line for the tray, honest about every state including the boring ones. */
export function updateLabel(): string {
  switch (state.phase) {
    case 'checking':
      return 'Checking for updates...';
    case 'downloading':
      return state.percent > 0
        ? `Downloading update ${state.version} (${state.percent}%)`
        : `Downloading update ${state.version}...`;
    case 'ready':
      return `Update ${state.version} ready, restart to install`;
    case 'none':
      return 'Up to date';
    case 'error':
      return 'Update check failed';
    default:
      return 'Check for updates';
  }
}
