/**
 * Work sync: keeps one copy of the Tasks board in the main process and says
 * what changed (docs/work-mode.md, "Sync").
 *
 *   - One light request per tick: the activity log since the last poll, the
 *     board's latest comments, and the complexity left. The items are read
 *     again only when the log shows a change, after an action, and every
 *     10 minutes as a safety net (that read rides on the tick's own request).
 *   - A tick every 60 s on weekdays 07:30 to 18:00 (local), every 15 minutes
 *     otherwise, waking at 07:30: 684 requests on a weekday with no changes,
 *     inside monday's 1,000-call daily cap with room for actions.
 *   - The daily cap reached: say so, with the reset (00:00 UTC, 02:00 SAST),
 *     and stop until then. The token refused: stop until it is reconnected.
 *     A paired projection screen does not poll at all.
 *   - Actions run here, never in a renderer, and answer with the read-back
 *     card or a plain failure. A read-back that does not match is a failure.
 *
 * Network only here (through monday.ts); the renderer keeps connect-src 'none'.
 * The token never leaves monday-token.ts's closure: nothing in this file can
 * read it, and no payload, status or failure built here contains it.
 */

import { GUSTAV_ID, type ActionResult, type SyncProblem, type TaskCard, type TaskEvent, type TasksView, type WorkPayload, type WorkStatus } from '../../shared/work-view';
import { diffTasks, NOT_MOVED, type MondayClient } from './monday';
import { MondayError, type MondayToken } from './monday-token';

/** A tick in working hours (weekdays 07:30 to 18:00, local). */
export const WORK_TICK_MS = 60_000;
/** A tick outside them. 5 minutes would be 792 requests a weekday; 15 keeps it at 684. */
export const QUIET_TICK_MS = 15 * 60_000;
/** The items are read again at least this often, even with a silent log. */
export const FULL_EVERY_MS = 10 * 60_000;
export const AFTER_ACTION_MS = 10_000;
/** Kept for compatibility with callers that ask for "the" poll interval. */
export const POLL_MS = WORK_TICK_MS;

/** Weekday 07:30 to 18:00, local time. */
export function workingHours(ms: number): boolean {
  const d = new Date(ms);
  const day = d.getDay();
  const minutes = d.getHours() * 60 + d.getMinutes();
  return day !== 0 && day !== 6 && minutes >= 7 * 60 + 30 && minutes < 18 * 60;
}

/** Milliseconds from `ms` to the next tick: 60 s in working hours, else 15 min or the next 07:30 if sooner. */
export function nextTickIn(ms: number): number {
  if (workingHours(ms)) return WORK_TICK_MS;
  const wake = new Date(ms);
  for (let i = 0; i < 8; i++) {
    const t = new Date(wake.getFullYear(), wake.getMonth(), wake.getDate() + i, 7, 30).getTime();
    if (t > ms && workingHours(t)) return Math.max(1000, Math.min(QUIET_TICK_MS, t - ms));
  }
  return QUIET_TICK_MS;
}

/** The next reset of monday's daily cap: 00:00 UTC, which is 02:00 in Johannesburg. */
export function dailyResetAt(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 1);
}

/** Failures the client throws with fixed text, mapped to words for a person. */
const KNOWN: Record<string, string> = {
  'Monday write verification failed. Refresh the task before retrying.': 'monday did not confirm the change. It may not have been made.',
  'Monday comment verification failed. Refresh the task before retrying.': 'monday did not confirm the comment. It may not have been posted.',
  [NOT_MOVED]: 'The status changed on monday, but the task was not moved to its column. The board is refreshing.',
  'Could not read the Tasks board item.': 'That task is not on the Tasks board any more.',
  'Invalid task status.': 'That status is not one the Tasks board uses.',
  'Invalid task priority.': 'That priority is not one the Tasks board uses.',
  'Invalid monday date.': 'That date is not a real calendar date.',
  'Invalid task comment.': 'A comment needs some text, up to 10,000 characters.',
  'Invalid task name.': 'A task needs a name, up to 500 characters.',
  'Invalid monday ID.': 'That task id is not valid.',
};

