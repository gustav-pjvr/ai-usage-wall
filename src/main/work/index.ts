/**
 * Work mode's main-process wiring (docs/work-mode.md): the monday sync, the
 * notices, the IPC, the Connect dialog and the tray items.
 *
 * FULL BUILD ONLY. src/main/index.ts reaches this file through a require()
 * inside `if (!isStatsOnly)`, which esbuild drops from the stats bundle along
 * with everything this file imports, so the stats edition contains no Work
 * IPC, no monday code and no token handling at all (test/work.test.mjs builds
 * it and checks).
 *
 * THE TOKEN
 *   - Typed once into the Connect dialog, sent to main on submit, checked
 *     against monday (`me` must be Gustav), stored with DPAPI
 *     (monday-token.ts), and never sent to any renderer again.
 *   - Never logged, never in settings, never in a payload, status, failure,
 *     notice or projection frame. Disconnect deletes the file.
 */

import { app, BrowserWindow, ipcMain, net, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  GUSTAV_ID, PRIORITIES, isTaskUrl, taskUrl,
  type ActionResult, type TaskAction, type TaskPriority, type TaskStatus, type WorkPayload,
} from '../../shared/work-view';
import { createMondayClient } from './monday';
import { createMondayToken, deleteMondayToken, loadMondayToken, MondayError, saveMondayToken, type MondayFetch } from './monday-token';
import { cleanNotifierState, createWorkNotifier, emptyNotifierState, type NotifierState, type WorkNotice } from './notify';
import { createWorkSync } from './sync';

export interface WorkHost {
  isDev: boolean;
  /** The live wall windows. */
  walls(): BrowserWindow[];
  /** True when this machine is a paired projection screen: Work is never shown there. */
  isScreen(): boolean;
  focusMode(): boolean;
  /** Switch the wall's view (through updateSettings, so it persists and every window follows). */
  setMode(mode: 'stats' | 'work'): void;
  /** Show the wall if it was hidden. */
  showWall(): void;
  /** Borrow or return keyboard focus for a text box in a wall window (docs/notes-bar.md). */
  lendFocus(event: IpcMainInvokeEvent, active: boolean): boolean;
  refreshTray(): void;
  balloon(title: string, content: string): void;
  /** The shared toast window, resized for a work notice and taking clicks; release gives it back. */
  /**
   * The shared toast window, resized for a work notice and taking clicks. `ready`
   * runs when the window is this notice's (at once, or after a chat notice that
   * is up has had its time; null when there is no window); release gives it back.
   */
  toast: { show(width: number, height: number, ready: (win: BrowserWindow | null) => void): void; release(): void };
  /** The clock, for tests; Date.now otherwise. */
  now?: () => number;
  /** Per monday request, for tests; 20 s otherwise (monday-token.ts). */
  timeoutMs?: number;
  /** How long the toast's Done may wait for monday before it says so, for tests; 30 s otherwise. */
  doneLimitMs?: number;
  /** How long a work notice stays up, for tests; NOTICE_MS otherwise. */
  noticeMs?: number;
}

const STATUSES: readonly TaskStatus[] = ['Not started', 'In progress', 'Waiting', 'Done', 'Dropped'];
const ITEM = /^\d{1,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOTICE_MS = 6000;
const NOTICE_W = 340;
const NOTICE_H = 150;
const TICK_MS = 60_000;

/** A renderer's action request, checked field by field. Anything else is refused. */
function parseAction(raw: unknown): TaskAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { kind?: unknown; value?: unknown };
  if (r.kind === 'status' && STATUSES.includes(r.value as TaskStatus)) return { kind: 'status', value: r.value as TaskStatus };
  if (r.kind === 'priority' && PRIORITIES.includes(r.value as TaskPriority)) return { kind: 'priority', value: r.value as TaskPriority };
  if (r.kind === 'due' && (r.value === null || (typeof r.value === 'string' && DATE.test(r.value)))) return { kind: 'due', value: r.value as string | null };
  if (r.kind === 'comment' && typeof r.value === 'string' && r.value.trim() && r.value.length <= 10_000) return { kind: 'comment', value: r.value };
  return null;
}

/** Where the notice state lives: seen event keys, the held count and the last summary day. Never a token. */
const noticeFile = (): string => path.join(app.getPath('userData'), 'work-notices.json');

