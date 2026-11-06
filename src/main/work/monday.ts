import {
  BOARD_ID, GUSTAV_ID, JACO_ID, summarize,
  type TaskCard, type TaskEvent, type TaskGroup, type TaskPriority, type TaskStatus, type TasksView,
} from '../../shared/work-view';
import { createMondayToken, MondayError, REQUEST_TIMEOUT_MS, classifyFailure, type MondayFetch, type MondayToken } from './monday-token';

const BOARD = BOARD_ID;
const GUSTAV = GUSTAV_ID;
const JACO = JACO_ID;
const DAY = 86_400_000;
/** How far back each poll reaches before the previous one, and how old a change may be and still notify. */
export const OVERLAP_MS = 120_000;
const STATUS = 'color_mm86v4eh';
const OWNER = 'multiple_person_mm86z4cd';
const ASSIGNED = 'multiple_person_mm869xm7';
const PRIORITY = 'color_mm86ddn1';
const DUE = 'date_mm86ewhc';
const PROJECT = 'board_relation_mm86t9nv';
const GROUPS: Record<Exclude<TaskStatus, 'Dropped'>, TaskGroup> = {
  'Not started': 'group_mm86nn5y',
  'In progress': 'topics',
  Waiting: 'group_mm861qv1',
  Done: 'group_mm86644p',
};
const STATUSES: readonly string[] = [...Object.keys(GROUPS), 'Dropped'];
const PRIORITIES: readonly string[] = ['High', 'Medium', 'Low'];
/** Thrown when the Status label changed but the group move did not: the board then differs from the card. */
export const NOT_MOVED = 'Monday status changed but the task was not moved.';
const ITEM_FIELDS = `id name updated_at board { id } group { id }
  column_values(ids: ["${STATUS}", "${OWNER}", "${ASSIGNED}", "${PRIORITY}", "${DUE}", "${PROJECT}"]) {
    id text value ... on BoardRelationValue { display_value }
  }`;
/*
 * One request per tick (docs/work-mode.md, "Sync"). The activity log since
 * the last poll (less two minutes of overlap) says whether anything changed;
 * the last 25 updates on the board are the comments, ids and authors only,
 * never their text; the items come along only on a full refetch.
 *
 * API-Version 2026-10 (monday-token.ts): activity_logs is a flat list here.
 * 2027-01 wraps it in a paginated { logs } object; change both together.
 */
/** The log is read in pages of LOG_PAGE, at most LOG_PAGES of them per poll. */
export const LOG_PAGE = 200;
export const LOG_PAGES = 5;
const LOG_FIELDS = 'id event data user_id created_at';
const TICK_QUERY = `query Tasks($from: ISO8601DateTime!, $items: Boolean!) {
  complexity { before query }
  boards(ids: [${BOARD}]) {
    id
    activity_logs(limit: ${LOG_PAGE}, page: 1, from: $from) { ${LOG_FIELDS} }
    updates(limit: 25) { id created_at item_id creator { id } }
    items_page(limit: 200) @include(if: $items) { cursor items { ${ITEM_FIELDS} } }
  }
}`;
/** The log's further pages, when the first was full. */
const LOGS_QUERY = `query Logs($from: ISO8601DateTime!, $page: Int!) {
  boards(ids: [${BOARD}]) { id activity_logs(limit: ${LOG_PAGE}, page: $page, from: $from) { ${LOG_FIELDS} } }
}`;
const ITEMS_QUERY = `query Items { boards(ids: [${BOARD}]) { id items_page(limit: 200) { cursor items { ${ITEM_FIELDS} } } } }`;
const PAGE_QUERY = `query Page($cursor: String!) { next_items_page(limit: 200, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } } }`;

type ObjectValue = Record<string, unknown>;
/**
 * What a log entry says it changed, read from its own data: the Status label,
 * the Owner or Assigned-by people, or the group of a move. `before` is
 * undefined when the entry does not say. An entry with no readable change
 * (create_pulse, an unknown shape) has change null and is left to the
 * snapshot comparison.
 */
