import type { TaskCard, TaskEvent, TaskGroup, TaskPriority, TaskStatus, TasksView } from '../../shared/work-view';
import { createMondayToken, type MondayFetch, type MondayToken } from './monday-token';

const BOARD = '5106174674';
const GUSTAV = '119615221';
const JACO = '119615219';
const DAY = 86_400_000;
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
const FIELDS = `id name updated_at board { id } group { id }
  column_values(ids: ["${STATUS}", "${OWNER}", "${ASSIGNED}", "${PRIORITY}", "${DUE}", "${PROJECT}"]) {
    id text value ... on BoardRelationValue { display_value }
  }
  updates(limit: 100) { id text_body created_at creator { id } }`;
const BOARD_QUERY = `query Tasks($cursor: String, $logs: Boolean!) {
  boards(ids: [${BOARD}]) {
    id
    items_page(limit: 200, cursor: $cursor) { cursor items { ${FIELDS} } }
    activity_logs(limit: 10000) @include(if: $logs) { id event data user_id created_at }
  }
}`;

type ObjectValue = Record<string, unknown>;
interface Activity { id: string; itemId: string; actorId: string; at: string; event: string; columnId: string | null }
interface Comment { id: string; actorId: string; at: string; text: string }
interface Item { card: TaskCard; comments: Comment[] }
interface Snapshot { items: Map<string, Item>; activities: Activity[] }

// Attribution stays in main. Serializing a TasksView never exposes logs or comments.
// diffTasks takes the original fetchBoard snapshots, not renderer round-trips.
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

function parseComment(raw: unknown): Comment | null {
  try {
    const r = object(raw);
    return { id: id(r.id), actorId: id(object(r.creator).id), at: timestamp(r.created_at), text: string(r.text_body, 10_000) };
  } catch { return null; }
}

function parseItem(raw: unknown): Item | null {
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
    if (!name.trim() || !Array.isArray(r.updates)) return null;
    return {
      card: {
        id: id(r.id), name, group: group as TaskGroup, status: status as TaskStatus,
        priority: priority ? priority as TaskPriority : null, due,
        ownerIds: people(column(OWNER).value), assignedByIds: people(column(ASSIGNED).value),
        project, updatedAt: timestamp(r.updated_at),
      },
      comments: r.updates.map(parseComment).filter((v): v is Comment => v !== null),
    };
  } catch { return null; }
}

function parseActivity(raw: unknown): Activity | null {
  try {
    const r = object(raw);
    const data = object(json(r.data));
    const at = typeof r.created_at === 'string' && /^\d{17}$/.test(r.created_at)
      ? new Date(Number(BigInt(r.created_at) / 10_000n)).toISOString() : timestamp(r.created_at);
    return {
      id: id(r.id), itemId: id(data.pulse_id ?? data.item_id), actorId: id(r.user_id), at,
      event: string(r.event, 100), columnId: data.column_id === undefined ? null : string(data.column_id, 100),
    };
  } catch { return null; }
}

function makeView(snapshot: Snapshot, at: string): TasksView {
  const columns: TasksView['columns'] = { inProgress: [], waiting: [], backlog: [], done: [] };
  const time = Date.parse(at);
  const today = at.slice(0, 10);
  // Calendar summaries use UTC consistently with the API dates and injected clock.
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  const weekStart = start.toISOString().slice(0, 10);
  const weekEnd = new Date(start.getTime() + 7 * DAY).toISOString().slice(0, 10);
  for (const { card } of snapshot.items.values()) {
    if (card.status === 'Dropped') continue;
    if (card.status === 'Done') {
      if (Date.parse(card.updatedAt) >= time - 7 * DAY && Date.parse(card.updatedAt) <= time) columns.done.push(card);
    } else if (card.status === 'Waiting') columns.waiting.push(card);
    else if (card.status === 'In progress') columns.inProgress.push(card);
    else columns.backlog.push(card);
  }
  const open = [...columns.inProgress, ...columns.waiting, ...columns.backlog];
  const view: TasksView = {
    at, columns,
    counts: {
      inProgress: columns.inProgress.length, waiting: columns.waiting.length,
      backlog: columns.backlog.length, done: columns.done.length,
      overdue: open.filter((c) => c.due !== null && c.due < today).length,
      dueThisWeek: open.filter((c) => c.due !== null && c.due >= today && c.due < weekEnd).length,
      // Current open assignments from Jaco, not a persisted unread counter.
      newFromJaco: open.filter((c) => c.ownerIds.includes(GUSTAV) && c.assignedByIds.includes(JACO)).length,
      doneThisWeek: columns.done.filter((c) => c.updatedAt.slice(0, 10) >= weekStart).length,
    },
  };
  snapshots.set(view, snapshot);
  return view;
}

