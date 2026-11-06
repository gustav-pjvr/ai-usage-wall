/**
 * Work mode: the only shapes the renderer sees, and the pure rules both sides
 * share (docs/work-mode.md). Full build only: nothing in the stats edition
 * imports this file, so none of it ships there.
 *
 * Every string in a TaskCard came from monday and is untrusted. The renderer
 * inserts all of it with textContent.
 */

export type TaskStatus = 'Not started' | 'In progress' | 'Waiting' | 'Done' | 'Dropped';
export type TaskPriority = 'High' | 'Medium' | 'Low';
export type TaskGroup = 'topics' | 'group_mm861qv1' | 'group_mm86nn5y' | 'group_mm86644p';

export interface TaskCard {
  id: string;
  name: string;
  group: TaskGroup;
  status: TaskStatus;
  priority: TaskPriority | null;
  due: string | null;
  ownerIds: string[];
  assignedByIds: string[];
  project: string | null;
  updatedAt: string;
}

export interface TaskColumns {
  inProgress: TaskCard[];
  waiting: TaskCard[];
  backlog: TaskCard[];
  done: TaskCard[];
}

export interface TaskCounts {
  inProgress: number;
  waiting: number;
  backlog: number;
  done: number;
  overdue: number;
  dueThisWeek: number;
  newFromJaco: number;
  doneThisWeek: number;
}

export interface TasksView {
  at: string;
  columns: TaskColumns;
  counts: TaskCounts;
}

export interface TaskEvent {
  id: string;
  kind: 'assigned' | 'moved' | 'commented' | 'leftWaiting';
  taskId: string;
  taskName: string;
  actorId: string;
  at: string;
}

// ── People and the board ──────────────────────────────────────────────────

export const BOARD_ID = '5106174674';
export const GUSTAV_ID = '119615221';
export const JACO_ID = '119615219';

const PEOPLE: Record<string, { name: string; initial: string }> = {
  [GUSTAV_ID]: { name: 'Gustav', initial: 'G' },
  [JACO_ID]: { name: 'Jaco', initial: 'J' },
};

/** A display name for a monday user id. Only the two known people have one. */
export const personName = (id: string): string => PEOPLE[id]?.name ?? 'Someone';
/** One letter for an owner chip; anyone else on the board is a dot, never a guess. */
export const personInitial = (id: string): string => PEOPLE[id]?.initial ?? '·';

const ITEM_ID = /^\d{1,30}$/;
const TASK_URL = /^https:\/\/pickleplaysouthafrica-squad\.monday\.com\/boards\/5106174674\/pulses\/\d{1,30}$/;

/** The item's page on monday, or null for anything that is not a plain item id. */
export function taskUrl(id: unknown): string | null {
  if (typeof id !== 'string' || !ITEM_ID.test(id)) return null;
  const url = `https://pickleplaysouthafrica-squad.monday.com/boards/${BOARD_ID}/pulses/${id}`;
  return TASK_URL.test(url) ? url : null;
}

/** True only for an item URL on the Tasks board, exactly as taskUrl builds it. */
export const isTaskUrl = (url: unknown): boolean => typeof url === 'string' && TASK_URL.test(url);

// ── Filters and the summary strip ─────────────────────────────────────────

export type WorkFilter = 'mine' | 'everyone';

/** Mine = Owner includes Gustav. */
export const isMine = (card: TaskCard, me = GUSTAV_ID): boolean => card.ownerIds.includes(me);

/** Jaco gave it to Gustav and Gustav has not started it yet. */
export const isNewFromJaco = (card: TaskCard, me = GUSTAV_ID): boolean =>
  card.status === 'Not started' && card.ownerIds.includes(me) && card.assignedByIds.includes(JACO_ID);