type Change =
  | { column: 'status'; before?: TaskStatus | null; after: TaskStatus | null }
  | { column: 'owner' | 'assigned'; before?: string[]; after: string[] }
  | { column: 'group'; before?: TaskGroup; after: TaskGroup };
interface Activity { id: string; itemId: string; actorId: string; at: string; event: string; columnId: string | null; change: Change | null }
/** A comment, as far as notices need it: who, when, on what. Never its text. */
interface CommentRef { id: string; itemId: string; actorId: string; at: string }
interface Snapshot { items: Map<string, TaskCard>; activities: Activity[]; comments: CommentRef[] }

// Attribution stays in main. Serializing a TasksView never exposes logs or comments.
// diffTasks takes the original poll snapshots, not renderer round-trips.
const snapshots = new WeakMap<TasksView, Snapshot>();

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid monday data.');
  return value as ObjectValue;
}

function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new Error('Invalid monday ID.');
  return value;
}

function string(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new Error('Invalid monday text.');
  return Array.from(value).slice(0, max).join('');
}

function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid monday date.');
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new Error('Invalid monday time.');
  date(value.slice(0, 10));
  return new Date(value).toISOString();
}

function json(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 100_000) throw new Error('Invalid monday value.');
  return JSON.parse(value);
}

function people(value: unknown): string[] {
  const parsed = json(value);
  if (parsed === null) return [];
  const entries = object(parsed).personsAndTeams;
  if (!Array.isArray(entries) || entries.length > 200) throw new Error('Invalid monday people.');
  const result: string[] = [];
  for (const entry of entries) {
    const person = object(entry);
    const personId = id(person.id);
    if (person.kind !== 'person' && person.kind !== 'team') throw new Error('Invalid monday person.');
    if (person.kind === 'person') result.push(personId);
  }
  return [...new Set(result)];
}

/** Collapse runs of whitespace, for comparing what was sent with what monday read back. */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

function parseCommentRef(raw: unknown): CommentRef | null {
  try {
    const r = object(raw);
    return { id: id(r.id), itemId: id(r.item_id), actorId: id(object(r.creator).id), at: timestamp(r.created_at) };
  } catch { return null; }
}

function parseItem(raw: unknown): TaskCard | null {
  try {
    const r = object(raw);
    if (id(object(r.board).id) !== BOARD || !Array.isArray(r.column_values)) return null;
    const columns = new Map<string, ObjectValue>();
    for (const rawColumn of r.column_values) {
      const column = object(rawColumn);
      const key = string(column.id, 100);
      if (columns.has(key)) return null;
      columns.set(key, column);
    }
    const column = (key: string): ObjectValue => object(columns.get(key));
    const group = object(r.group).id;
    const status = column(STATUS).text;
    const priority = column(PRIORITY).text;
    if (!Object.values(GROUPS).includes(group as TaskGroup) || !STATUSES.includes(status as string) ||
        !(priority === null || priority === '' || PRIORITIES.includes(priority as string))) return null;
    const dueValue = json(column(DUE).value);
    const due = dueValue === null ? null : date(object(dueValue).date);
    const projectValue = column(PROJECT).display_value;
    const project = projectValue === null || projectValue === '' ? null : string(projectValue, 500);
    const name = string(r.name, 500);
    if (!name.trim()) return null;
    return {
      id: id(r.id), name, group: group as TaskGroup, status: status as TaskStatus,
      priority: priority ? priority as TaskPriority : null, due,
      ownerIds: people(column(OWNER).value), assignedByIds: people(column(ASSIGNED).value),
      project, updatedAt: timestamp(r.updated_at),
    };
  } catch { return null; }
}

/** An activity log id: monday sends UUID strings (2026-11-06), older logs digits. */
const ACTIVITY_ID = /^[\w-]{1,64}$/;

/** created_at: a 17-digit string of 1e-7 s since the epoch, as monday sends it; ISO accepted too. */
function activityTime(value: unknown): string {
  if (typeof value === 'string' && /^\d{17}$/.test(value)) {
    const at = new Date(Number(BigInt(value) / 10_000n));
    if (!Number.isFinite(at.getTime())) throw new Error('Invalid monday time.');
    return at.toISOString();
  }
  return timestamp(value);
}