export function createMondayClient({ fetch, token, now = Date.now }: {
  fetch: MondayFetch;
  token: string | MondayToken;
  now?: () => number;
}) {
  const credential = typeof token === 'string' ? createMondayToken(token) : token;

  async function request(query: string, variables: ObjectValue = {}): Promise<ObjectValue> {
    try {
      const result = object(await credential.post(fetch, JSON.stringify({ query, variables })));
      if (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length > 0)) throw new Error();
      return object(result.data);
    } catch {
      // GraphQL errors can echo variables or credentials; no server text escapes.
      throw new Error('Monday request failed.');
    }
  }

  async function readItem(itemId: string): Promise<Item> {
    const data = await request(`query Task($ids: [ID!]!) { items(ids: $ids) { ${FIELDS} } }`, { ids: [id(itemId)] });
    const item = Array.isArray(data.items) && data.items.length === 1 ? parseItem(data.items[0]) : null;
    if (!item || item.card.id !== itemId) throw new Error('Could not read the Tasks board item.');
    return item;
  }

  function matches(actual: TaskCard, expected: Partial<TaskCard>): TaskCard {
    if (Object.entries(expected).some(([key, value]) => JSON.stringify(actual[key as keyof TaskCard]) !== JSON.stringify(value))) {
      throw new Error('Monday write verification failed. Refresh the task before retrying.');
    }
    return actual;
  }

  async function change(itemId: string, values: ObjectValue, expected: Partial<TaskCard>): Promise<TaskCard> {
    await request(`mutation Change($item: ID!, $values: JSON!) {
      change_multiple_column_values(board_id: ${BOARD}, item_id: $item, column_values: $values) { id }
    }`, { item: itemId, values: JSON.stringify(values) });
    return matches((await readItem(itemId)).card, expected);
  }

  return {
    async fetchBoard(): Promise<TasksView> {
      const snapshot: Snapshot = { items: new Map(), activities: [] };
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const data = await request(BOARD_QUERY, { cursor, logs: cursor === null });
        if (!Array.isArray(data.boards) || data.boards.length !== 1) throw new Error('Could not read the Tasks board.');
        const board = object(data.boards[0]);
        if (id(board.id) !== BOARD) throw new Error('Could not read the Tasks board.');
        if (cursor === null) {
          if (!Array.isArray(board.activity_logs)) throw new Error('Could not read Tasks board activity.');
          snapshot.activities = board.activity_logs.map(parseActivity).filter((v): v is Activity => v !== null);
        }
        const page = object(board.items_page);
        if (!Array.isArray(page.items)) throw new Error('Invalid monday page.');
        for (const raw of page.items) {
          const item = parseItem(raw);
          if (item) snapshot.items.set(item.card.id, item);
        }
        if (page.cursor === null) cursor = null;
        else {
          if (typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > 4096 || seen.has(page.cursor)) {
            throw new Error('Invalid monday cursor.');
          }
          cursor = page.cursor;
          seen.add(cursor);
        }
      } while (cursor !== null);
      return makeView(snapshot, new Date(now()).toISOString());
    },

    async setStatus(itemId: string, label: TaskStatus): Promise<TaskCard> {
      if (!STATUSES.includes(label)) throw new Error('Invalid task status.');
      const before = await readItem(itemId);
      const changed = await change(itemId, { [STATUS]: { label } }, { status: label });
      if (label === 'Dropped') return matches(changed, { group: before.card.group });
      await request(`mutation Move($item: ID!, $group: String!) {
        move_item_to_group(item_id: $item, group_id: $group) { id }
      }`, { item: itemId, group: GROUPS[label] });
      return matches((await readItem(itemId)).card, { status: label, group: GROUPS[label] });
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
      if (typeof body !== 'string' || !body.trim() || body.length > 10_000) throw new Error('Invalid task comment.');
      await readItem(itemId);
      // create_update accepts HTML. Escape user text so read-back compares plain text.
      const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const result = await request(`mutation Comment($item: ID!, $body: String!) {
        create_update(item_id: $item, body: $body) { id }
      }`, { item: itemId, body: escaped });
      const after = await readItem(itemId);
      const updateId = id(object(result.create_update).id);
      if (!after.comments.some((c) => c.id === updateId && c.text === body)) {
        throw new Error('Monday comment verification failed. Refresh the task before retrying.');
      }
      return after.card;
    },

    async createTask(input: { name: string; priority?: TaskPriority; due?: string }): Promise<TaskCard> {
      if (typeof input.name !== 'string' || !input.name.trim() || Array.from(input.name).length > 500) {
        throw new Error('Invalid task name.');
      }
      if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) throw new Error('Invalid task priority.');
      if (input.due !== undefined) date(input.due);
      const person = { personsAndTeams: [{ id: Number(GUSTAV), kind: 'person' }] };
      const values: ObjectValue = { [STATUS]: { label: 'Not started' }, [OWNER]: person, [ASSIGNED]: person };
      const expected: Partial<TaskCard> = {
        name: input.name, status: 'Not started', group: GROUPS['Not started'], ownerIds: [GUSTAV], assignedByIds: [GUSTAV],
      };
      if (input.priority !== undefined) { values[PRIORITY] = { label: input.priority }; expected.priority = input.priority; }
      if (input.due !== undefined) { values[DUE] = { date: input.due }; expected.due = input.due; }
      const result = await request(`mutation Create($name: String!, $values: JSON!) {
        create_item(board_id: ${BOARD}, group_id: "${GROUPS['Not started']}", item_name: $name, column_values: $values) { id }
      }`, { name: input.name, values: JSON.stringify(values) });
      return matches((await readItem(id(object(result.create_item).id))).card, expected);
    },
  };
}