const ACTION_PROBLEM: Record<SyncProblem, string> = {
  auth: 'monday refused the token. Use Reconnect monday... in the tray.',
  offline: 'Could not reach monday, or it did not answer in time. Check the connection and try again.',
  rate: 'monday is rate limiting the wall. Try again in a minute.',
  daily: "monday's daily API limit is used up. It resets at 02:00 (SAST).",
  server: 'monday had a problem. Try again shortly.',
  data: 'monday sent a reply the wall could not read.',
};

/** Which bucket a failure belongs in. Only kinds and fixed strings are ever read. */
export function problemOf(error: unknown): SyncProblem {
  return error instanceof MondayError ? error.kind : 'data';
}

/**
 * A failure as words a person can act on. Unknown errors get a generic line:
 * their text is never passed on, because an unexpected error can carry
 * anything, including request text.
 */
export function plainFailure(error: unknown): string {
  if (error instanceof MondayError) return ACTION_PROBLEM[error.kind];
  const message = error instanceof Error ? error.message : '';
  return Object.prototype.hasOwnProperty.call(KNOWN, message) ? KNOWN[message] : 'The change could not be confirmed. Refresh and check it on monday.';
}

export interface WorkSyncDeps {
  loadToken: () => Promise<MondayToken | null>;
  makeClient: (token: MondayToken) => MondayClient;
  now: () => number;
  /** Status or tasks changed: push to the Work view. */
  onChange: (payload: WorkPayload) => void;
  /** A poll after the first found changes by other people. */
  onEvents: (events: TaskEvent[], view: TasksView) => void;
  /** True while monday must not be polled at all (a paired projection screen). */
  paused?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
  me?: string;
}