/** A value inside a log entry's data: an object, or JSON text of one. undefined when unreadable. */
function loose(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** A Status value ({ label: { text } }); null for an empty one, undefined when not readable. */
function labelOf(value: unknown): TaskStatus | null | undefined {
  const v = loose(value);
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const label = (v as ObjectValue).label;
  const text = label && typeof label === 'object' ? (label as ObjectValue).text : label;
  return typeof text === 'string' && STATUSES.includes(text) ? text as TaskStatus : undefined;
}

/** A people value ({ personsAndTeams }); [] for an empty one, undefined when not readable. */
function peopleOf(value: unknown): string[] | undefined {
  const v = loose(value);
  if (v === null) return [];
  if (!v || typeof v !== 'object') return undefined;
  try { return people(JSON.stringify(v)); } catch { return undefined; }
}

function groupOf(value: unknown): TaskGroup | undefined {
  const g = value && typeof value === 'object' ? (value as ObjectValue).id : undefined;
  return Object.values(GROUPS).includes(g as TaskGroup) ? g as TaskGroup : undefined;
}

function changeOf(event: string, columnId: string | null, data: ObjectValue): Change | null {
  if (event === 'move_pulse_from_group' || event === 'move_pulse_into_group' || event === 'move_item_to_group') {
    const after = groupOf(data.dest_group);
    return after ? { column: 'group', before: groupOf(data.source_group), after } : null;
  }
  if (!('value' in data)) return null;
  if (columnId === STATUS) {
    const after = labelOf(data.value);
    if (after === undefined) return null;
    const before = 'previous_value' in data ? labelOf(data.previous_value) : undefined;
    return { column: 'status', ...(before !== undefined ? { before } : {}), after };
  }
  if (columnId === OWNER || columnId === ASSIGNED) {
    const after = peopleOf(data.value);
    if (after === undefined) return null;
    const before = 'previous_value' in data ? peopleOf(data.previous_value) : undefined;
    return { column: columnId === OWNER ? 'owner' : 'assigned', ...(before !== undefined ? { before } : {}), after };
  }
  return null;
}

function parseActivity(raw: unknown): Activity | null {
  try {
    const r = object(raw);
    if (typeof r.id !== 'string' || !ACTIVITY_ID.test(r.id)) return null;
    const data = object(json(r.data));
    const event = string(r.event, 100);
    const columnId = data.column_id === undefined ? null : string(data.column_id, 100);
    return {
      id: r.id, itemId: id(data.pulse_id ?? data.item_id), actorId: id(r.user_id), at: activityTime(r.created_at),
      event, columnId, change: changeOf(event, columnId, data),
    };
  } catch { return null; }
}

/** Oldest first, by time and then by id as a string (ids are UUIDs, not numbers). */
const byTime = (a: { at: string; id: string }, b: { at: string; id: string }): number =>
  a.at.localeCompare(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function makeView(snapshot: Snapshot, at: string): TasksView {
  const columns: TasksView['columns'] = { inProgress: [], waiting: [], backlog: [], done: [] };
  const time = Date.parse(at);
  for (const card of snapshot.items.values()) {
    if (card.status === 'Dropped') continue;
    if (card.status === 'Done') {
      if (Date.parse(card.updatedAt) >= time - 7 * DAY && Date.parse(card.updatedAt) <= time) columns.done.push(card);
    } else if (card.status === 'Waiting') columns.waiting.push(card);
    else if (card.status === 'In progress') columns.inProgress.push(card);
    else columns.backlog.push(card);
  }
  // Calendar summaries are local days (src/shared/work-view.ts, shared with the renderer).
  const view: TasksView = { at, columns, counts: summarize(columns, at, GUSTAV) };
  snapshots.set(view, snapshot);
  return view;
}

/** What one poll found, for the log (counts only) and the schedule. */
export interface PollResult {
  view: TasksView;
  /** Activity log entries monday returned, and how many of them parsed. */
  received: number;
  parsed: number;
  /** Whether the items were fetched this time (a full refetch, or a change in the log). */
  refetched: boolean;
  /** Complexity budget left before the query, when monday said. */
  budget: number | null;
  /** More than LOG_PAGES full pages: entries beyond them were not read, so the items were read again. */
  truncated: boolean;
}

export function createMondayClient({ fetch, token, now = Date.now, timeoutMs = REQUEST_TIMEOUT_MS }: {
  fetch: MondayFetch;
  token: string | MondayToken;
  now?: () => number;
  /** Per request; every request ends within it (monday-token.ts). */
  timeoutMs?: number;
}) {
  const credential = typeof token === 'string' ? createMondayToken(token) : token;

  async function request(query: string, variables: ObjectValue = {}): Promise<ObjectValue> {
    let result: ObjectValue;
    try {
      result = object(await credential.post(fetch, JSON.stringify({ query, variables }), timeoutMs));
    } catch (error) {
      // GraphQL errors can echo variables or credentials; no server text escapes.
      throw new MondayError(error instanceof MondayError ? error.kind : 'server');
    }
    const failed = (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length > 0)) ||
      result.error_code !== undefined || result.error_message !== undefined;
    if (failed) throw new MondayError(classifyFailure(undefined, result));
    try {
      return object(result.data);
    } catch {
      throw new MondayError('server');
    }
  }

  /** One item, and the ids of its latest updates (for checking a comment landed). */
  async function readItem(itemId: string): Promise<{ card: TaskCard; updateIds: string[] }> {
    const data = await request(`query Task($ids: [ID!]!) { items(ids: $ids) { ${ITEM_FIELDS} updates(limit: 10) { id } } }`, { ids: [id(itemId)] });
    const raw = Array.isArray(data.items) && data.items.length === 1 ? object(data.items[0]) : null;
    const card = raw ? parseItem(raw) : null;
    if (!raw || !card || card.id !== itemId) throw new Error('Could not read the Tasks board item.');
    const updateIds = Array.isArray(raw.updates)
      ? raw.updates.flatMap((u) => { try { return [id(object(u).id)]; } catch { return []; } })
      : [];
    return { card, updateIds };
  }

  function matches(actual: TaskCard, expected: Partial<TaskCard>): TaskCard {
    const differs = Object.entries(expected).some(([key, value]) => key === 'name'
      ? collapse(actual.name) !== collapse(String(value))
      : JSON.stringify(actual[key as keyof TaskCard]) !== JSON.stringify(value));
    if (differs) throw new Error('Monday write verification failed. Refresh the task before retrying.');
    return actual;
  }

  async function change(itemId: string, values: ObjectValue, expected: Partial<TaskCard>): Promise<TaskCard> {
    await request(`mutation Change($item: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: ${BOARD}, item_id: $item, column_values: $values) { id }
    }`, { item: itemId, values: JSON.stringify(values) });
    return matches((await readItem(itemId)).card, expected);
  }

  /** Read every page of items (one request for the first page when it rides on a tick). */
  async function readItems(first: unknown): Promise<Map<string, TaskCard>> {
    const items = new Map<string, TaskCard>();
    const seen = new Set<string>();
    let page = object(first);
    for (;;) {
      if (!Array.isArray(page.items)) throw new Error('Invalid monday page.');
      for (const raw of page.items) {
        const card = parseItem(raw);
        if (card) items.set(card.id, card);
      }
      if (page.cursor === null || page.cursor === undefined) return items;
      if (typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > 4096 || seen.has(page.cursor)) {
        throw new Error('Invalid monday cursor.');
      }
      seen.add(page.cursor);
      page = object((await request(PAGE_QUERY, { cursor: page.cursor })).next_items_page);
    }
  }

  function board(data: ObjectValue): ObjectValue {
    if (!Array.isArray(data.boards) || data.boards.length !== 1) throw new Error('Could not read the Tasks board.');
    const b = object(data.boards[0]);
    if (id(b.id) !== BOARD) throw new Error('Could not read the Tasks board.');
    return b;
  }

  async function poll(prev: TasksView | null, { full = false }: { full?: boolean } = {}): Promise<PollResult> {
    const at = now();
    const before = prev ? snapshots.get(prev) : undefined;
    const everything = full || !before;
    // Whole seconds: "2026-11-06T11:58:00Z", the ISO8601DateTime form monday documents.
    const from = new Date((before ? Date.parse(prev!.at) : at) - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const data = await request(TICK_QUERY, { from, items: everything });
    const b = board(data);
    if (!Array.isArray(b.activity_logs) || !Array.isArray(b.updates)) throw new Error('Could not read Tasks board activity.');
    const raw: unknown[] = [...b.activity_logs];
    // A full page means there may be more: read on, up to LOG_PAGES pages in all.
    let last = b.activity_logs.length;
    let page = 1;
    while (last >= LOG_PAGE && page < LOG_PAGES) {
      page++;
      const more = board(await request(LOGS_QUERY, { from, page })).activity_logs;
      if (!Array.isArray(more)) throw new Error('Could not read Tasks board activity.');
      raw.push(...more);
      last = more.length;
    }
    const truncated = last >= LOG_PAGE;
    const activities = raw.map(parseActivity).filter((v): v is Activity => v !== null).sort(byTime);
    const comments = b.updates.map(parseCommentRef).filter((v): v is CommentRef => v !== null).sort(byTime);
    let items: Map<string, TaskCard>;
    let refetched = everything;
    if (everything) items = await readItems(b.items_page);
    else {
      // The log says whether anything changed: only then are the items read again.
      const known = new Set(before!.activities.map((a) => a.id));
      // A log too long to read in full could hide a change: read the items then too.
      const changed = truncated || activities.some((a) => !known.has(a.id)) || comments.some((c) => !before!.items.has(c.itemId));
      refetched = changed;
      items = changed ? await readItems(board(await request(ITEMS_QUERY)).items_page) : before!.items;
    }
    const complexity = data.complexity && typeof data.complexity === 'object' ? (data.complexity as ObjectValue).before : null;
    return {
      view: makeView({ items, activities, comments }, new Date(at).toISOString()),
      received: raw.length, parsed: activities.length, refetched, truncated,
      budget: typeof complexity === 'number' && Number.isFinite(complexity) ? complexity : null,
    };
  }

  return {
    /** The token's own user id, to check a pasted token is Gustav's before it is saved. */
    async whoAmI(): Promise<string> {
      const data = await request('query Me { me { id } }');
      return id(object(data.me).id);
    },

    poll,

    /** A full read: the items, the recent log and the recent comments. */
    async fetchBoard(): Promise<TasksView> {
      return (await poll(null, { full: true })).view;
    },

    async setStatus(itemId: string, label: TaskStatus): Promise<TaskCard> {
      if (!STATUSES.includes(label)) throw new Error('Invalid task status.');
      const before = await readItem(itemId);
      const changed = await change(itemId, { [STATUS]: { label } }, { status: label });
      if (label === 'Dropped') return matches(changed, { group: before.card.group });
      try {
        await request(`mutation Move($item: ID!, $group: String!) {
          move_item_to_group(item_id: $item, group_id: $group) { id }
        }`, { item: itemId, group: GROUPS[label] });
      } catch {
        // The label is already changed on monday: say exactly that, not a plain failure.
        throw new Error(NOT_MOVED);
      }
      const after = (await readItem(itemId)).card;
      if (after.status !== label) throw new Error('Monday write verification failed. Refresh the task before retrying.');
      if (after.group !== GROUPS[label]) throw new Error(NOT_MOVED);
      return after;
    },

    async setPriority(itemId: string, label: TaskPriority): Promise<TaskCard> {
      if (!PRIORITIES.includes(label)) throw new Error('Invalid task priority.');
      await readItem(itemId);
      return change(itemId, { [PRIORITY]: { label } }, { priority: label });
    },

    async setDue(itemId: string, due: string | null): Promise<TaskCard> {
      if (due !== null) date(due);
      await readItem(itemId);
      return change(itemId, { [DUE]: due === null ? null : { date: due } }, { due });
    },

    async addComment(itemId: string, body: string): Promise<TaskCard> {
      const text = typeof body === 'string' ? body.trim() : '';
      if (!text || text.length > 10_000) throw new Error('Invalid task comment.');
      await readItem(itemId);
      // create_update takes HTML: escape the text, and keep its line breaks as <br>.
      const html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
      const result = await request(`mutation Comment($item: ID!, $body: String!) {
        create_update(item_id: $item, body: $body) { id }
      }`, { item: itemId, body: html });
      const updateId = id(object(result.create_update).id);
      const after = await readItem(itemId);
      // The update monday just named is on the item: that is the comment, posted.
      if (!after.updateIds.includes(updateId)) {
        throw new Error('Monday comment verification failed. Refresh the task before retrying.');
      }
      return after.card;
    },

    async createTask(input: { name: string; priority?: TaskPriority; due?: string }): Promise<TaskCard> {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || Array.from(name).length > 500) throw new Error('Invalid task name.');
      if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) throw new Error('Invalid task priority.');
      if (input.due !== undefined) date(input.due);
      const person = { personsAndTeams: [{ id: Number(GUSTAV), kind: 'person' }] };
      const values: ObjectValue = { [STATUS]: { label: 'Not started' }, [OWNER]: person, [ASSIGNED]: person };
      const expected: Partial<TaskCard> = {
        name, status: 'Not started', group: GROUPS['Not started'], ownerIds: [GUSTAV], assignedByIds: [GUSTAV],
      };
      if (input.priority !== undefined) { values[PRIORITY] = { label: input.priority }; expected.priority = input.priority; }
      if (input.due !== undefined) { values[DUE] = { date: input.due }; expected.due = input.due; }
      const result = await request(`mutation Create($name: String!, $values: JSON!) {
        create_item(board_id: ${BOARD}, group_id: "${GROUPS['Not started']}", item_name: $name, column_values: $values) { id }
      }`, { name, values: JSON.stringify(values) });
      return matches((await readItem(id(object(result.create_item).id))).card, expected);
    },
  };
}