export function diffTasks(prev: TasksView | null, next: TasksView, me: string): TaskEvent[] {
  if (!prev) return [];
  const before = snapshots.get(prev);
  const after = snapshots.get(next);
  // Without trusted actor evidence, suppress rather than misattribute a notice.
  if (!before || !after || !/^\d{1,30}$/.test(me)) return [];
  const events: TaskEvent[] = [];
  const seen = new Set(before.activities.map((a) => a.id));
  const fresh = (at: string): boolean => at >= prev.at && at <= next.at;
  const related = (c: TaskCard): boolean => c.ownerIds.includes(me) || c.assignedByIds.includes(me);
  const emit = (kind: TaskEvent['kind'], card: TaskCard, source: { id: string; actorId: string; at: string }): void => {
    if (source.actorId !== me) events.push({
      id: `${kind}:${source.id}`, kind, taskId: card.id, taskName: card.name, actorId: source.actorId, at: source.at,
    });
  };
  for (const { card, comments } of after.items.values()) {
    const old = before.items.get(card.id);
    const changes = after.activities.filter((a) => a.itemId === card.id && !seen.has(a.id) && fresh(a.at))
      .sort((a, b) => b.at.localeCompare(a.at) || (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
    const assignment = changes.find((a) => a.columnId === OWNER || a.columnId === ASSIGNED || a.event === 'create_pulse');
    if (card.ownerIds.includes(me) && card.assignedByIds.includes(JACO) &&
        (!old?.card.ownerIds.includes(me) || !old.card.assignedByIds.includes(JACO)) && assignment?.actorId === JACO) {
      emit('assigned', card, assignment);
    }
    const move = changes.find((a) => a.columnId === STATUS || a.event === 'move_pulse_into_group' || a.event === 'move_item_to_group');
    if (old && (related(old.card) || related(card)) && move && (old.card.status !== card.status || old.card.group !== card.group)) {
      if (move.actorId === JACO) emit('moved', card, move);
      if (old.card.status === 'Waiting' && card.status !== 'Waiting') emit('leftWaiting', card, move);
    }
    if (related(card)) {
      const seenComments = new Set(old?.comments.map((c) => c.id));
      for (const comment of comments) {
        if (comment.actorId === JACO && !seenComments.has(comment.id) && fresh(comment.at)) emit('commented', card, comment);
      }
    }
  }
  return events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