export function createWorkSync(deps: WorkSyncDeps) {
  const me = deps.me ?? GUSTAV_ID;
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const log = deps.log ?? (() => undefined);
  const paused = deps.paused ?? (() => false);

  let client: MondayClient | null = null;
  let view: TasksView | null = null;
  let status: WorkStatus = { connected: false, syncing: false, syncedAt: null, problem: null };
  let timer: unknown = null;
  let timerDue = 0;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  /** Set by a token refusal or the daily cap: no polling until reconnect, or until this time. */
  let halted: 'auth' | number | null = null;
  /** The next poll reads the items too (after an action, or a write that half happened). */
  let wantFull = false;
  let lastFull = 0;
  /** Whether the stored token has been looked at yet; until then the wall shows loading, not "not connected". */
  let known = false;

  const payload = (): WorkPayload => ({ status: { ...status }, tasks: view });
  const emit = (): void => deps.onChange(payload());

  /** Schedule the next poll in `ms`, unless one is already due sooner. */
  function schedule(ms: number): void {
    if (stopped || !client || halted === 'auth') return;
    const due = deps.now() + ms;
    if (timer !== null && timerDue <= due) return;
    if (timer !== null) clearTimer(timer);
    timerDue = due;
    timer = setTimer(() => {
      timer = null;
      void refresh('timer');
    }, ms);
  }

  function cancelTimer(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  async function run(reason: string): Promise<void> {
    const c = client;
    if (!c) return;
    const at = deps.now();
    if (typeof halted === 'number') {
      if (at < halted) return;
      halted = null;
    }
    if (halted === 'auth' || paused()) return;
    const full = !view || wantFull || at - lastFull >= FULL_EVERY_MS;
    status = { ...status, syncing: true };
    emit();
    try {
      const r = await c.poll(view, { full });
      if (client !== c) return; // disconnected or reconnected meanwhile
      if (r.refetched) {
        lastFull = at;
        wantFull = false;
      }
      const events = diffTasks(view, r.view, me);
      view = r.view;
      status = { connected: true, syncing: false, syncedAt: r.view.at, problem: null };
      emit();
      if (events.length) deps.onEvents(events, r.view);
      // Counts only: never a log entry, a name or a server word.
      log(`[work] poll (${reason}): activity ${r.parsed} of ${r.received} parsed${r.refetched ? ', items read' : ''}, ${events.length} notices${r.budget !== null ? `, budget ${r.budget}` : ''}`);
    } catch (error) {
      if (client !== c) return;
      const problem = problemOf(error);
      status = { ...status, syncing: false, problem };
      if (problem === 'auth') {
        halted = 'auth';
        cancelTimer();
      }
      if (problem === 'daily') halted = dailyResetAt(at);
      emit();
      // The kind only. A message here could be anything an unexpected error carried.
      log(`[work] poll failed (${reason}): ${problem}${problem === 'auth' ? ', polling stopped until monday is reconnected' : problem === 'daily' ? ', polling stopped until 02:00 SAST' : ''}`);
    }
  }

  /** Poll now. Overlapping calls share one poll and queue at most one more. */
  async function refresh(reason: string): Promise<void> {
    if (!client || stopped) return;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await run(reason);
      } while (again && client && !stopped);
    })();
    try {
      await running;
    } finally {
      running = null;
      const at = deps.now();
      if (typeof halted === 'number') {
        cancelTimer();
        schedule(Math.max(1000, halted - at));
      } else schedule(nextTickIn(at));
    }
  }

  function fresh(c: MondayClient): void {
    cancelTimer();
    client = c;
    view = null;
    halted = null;
    wantFull = true;
    lastFull = 0;
  }

  return {
    /** Load the stored token and start polling. A token that cannot be read counts as not connected. */
    async start(): Promise<void> {
      stopped = false;
      let token: MondayToken | null = null;
      try {
        token = await deps.loadToken();
      } catch {
        log('[work] the stored monday token could not be read; connect monday again');
      }
      known = true;
      if (!token) {
        status = { connected: false, syncing: false, syncedAt: null, problem: null };
        emit();
        return;
      }
      fresh(deps.makeClient(token));
      status = { connected: true, syncing: false, syncedAt: null, problem: null };
      await refresh('start');
    },

    /** A token was just saved: forget the old board and start again with it. */
    async connect(token: MondayToken): Promise<void> {
      stopped = false;
      known = true;
      fresh(deps.makeClient(token));
      status = { connected: true, syncing: false, syncedAt: null, problem: null };
      await refresh('connect');
    },

    /** The token was deleted. Nothing about the board is kept. */
    disconnect(): void {
      cancelTimer();
      client = null;
      view = null;
      halted = null;
      status = { connected: false, syncing: false, syncedAt: null, problem: null };
      emit();
    },

    stop(): void {
      stopped = true;
      cancelTimer();
    },

    refresh,
    payload,
    known: (): boolean => known,
    current: (): TasksView | null => view,

    /**
     * Run one write. The result is the card as monday read it back, or a
     * plain failure; either way the board is read again 10 s later (at once
     * when a status changed but the move did not).
     */
    async act(write: (client: MondayClient) => Promise<TaskCard>): Promise<ActionResult> {
      const c = client;
      if (!c) return { ok: false, message: 'monday is not connected. Connect it from the tray.' };
      if (halted === 'auth') return { ok: false, message: ACTION_PROBLEM.auth };
      if (typeof halted === 'number' && deps.now() < halted) return { ok: false, message: ACTION_PROBLEM.daily };
      let soon = AFTER_ACTION_MS;
      try {
        const card = await write(c);
        return { ok: true, card };
      } catch (error) {
        if (error instanceof Error && error.message === NOT_MOVED) soon = 1000;
        const problem = error instanceof MondayError ? error.kind : null;
        if (problem === 'auth') {
          halted = 'auth';
          cancelTimer();
        }
        if (problem === 'daily') halted = dailyResetAt(deps.now());
        log(`[work] action failed: ${problem ?? 'refused'}`);
        return { ok: false, message: plainFailure(error) };
      } finally {
        wantFull = true;
        if (halted === null) schedule(soon);
      }
    },
  };
}

export type WorkSync = ReturnType<typeof createWorkSync>;