export function filterColumns(columns: TaskColumns, filter: WorkFilter, me = GUSTAV_ID): TaskColumns {
  if (filter === 'everyone') return columns;
  const keep = (list: TaskCard[]) => list.filter((c) => isMine(c, me));
  return { inProgress: keep(columns.inProgress), waiting: keep(columns.waiting), backlog: keep(columns.backlog), done: keep(columns.done) };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The LOCAL calendar day of an instant, YYYY-MM-DD. The one helper all Work
 * day math goes through (summary, overdue, notices): a due date on monday is a
 * calendar date, so "today" is Gustav's today. In UTC, 00:30 in Johannesburg
 * was still yesterday and a task due today read as not due.
 */
export function localDay(ms: number, offsetDays = 0): string {
  const d = new Date(ms);
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Monday of the local week `ms` is in, and the Monday after it, as days. */
function localWeek(ms: number): { start: string; end: string } {
  const back = (new Date(ms).getDay() + 6) % 7;
  return { start: localDay(ms, -back), end: localDay(ms, 7 - back) };
}

/** The summary strip. Every day is a local day (localDay), in main and the renderer alike. */
export function summarize(columns: TaskColumns, at: string, me = GUSTAV_ID): TaskCounts {
  const now = Date.parse(at);
  const today = localDay(now);
  const { start: weekStart, end: weekEnd } = localWeek(now);
  const open = [...columns.inProgress, ...columns.waiting, ...columns.backlog];
  return {
    inProgress: columns.inProgress.length,
    waiting: columns.waiting.length,
    backlog: columns.backlog.length,
    done: columns.done.length,
    overdue: open.filter((c) => c.due !== null && c.due < today).length,
    dueThisWeek: open.filter((c) => c.due !== null && c.due >= today && c.due < weekEnd).length,
    newFromJaco: open.filter((c) => isNewFromJaco(c, me)).length,
    doneThisWeek: columns.done.filter((c) => localDay(Date.parse(c.updatedAt)) >= weekStart).length,
  };
}

/** Overdue on the same rule as the strip, so a red date and the count agree. */
export const isOverdue = (card: TaskCard, at: string): boolean =>
  card.status !== 'Done' && card.status !== 'Dropped' && card.due !== null && card.due < localDay(Date.parse(at));

// ── Sync status ───────────────────────────────────────────────────────────

/** Why the last fetch failed. 'data' is a reply the wall could not read; 'daily' the daily call cap. */
export type SyncProblem = 'auth' | 'offline' | 'rate' | 'daily' | 'server' | 'data';

export interface WorkStatus {
  /** A token is stored. */
  connected: boolean;
  /** A fetch is in flight. */
  syncing: boolean;
  /** The last successful fetch, ISO. */
  syncedAt: string | null;
  /** The last fetch's failure, cleared by the next success. */
  problem: SyncProblem | null;
}

/** Everything the Work view is sent. No token, no activity log, no comment text. */
export interface WorkPayload {
  status: WorkStatus;
  tasks: TasksView | null;
}

const PROBLEM: Record<SyncProblem, string> = {
  auth: 'monday refused the token, use Reconnect monday in the tray',
  offline: 'monday unreachable, check the connection, retrying',
  rate: 'monday rate limited, retrying in a minute',
  daily: 'monday daily API limit reached, syncing resumes after 02:00 SAST',
  server: 'monday had a problem, retrying',
  data: 'monday sent data the wall could not read',
};

/** The failure in plain words, for the status strip and failed actions. */
export const problemText = (p: SyncProblem): string => PROBLEM[p];

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** The status strip's monday line, read off the clock rather than a snapshot. */
export function syncLabel(status: WorkStatus, now: number): { text: string; tone: 'ok' | 'bad' | 'off' } {
  if (!status.connected) return { text: 'monday not connected', tone: 'off' };
  const synced = status.syncedAt ? Date.parse(status.syncedAt) : NaN;
  const since = Number.isFinite(synced) ? `, last synced ${age(now - synced)} ago` : '';
  if (status.problem) return { text: `${PROBLEM[status.problem]}${since}`, tone: 'bad' };
  if (!Number.isFinite(synced)) return { text: 'monday syncing', tone: 'off' };
  return { text: `monday synced ${age(now - synced)} ago`, tone: 'ok' };
}

// ── Actions ───────────────────────────────────────────────────────────────

/** The five places a card can be moved to, with the column label each lands in. */
export const MOVES: readonly { status: TaskStatus; label: string }[] = [
  { status: 'In progress', label: 'In progress' },
  { status: 'Waiting', label: 'Waiting' },
  { status: 'Not started', label: 'Backlog' },
  { status: 'Done', label: 'Done' },
  { status: 'Dropped', label: 'Dropped' },
];

export const PRIORITIES: readonly TaskPriority[] = ['High', 'Medium', 'Low'];

export type TaskAction =
  | { kind: 'status'; value: TaskStatus }
  | { kind: 'priority'; value: TaskPriority }
  | { kind: 'due'; value: string | null }
  | { kind: 'comment'; value: string };

export type ActionResult = { ok: true; card: TaskCard } | { ok: false; message: string };