function loadNoticeState(): NotifierState {
  try {
    const text = readFileSync(noticeFile(), 'utf8');
    return cleanNotifierState(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch {
    return emptyNotifierState();
  }
}

let saving: Promise<void> = Promise.resolve();
function saveNoticeState(state: NotifierState): void {
  // Serialised and atomic, like settings: a crash cannot truncate it.
  saving = saving.then(async () => {
    const target = noticeFile();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(`${target}.tmp`, JSON.stringify(state), 'utf8');
    await fs.rename(`${target}.tmp`, target);
  }).catch((err: unknown) => console.warn('[work] could not save notice state:', (err as NodeJS.ErrnoException)?.code ?? 'error'));
}

export function createWork(host: WorkHost) {
  const now = host.now ?? Date.now;
  const mondayFetch: MondayFetch = (url, init) => net.fetch(url, init) as ReturnType<MondayFetch>;

  // ── Notices ─────────────────────────────────────────────────────────────

  let notice: { id: number; n: WorkNotice; busy: boolean } | null = null;
  let noticeTimer: NodeJS.Timeout | null = null;
  let noticeSeq = 0;
  let toastWin: BrowserWindow | null = null;
  /**
   * Notices waiting for the window (a chat notice is up, or a Done is in
   * flight). ONE notice, collapsed with a running count: however many arrive,
   * the queue cannot grow.
   */
  let queued: WorkNotice | null = null;
  /** The window was asked for and has not been handed over yet. */
  let waitingForWindow = false;

  function endNotice(): void {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    if (!notice) return;
    notice = null;
    toastWin = null;
    host.toast.release();
    const next = queued;
    queued = null;
    if (next) showNotice(next);
  }

  /** Two notices as one: a burst with the sum of their counts, Show on the newer task. */
  function merge(a: WorkNotice | null, b: WorkNotice): WorkNotice {
    if (!a) return b;
    const count = a.count + b.count;
    return {
      ...b, kind: 'burst', count, canDone: false,
      label: `monday · ${count} task updates`,
      from: a.from === b.from ? b.from : `${b.from} and others`,
      taskId: b.taskId ?? a.taskId,
    };
  }

  function armNoticeTimer(ms: number): void {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(endNotice, ms);
    noticeTimer.unref?.();
  }

  function showNotice(n: WorkNotice): void {
    if (host.focusMode() || host.isScreen()) return;
    // A Done in flight owns the window until it reports, and a window not yet
    // handed over is not ours: either way a newer change waits, collapsed.
    if (notice?.busy || waitingForWindow) {
      queued = merge(queued, n);
      return;
    }
    if (notice && toastWin) {
      // A burst collapses into the notice already up, with a running count.
      present(merge(notice.n, n), toastWin);
      return;
    }
    waitingForWindow = true;
    queued = merge(queued, n);
    host.toast.show(NOTICE_W, NOTICE_H, (win) => {
      waitingForWindow = false;
      const next = queued;
      queued = null;
      if (!win || !next) {
        if (win) host.toast.release();
        return;
      }
      present(next, win);
    });
  }

  function present(next: WorkNotice, win: BrowserWindow): void {
    toastWin = win;
    notice = { id: ++noticeSeq, n: next, busy: false };
    // Main keeps the task id. The toast only ever learns the notice id and the words.
    const words = {
      id: notice.id, label: next.label, from: next.from, title: next.title, count: next.count,
      canDone: next.canDone && next.taskId !== null,
    };
    // A toast window created just now has no listener yet: a message sent before
    // its page loads is dropped, so the very first notice waits for the load.
    const send = (): void => {
      if (!win.isDestroyed() && notice?.id === words.id) win.webContents.send('toast:work', words);
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
    armNoticeTimer(host.noticeMs ?? NOTICE_MS);
  }

  const notifier = createWorkNotifier({
    now,
    focus: () => host.focusMode(),
    state: loadNoticeState(),
    save: saveNoticeState,
    show: showNotice,
    me: GUSTAV_ID,
  });

  // ── Sync ────────────────────────────────────────────────────────────────

  let lastConnected = false;
  let lastRefused = false;
  const pushAll = (channel: string, value: unknown): void => {
    if (host.isScreen()) return;
    for (const w of host.walls()) if (!w.isDestroyed()) w.webContents.send(channel, value);
  };

  const sync = createWorkSync({
    loadToken: loadMondayToken,
    makeClient: (token) => createMondayClient({ fetch: mondayFetch, token, now, ...(host.timeoutMs ? { timeoutMs: host.timeoutMs } : {}) }),
    // A paired screen shows no Work, so it does not ask monday for anything.
    paused: () => host.isScreen(),
    now,
    onChange: (payload: WorkPayload) => {
      pushAll('work:update', payload);
      // The tray follows the token: Connect, Disconnect, and Reconnect while monday refuses it.
      const refused = payload.status.problem === 'auth';
      if (payload.status.connected !== lastConnected || refused !== lastRefused) {
        lastConnected = payload.status.connected;
        lastRefused = refused;
        host.refreshTray();
      }
      if (payload.tasks && !host.isScreen()) notifier.tick(payload.tasks);
    },
    onEvents: (events) => {
      if (!host.isScreen()) notifier.events(events);
    },
    log: (line) => console.log(line),
    me: GUSTAV_ID,
  });

  const tick = setInterval(() => {
    if (!host.isScreen()) notifier.tick(sync.current());
  }, TICK_MS);
  tick.unref?.();

  // ── Connect dialog ──────────────────────────────────────────────────────

  let connectWin: BrowserWindow | null = null;

  function openConnect(): void {
    if (connectWin && !connectWin.isDestroyed()) {
      connectWin.show();
      connectWin.focus();
      return;
    }
    connectWin = new BrowserWindow({
      width: 460,
      height: 500,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Connect monday',
      backgroundColor: '#26262b',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        devTools: host.isDev,
      },
    });
    connectWin.setMenu(null);
    // A window a secret is typed into goes nowhere else.
    connectWin.webContents.on('will-navigate', (e) => e.preventDefault());
    connectWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void connectWin.loadFile(path.join(__dirname, '..', 'renderer', 'connect.html'));
    connectWin.on('closed', () => {
      connectWin = null;
    });
  }

  async function disconnect(): Promise<void> {
    try {
      await deleteMondayToken();
      sync.disconnect();
      host.refreshTray();
      host.balloon('monday disconnected', 'The token was deleted from this PC.');
      console.log('[work] monday disconnected, token deleted');
    } catch {
      host.balloon('monday not disconnected', 'The token file could not be deleted.');
    }
  }

  /** Check a pasted token with monday, then store it. The reply never contains it. */
  async function submitToken(raw: unknown): Promise<{ ok: boolean; message: string }> {
    const token = typeof raw === 'string' ? raw.trim() : '';
    let credential;
    try {
      credential = createMondayToken(token);
    } catch {
      return { ok: false, message: 'That does not look like a monday token. Paste the whole token, with no spaces.' };
    }
    try {
      const who = await createMondayClient({ fetch: mondayFetch, token: credential }).whoAmI();
      if (who !== GUSTAV_ID) return { ok: false, message: 'That token belongs to another monday user. Use your own personal token.' };
    } catch (error) {
      const kind = error instanceof MondayError ? error.kind : 'server';
      const message = kind === 'auth' ? 'monday did not accept that token. Copy it again and paste it here.'
        : kind === 'offline' ? 'Could not reach monday. Check the connection and try again.'
          : kind === 'rate' ? 'monday is rate limiting right now. Try again in a minute.'
            : 'monday could not check the token right now. Try again shortly.';
      return { ok: false, message };
    }
    try {
      await saveMondayToken(token);
    } catch {
      return { ok: false, message: 'The token could not be stored securely on this PC, so it was not saved.' };
    }
    console.log('[work] monday connected');
    void sync.connect(credential);
    host.refreshTray();
    return { ok: true, message: 'Connected.' };
  }

  // ── IPC ─────────────────────────────────────────────────────────────────

  const fromWall = (e: { sender: WebContents }): boolean =>
    host.walls().some((w) => !w.isDestroyed() && w.webContents.id === e.sender.id);
  const fromConnect = (e: { sender: WebContents }): boolean =>
    !!connectWin && !connectWin.isDestroyed() && e.sender.id === connectWin.webContents.id;
  const fromToast = (e: { sender: WebContents }): boolean =>
    !!toastWin && !toastWin.isDestroyed() && e.sender.id === toastWin.webContents.id;
  const refused = { ok: false, message: 'Not available here.' } as const;

  // null until the stored token has been looked at: the wall shows loading, never a false "not connected".
  ipcMain.handle('work:get', (e) => (fromWall(e) && !host.isScreen() && sync.known() ? sync.payload() : null));
  ipcMain.handle('work:focus', (e, active: unknown) => (fromWall(e) ? host.lendFocus(e, active === true) : false));
  ipcMain.handle('work:connect', (e) => {
    if (fromWall(e) && !host.isScreen()) openConnect();
  });
  ipcMain.handle('work:open', async (e, id: unknown) => {
    if (!fromWall(e)) return false;
    const url = taskUrl(id);
    if (!url || !isTaskUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('work:action', (e, id: unknown, raw: unknown) => {
    if (!fromWall(e) || host.isScreen()) return refused;
    const action = parseAction(raw);
    if (typeof id !== 'string' || !ITEM.test(id) || !action) return { ok: false, message: 'That change is not one the wall can make.' };
    return sync.act((c) => {
      switch (action.kind) {
        case 'status': return c.setStatus(id, action.value);
        case 'priority': return c.setPriority(id, action.value);
        case 'due': return c.setDue(id, action.value);
        case 'comment': return c.addComment(id, action.value);
      }
    });
  });
  ipcMain.handle('work:create', (e, raw: unknown) => {
    if (!fromWall(e) || host.isScreen()) return refused;
    const r = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; priority?: unknown; due?: unknown };
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name || Array.from(name).length > 500) return { ok: false, message: 'A task needs a name, up to 500 characters.' };
    if (r.priority !== undefined && r.priority !== null && !PRIORITIES.includes(r.priority as TaskPriority)) return { ok: false, message: 'That priority is not one the Tasks board uses.' };
    if (r.due !== undefined && r.due !== null && (typeof r.due !== 'string' || !DATE.test(r.due))) return { ok: false, message: 'That date is not a real calendar date.' };
    const input: { name: string; priority?: TaskPriority; due?: string } = { name };
    if (typeof r.priority === 'string') input.priority = r.priority as TaskPriority;
    if (typeof r.due === 'string') input.due = r.due;
    return sync.act((c) => c.createTask(input));
  });

  ipcMain.handle('connect:submit', (e, token: unknown) => (fromConnect(e) ? submitToken(token) : refused));
  ipcMain.handle('connect:close', (e) => {
    if (fromConnect(e) && connectWin && !connectWin.isDestroyed()) connectWin.close();
  });

  ipcMain.handle('toast:workAction', async (e, id: unknown, action: unknown) => {
    if (!fromToast(e) || !notice || notice.id !== id) return { ok: false, message: 'That notice has gone.' };
    const current = notice;
    const taskId = current.n.taskId;
    if (action === 'later') {
      endNotice();
      return { ok: true, message: '' };
    }
    if (action === 'show') {
      endNotice();
      if (host.isScreen()) return refused;
      host.setMode('work');
      host.showWall();
      if (taskId) pushAll('work:highlight', taskId);
      return { ok: true, message: '' };
    }
    if (action === 'done' && current.n.canDone && taskId && !current.busy) {
      current.busy = true;
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = null;
      /*
       * Every request ends within its timeout, but a status change is up to
       * five of them: the toast says so after doneLimitMs rather than sit on
       * "Marking done..." for minutes. The change may still land; the board
       * shows the truth on its next read.
       */
      let limit: NodeJS.Timeout | undefined;
      const late = new Promise<ActionResult>((resolve) => {
        limit = setTimeout(() => resolve({ ok: false, message: 'monday has not answered yet. Check the task on monday before trying again.' }), host.doneLimitMs ?? 30_000);
        limit.unref?.();
      });
      const result = await Promise.race([sync.act((c) => c.setStatus(taskId, 'Done')), late]);
      clearTimeout(limit);
      if (result.ok) pushAll('work:card', result.card);
      if (notice === current) {
        current.busy = false;
        armNoticeTimer(result.ok ? Math.min(1800, host.noticeMs ?? 1800) : (host.noticeMs ?? NOTICE_MS));
      }
      return result.ok ? { ok: true, message: 'Marked done.' } : { ok: false, message: result.message };
    }
    return { ok: false, message: 'That is not something this notice can do.' };
  });

  return {
    start(): void {
      void sync.start();
    },

    /** Fetch the board now instead of at the next poll. */
    refresh: (): Promise<void> => sync.refresh('manual'),

    /** Tray items, full build only. */
    trayItems(mode: 'stats' | 'work'): MenuItemConstructorOptions[] {
      const screen = host.isScreen();
      const { connected, problem } = sync.payload().status;
      // monday refused the stored token (polling has stopped): offer a new one, which replaces it on success.
      const reconnect: MenuItemConstructorOptions[] = connected && problem === 'auth'
        ? [{ label: 'Reconnect monday...', enabled: !screen, click: () => openConnect() }]
        : [];
      return [
        {
          label: 'View',
          submenu: [
            { label: 'Claude Stats', type: 'radio', checked: mode === 'stats', click: () => host.setMode('stats') },
            {
              label: screen ? 'Work  (not on a paired screen)' : 'Work',
              type: 'radio', checked: mode === 'work', enabled: !screen,
              click: () => host.setMode('work'),
            },
          ],
        },
        ...reconnect,
        connected
          ? { label: 'Disconnect monday', click: () => void disconnect() }
          : { label: 'Connect monday...', enabled: !screen, click: () => openConnect() },
      ];
    },

    stop(): void {
      sync.stop();
      clearInterval(tick);
      if (noticeTimer) clearTimeout(noticeTimer);
      if (connectWin && !connectWin.isDestroyed()) connectWin.destroy();
    },

    /** Whether a work notice is up, and what waits behind it (one collapsed notice at most). */
    noticeState: (): { up: boolean; busy: boolean; queued: number } =>
      ({ up: notice !== null, busy: notice?.busy === true, queued: queued?.count ?? 0 }),
  };
}

export type WorkController = ReturnType<typeof createWork>;