export type MondayClient = ReturnType<typeof createMondayClient>;

/**
 * What other people changed between two polls. A change counts when its log
 * entry is new (not in the previous poll, which overlapped this one) and no
 * older than the previous poll less OVERLAP_MS. There is no upper bound: a
 * change stamped after this poll's own clock is still a change.
 */
export function diffTasks(prev: TasksView | null, next: TasksView, me: string): TaskEvent[] {
  if (!prev) return [];
  const before = snapshots.get(prev);
  const after = snapshots.get(next);
  // Without trusted actor evidence, suppress rather than misattribute a notice.
  if (!before || !after || !/^\d{1,30}$/.test(me)) return [];
  const events: TaskEvent[] = [];
  const seen = new Set(before.activities.map((a) => a.id));
  const seenComments = new Set(before.comments.map((c) => c.id));
  const floor = Date.parse(prev.at) - OVERLAP_MS;
  const fresh = (at: string): boolean => Date.parse(at) >= floor;
  const related = (c: TaskCard): boolean => c.ownerIds.includes(me) || c.assignedByIds.includes(me);
  const emit = (kind: TaskEvent['kind'], card: TaskCard, source: { id: string; actorId: string; at: string }): void => {
    if (source.actorId !== me) events.push({
      id: `${kind}:${source.id}`, kind, taskId: card.id, taskName: card.name, actorId: source.actorId, at: source.at,
    });
  };
  for (const card of after.items.values()) {
    const old = before.items.get(card.id);
    // Newest first: the latest change decides who moved it.
    const changes = after.activities.filter((a) => a.itemId === card.id && !seen.has(a.id) && fresh(a.at))
      .sort((a, b) => byTime(b, a));
    /*
     * THE LOG ENTRY DECIDES, when it says what it changed. Comparing two
     * snapshots misses a change whose items were read before its log entry
     * arrived (log lag, or a move between the two requests): the next poll
     * then sees the entry but an unchanged card. An entry's own before and
     * after values do not depend on when the items were read. The id
     * de-duplication (`seen`, and the notifier's saved keys) keeps it to once.
     */
    const described = [...changes].reverse().filter((a) => a.change !== null);
    const of = (column: Change['column']): Activity[] => described.filter((a) => a.change!.column === column);
    // Over this poll's entries for one column: the value before the first and after the last.
    const span = <T>(list: Activity[], fallback: T): { before: T; after: T; latest: Activity } | null => list.length
      ? { before: ((list[0].change as unknown as { before?: T }).before ?? fallback), after: (list[list.length - 1].change as unknown as { after: T }).after, latest: list[list.length - 1] }
      : null;
    const owners = span<string[]>(of('owner'), old?.ownerIds ?? []);
    const assigners = span<string[]>(of('assigned'), old?.assignedByIds ?? []);
    const ownsNow = owners?.after ?? card.ownerIds;
    const assignedNow = assigners?.after ?? card.assignedByIds;
    const relatedNow = (old !== undefined && related(old)) || related(card) || ownsNow.includes(me) || assignedNow.includes(me);

    if (owners || assigners) {
      const latest = [owners?.latest, assigners?.latest].filter((a): a is Activity => !!a).sort((a, b) => byTime(b, a))[0];
      const ownedBefore = owners?.before ?? old?.ownerIds ?? [];
      const assignedBefore = assigners?.before ?? old?.assignedByIds ?? [];
      if (ownsNow.includes(me) && assignedNow.includes(JACO) && !(ownedBefore.includes(me) && assignedBefore.includes(JACO)) &&
          latest.actorId === JACO) emit('assigned', card, latest);
    } else {
      // Fallback, entries that do not say what they changed (create_pulse): compare the snapshots.
      const assignment = changes.find((a) => a.change === null && (a.columnId === OWNER || a.columnId === ASSIGNED || a.event === 'create_pulse'));
      if (card.ownerIds.includes(me) && card.assignedByIds.includes(JACO) &&
          (!old?.ownerIds.includes(me) || !old.assignedByIds.includes(JACO)) && assignment?.actorId === JACO) {
        emit('assigned', card, assignment);
      }
    }

    const statuses = span<TaskStatus | null>(of('status'), old?.status ?? null);
    const groups = span<TaskGroup | null>(of('group'), old?.group ?? null);
    if (statuses || groups) {
      const latest = [statuses?.latest, groups?.latest].filter((a): a is Activity => !!a).sort((a, b) => byTime(b, a))[0];
      const statusMoved = !!statuses && statuses.before !== statuses.after;
      const groupMoved = !!groups && groups.before !== groups.after;
      if (relatedNow && (statusMoved || groupMoved)) {
        if (latest.actorId === JACO) emit('moved', card, latest);
        const leftWaiting = statuses
          ? statuses.before === 'Waiting' && statuses.after !== 'Waiting'
          : groups!.before === GROUPS.Waiting && groups!.after !== GROUPS.Waiting;
        if (leftWaiting) emit('leftWaiting', card, latest);
      }
    } else {
      // Fallback, a move whose entry does not say from what to what: compare the snapshots.
      const move = changes.find((a) => a.change === null && (a.columnId === STATUS || a.event === 'move_pulse_from_group' || a.event === 'move_pulse_into_group' || a.event === 'move_item_to_group'));
      if (old && (related(old) || related(card)) && move && (old.status !== card.status || old.group !== card.group)) {
        if (move.actorId === JACO) emit('moved', card, move);
        if (old.status === 'Waiting' && card.status !== 'Waiting') emit('leftWaiting', card, move);
      }
    }
    if (related(card)) {
      for (const comment of after.comments) {
        if (comment.itemId === card.id && comment.actorId === JACO && !seenComments.has(comment.id) && fresh(comment.at)) {
          emit('commented', card, comment);
        }
      }
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
