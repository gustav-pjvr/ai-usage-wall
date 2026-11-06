/**
 * Work mode, phase 1 (docs/work-mode.md): the notice rules, the sync, the IPC
 * the wall and the Connect dialog use, and the two safety properties that
 * matter most.
 *
 *   1. THE TOKEN. A fake token is planted and every serialised form is
 *      searched for it: every IPC reply, every push to a wall, connect or
 *      toast window, every log line, every thrown error, every file written,
 *      and a projection frame built from an index carrying work data.
 *   2. THE EDITIONS. The stats build is bundled here and searched: no Work
 *      IPC channel, no preload member, no monday code in any bundle. The full
 *      build is searched for the same strings so the check cannot pass empty.
 *
 * Electron is a stub; storage is the real temporary filesystem and the clock
 * is injected, so quiet hours and the 08:00 summary are tested at fixed times.
 */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import * as esbuild from 'esbuild';
import ts from 'typescript';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mbw-work-'));
const require = createRequire(import.meta.url);
const TOKEN = 'planted-monday-token-MUST-NOT-LEAK-7f3a';
const key = randomBytes(32);

// ── Electron stub ───────────────────────────────────────────────────────────

const handlers = new Map();
const opened = [];
const windows = [];
let wcId = 100;
let fetchImpl = async () => { throw new Error('no fetch set'); };
const fakeWebContents = () => {
  const sent = [];
  return {
    id: ++wcId, sent,
    send: (channel, value) => sent.push([channel, value]),
    on() {}, once(_e, fn) { fn(); }, setWindowOpenHandler() {}, isLoading: () => false,
  };
};
class FakeWindow {
  constructor(opts) {
    this.opts = opts; this.webContents = fakeWebContents(); this.destroyed = false; this.loaded = null;
    windows.push(this);
  }
  setMenu() {} on() {} show() {} focus() {}
  loadFile(f) { this.loaded = f; return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; } destroy() { this.destroyed = true; }
}
const electron = {
  app: { getPath: () => tmp },
  ipcMain: { handle: (channel, fn) => { assert.ok(!handlers.has(channel), `one handler per channel: ${channel}`); handlers.set(channel, fn); } },
  BrowserWindow: FakeWindow,
  net: { fetch: (url, init) => fetchImpl(url, init) },
  shell: { openExternal: async (url) => { opened.push(url); } },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  },
};

// The TypeScript compiler in-process, as test/monday.test.mjs does. Only Electron is stubbed.
const cache = new Map();
async function load(relative) {
  const filename = path.join(root, relative);
  if (cache.has(filename)) return cache.get(filename);
  const source = await fs.readFile(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === 'electron') return electron;
    if (name.startsWith('.')) {
      const dependency = cache.get(path.resolve(path.dirname(filename), `${name}.ts`));
      assert.ok(dependency, `load the local dependency first: ${name}`);
      return dependency;
    }
    return require(name);
  };
  // __dirname as the built bundle sees it (dist/main), for the window paths.
  runInThisContext(`(function(require, module, exports, __dirname) { ${compiled}\n})`, { filename })(localRequire, module, module.exports, path.join(root, 'dist', 'main'));
  cache.set(filename, module.exports);
  return module.exports;
}

// Every console line, so the token can be searched for in the log too.
const output = [];
const original = { log: console.log, warn: console.warn, error: console.error };
const capture = (k) => (...args) => output.push(`${k}: ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; original.log(`  PASS  ${name}`); }
  catch (error) { failed++; original.log(`  FAIL  ${name}: ${String(error?.stack ?? error).replaceAll(TOKEN, '[redacted]')}`); }
}
const noToken = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!String(text).includes(TOKEN), `${label} contains the token`);
};

// ── A fake monday ───────────────────────────────────────────────────────────

const B = '5106174674', G = '119615221', J = '119615219';
const S = 'color_mm86v4eh', O = 'multiple_person_mm86z4cd', A = 'multiple_person_mm869xm7';
const P = 'color_mm86ddn1', D = 'date_mm86ewhc', R = 'board_relation_mm86t9nv';
const groups = { 'Not started': 'group_mm86nn5y', 'In progress': 'topics', Waiting: 'group_mm861qv1', Done: 'group_mm86644p' };
const personValue = (ids) => JSON.stringify({ personsAndTeams: ids.map((v) => ({ id: Number(v), kind: 'person' })) });
function item(itemId, o = {}) {
  const status = o.status ?? 'Not started';
  return {
    id: itemId, name: o.name ?? `Task ${itemId}`, updated_at: o.updatedAt ?? '2026-11-04T12:00:00.000Z',
    board: { id: B }, group: { id: o.group ?? groups[status] ?? groups['Not started'] },
    column_values: [
      { id: S, text: status, value: null },
      { id: O, text: '', value: personValue(o.owners ?? [G]) },
      { id: A, text: '', value: personValue(o.assigned ?? [G]) },
      { id: P, text: o.priority ?? '', value: null },
      { id: D, text: '', value: o.due ? JSON.stringify({ date: o.due }) : null },
      { id: R, text: null, value: null, display_value: o.project ?? '' },
    ],
    updates: o.comments ?? [],
  };
}
const column = (row, k) => row.column_values.find((c) => c.id === k);

/** A monday that answers the queries the client makes. `mode` picks a failure. */
function monday(rows, options = {}) {
  const state = { rows: structuredClone(rows), activities: [], me: options.me ?? G, mode: null, ignore: null, log: [] };
  state.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    state.log.push({ url, init, payload });
    assert.equal(url, 'https://api.monday.com/v2');
    assert.equal(init.headers.Authorization, TOKEN);
    if (state.mode === 'offline') throw new Error(`connect ECONNREFUSED ${TOKEN}`);
    if (state.mode === 'http401') return { ok: false, status: 401, json: async () => ({ error_message: TOKEN }) };
    if (state.mode === 'http429') return { ok: false, status: 429, json: async () => ({ error_message: TOKEN }) };
    if (state.mode === 'gqlRate') return { ok: true, status: 200, json: async () => ({ errors: [{ message: `Budget ${TOKEN}`, extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED' } }] }) };
    if (state.mode === 'gqlAuth') return { ok: true, status: 200, json: async () => ({ error_code: 'UserUnauthorizedException', status_code: 401, error_message: TOKEN }) };
    if (state.mode === 'gqlOther') return { ok: true, status: 200, json: async () => ({ errors: [{ message: TOKEN }] }) };
    // The daily cap, as monday answers it: HTTP 429 with the code in the body.
    if (state.mode === 'daily') return { ok: false, status: 429, json: async () => ({ error_code: 'DAILY_LIMIT_EXCEEDED', status_code: 429, error_message: TOKEN }) };
    const { query, variables: v } = payload;
    // A request that never answers and ignores its abort signal: only the race can end it.
    const write = !/query (Tasks|Logs|Items|Page|Me)\b/.test(query);
    if (state.mode === 'hang' || (state.mode === 'hangWrites' && write)) return new Promise(() => undefined);
    let data;
    if (query.includes('query Me')) data = { me: { id: state.me } };
    else if (query.includes('query Tasks')) {
      const updates = state.rows.flatMap((r) => r.updates.map((u) => ({ id: u.id, created_at: u.created_at, item_id: r.id, creator: u.creator })));
      data = { complexity: { before: 19_990_000, query: 9000 }, boards: [{ id: B, activity_logs: state.activities, updates, ...(v.items ? { items_page: { items: state.rows, cursor: null } } : {}) }] };
    } else if (query.includes('query Items')) data = { boards: [{ id: B, items_page: { items: state.rows, cursor: null } }] };
    else if (query.includes('query Task(')) data = { items: state.rows.filter((r) => v.ids.includes(r.id)).map((r) => ({ ...r, updates: r.updates.map((u) => ({ id: u.id })) })) };
    else if (query.includes('change_multiple_column_values')) {
      const row = state.rows.find((r) => r.id === v.item);
      if (state.ignore !== 'columns') {
        for (const [k, value] of Object.entries(JSON.parse(v.values))) {
          if (k === S || k === P) column(row, k).text = value.label;
          else column(row, k).value = value === null ? null : JSON.stringify(value);
        }
      }
      data = { change_multiple_column_values: { id: v.item } };
    } else if (query.includes('move_item_to_group')) {
      if (state.ignore !== 'move') state.rows.find((r) => r.id === v.item).group.id = v.group;
      data = { move_item_to_group: { id: v.item } };
    } else if (query.includes('create_update')) {
      state.rows.find((r) => r.id === v.item).updates.unshift({ id: '900', creator: { id: G }, text_body: v.body, created_at: '2026-11-04T12:00:00.000Z' });
      data = { create_update: { id: '900' } };
    } else if (query.includes('create_item')) {
      const values = JSON.parse(v.values);
      state.rows.push(item('901', { name: v.name, priority: values[P]?.label, due: values[D]?.date }));
      data = { create_item: { id: '901' } };
    } else throw new Error('Unexpected test query');
    return { ok: true, status: 200, json: async () => structuredClone({ data }) };
  };
  return state;
}
/** Real-shaped: a UUID id and created_at as 17 digits of 1e-7 s since the epoch. */
const activity = (activityId, itemId, actor, columnId, at) => ({
  id: `5610e651-0915-407e-8382-${String(activityId).padStart(12, '0')}`, user_id: actor, event: columnId ? 'update_column_value' : 'create_pulse',
  created_at: String(BigInt(at) * 10_000n),
  data: JSON.stringify({ pulse_id: itemId, ...(columnId ? { column_id: columnId } : {}) }),
});

/** A local-time timestamp for a weekday (getDay() === dow) in November 2026. */
function local(dow, h, m = 0, week = 0) {
  for (let d = 1; d <= 30; d++) {
    const t = new Date(2026, 10, d + week * 7, h, m);
    if (t.getDay() === dow) return t.getTime();
  }
  throw new Error('no such day');
}
const WED = 3, SAT = 6;

try {
  console.log = capture('log'); console.warn = capture('warn'); console.error = capture('error');

  const view = await load('src/shared/work-view.ts');
  const token = await load('src/main/work/monday-token.ts');
  const mondayMod = await load('src/main/work/monday.ts');
  const notify = await load('src/main/work/notify.ts');
  const sync = await load('src/main/work/sync.ts');
  const work = await load('src/main/work/index.ts');

  // ── Notice rules ──────────────────────────────────────────────────────────
  original.log('\nnotice rules (injected clock)');

  const ev = (id, kind, actorId = J, taskId = '1', taskName = 'Quote numbers') => ({ id: `${kind}:${id}`, kind, taskId, taskName, actorId, at: '2026-11-04T10:00:00.000Z' });
  const notifier = (clock, opts = {}) => {
    const shown = [];
    const saved = [];
    const n = notify.createWorkNotifier({
      now: () => clock.t, focus: () => opts.focus?.() ?? false, state: opts.state ?? notify.emptyNotifierState(),
      save: (s) => saved.push(structuredClone(s)), show: (x) => shown.push(x), me: G,
    });
    return { n, shown, saved };
  };

  await test('Jaco assigning Gustav a task notifies once, with sender and task name only', async () => {
    const clock = { t: local(WED, 10) };
    const { n, shown } = notifier(clock);
    n.events([ev('1', 'assigned')]);
    assert.equal(shown.length, 1);
    assert.deepEqual(
      { from: shown[0].from, title: shown[0].title, taskId: shown[0].taskId, canDone: shown[0].canDone, count: shown[0].count },
      { from: 'Jaco', title: 'Quote numbers', taskId: '1', canDone: true, count: 1 },
    );
  });
  await test('the same event never notifies twice, also after a restart (keys are persisted)', async () => {
    const clock = { t: local(WED, 10) };
    const a = notifier(clock);
    a.n.events([ev('1', 'moved')]);
    a.n.events([ev('1', 'moved')]);
    assert.equal(a.shown.length, 1);
    const b = notifier(clock, { state: a.saved.at(-1) });
    b.n.events([ev('1', 'moved')]);
    assert.equal(b.shown.length, 0);
    b.n.events([ev('2', 'moved')]);
    assert.equal(b.shown.length, 1);
  });
  await test("Gustav's own changes never notify", async () => {
    const { n, shown } = notifier({ t: local(WED, 10) });
    n.events([ev('1', 'moved', G), ev('2', 'commented', G), ev('3', 'leftWaiting', G)]);
    assert.equal(shown.length, 0);
  });
  await test('focus mode suppresses notices, and they do not come back after it', async () => {
    let focus = true;
    const { n, shown } = notifier({ t: local(WED, 10) }, { focus: () => focus });
    n.events([ev('1', 'assigned')]);
    focus = false;
    n.events([ev('1', 'assigned')]);
    assert.equal(shown.length, 0);
  });
  await test('quiet hours (19:00 weekday): only Jaco assignments get through, the rest are held', async () => {
    const { n, shown, saved } = notifier({ t: local(WED, 19) });
    n.events([ev('1', 'moved'), ev('2', 'commented'), ev('3', 'leftWaiting', '555')]);
    assert.equal(shown.length, 0);
    assert.equal(saved.at(-1).held, 3);
    n.events([ev('4', 'assigned')]);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].kind, 'assigned');
  });
  await test('quiet hours edges: 07:29 quiet, 07:30 not, 17:59 not, 18:00 quiet; weekends quiet all day', async () => {
    assert.equal(notify.isQuiet(local(WED, 7, 29)), true);
    assert.equal(notify.isQuiet(local(WED, 7, 30)), false);
    assert.equal(notify.isQuiet(local(WED, 17, 59)), false);
    assert.equal(notify.isQuiet(local(WED, 18, 0)), true);
    assert.equal(notify.isQuiet(local(SAT, 12, 0)), true);
    const { n, shown } = notifier({ t: local(SAT, 11) });
    n.events([ev('1', 'commented')]);
    assert.equal(shown.length, 0);
    n.events([ev('2', 'assigned')]);
    assert.equal(shown.length, 1);
  });
  await test('a burst in one sync is one notice with a count, and no Done', async () => {
    const { n, shown } = notifier({ t: local(WED, 11) });
    n.events([ev('1', 'moved', J, '1', 'First'), ev('2', 'commented', J, '2', 'Second'), ev('3', 'leftWaiting', '555', '3', 'Third')]);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].count, 3);
    assert.equal(shown[0].kind, 'burst');
    assert.equal(shown[0].canDone, false);
    assert.equal(shown[0].title, 'Third');
  });
  await test('an unknown person is "Someone", never an id', async () => {
    const { n, shown } = notifier({ t: local(WED, 11) });
    n.events([ev('1', 'leftWaiting', '555')]);
    assert.equal(shown[0].from, 'Someone');
  });

  const board = (cards) => ({ at: '2026-11-04T08:00:00.000Z', columns: { inProgress: cards, waiting: [], backlog: [], done: [] }, counts: {} });
  const card = (id, due, owners = [G]) => ({ id, name: `T${id}`, group: 'topics', status: 'In progress', priority: null, due, ownerIds: owners, assignedByIds: [G], project: null, updatedAt: '2026-11-01T00:00:00.000Z' });

  await test('08:00 summary: once a day, due today and overdue for Gustav, plus what quiet hours held', async () => {
    const clock = { t: local(WED, 7, 0) };
    const { n, shown } = notifier(clock);
    n.events([ev('1', 'moved'), ev('2', 'moved')]); // held overnight
    const today = notify.localDay(local(WED, 9));
    const yesterday = notify.localDay(local(WED, 9) - 86_400_000);
    const b = board([card('1', today), card('2', yesterday), card('3', today, [J]), card('4', null)]);
    clock.t = local(WED, 7, 45);
    n.tick(b);
    assert.equal(shown.length, 0, 'nothing before 08:00');
    clock.t = local(WED, 8, 1);
    n.tick(b);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].kind, 'summary');
    assert.equal(shown[0].title, '1 due today, 1 overdue, 2 updates while you were away');
    assert.equal(shown[0].taskId, null);
    clock.t = local(WED, 12);
    n.tick(b);
    assert.equal(shown.length, 1, 'once a day');
  });
  await test('no summary on a weekend, and none when nothing is due', async () => {
    const clock = { t: local(SAT, 9) };
    const { n, shown, saved } = notifier(clock);
    n.tick(board([card('1', notify.localDay(clock.t))]));
    assert.equal(shown.length, 0);
    clock.t = local(WED, 9);
    n.tick(board([card('1', null)]));
    assert.equal(shown.length, 0);
    assert.equal(saved.at(-1).summaryDay, notify.localDay(clock.t));
  });
  await test('a summary that falls in focus mode waits until focus mode ends, the same day', async () => {
    let focus = true;
    const clock = { t: local(WED, 8, 5) };
    const { n, shown } = notifier(clock, { focus: () => focus });
    const b = board([card('1', notify.localDay(clock.t))]);
    n.tick(b);
    assert.equal(shown.length, 0);
    focus = false;
    clock.t = local(WED, 10);
    n.tick(b);
    assert.equal(shown.length, 1);
  });
  await test('changes during focus mode are counted into the morning summary', async () => {
    let focus = true;
    const clock = { t: local(WED, 11) };
    const { n, shown } = notifier(clock, { focus: () => focus });
    n.events([ev('1', 'moved'), ev('2', 'commented')]);
    assert.equal(shown.length, 0);
    focus = false;
    clock.t = local(WED, 8, 0, 1);
    n.tick(board([]));
    assert.equal(shown.at(-1)?.title, '0 due today, 0 overdue, 2 updates while you were away');
  });
  await test('a corrupt notice file costs nothing', async () => {
    assert.deepEqual(notify.cleanNotifierState({ seen: 'x', held: -4, summaryDay: TOKEN }), { seen: [], held: 0, summaryDay: null });
    assert.deepEqual(notify.cleanNotifierState(null), notify.emptyNotifierState());
  });

  // ── Status words ──────────────────────────────────────────────────────────
  original.log('\nstatus strip');
  await test('synced N s ago, read off the clock; failures in plain words', async () => {
    const at = Date.parse('2026-11-04T10:00:00.000Z');
    const ok = { connected: true, syncing: false, syncedAt: '2026-11-04T10:00:00.000Z', problem: null };
    assert.deepEqual(view.syncLabel(ok, at + 12_000), { text: 'monday synced 12s ago', tone: 'ok' });
    assert.equal(view.syncLabel(ok, at + 125_000).text, 'monday synced 2m ago');
    assert.equal(view.syncLabel({ ...ok, problem: 'auth' }, at + 5000).text, 'monday refused the token, use Reconnect monday in the tray, last synced 5s ago');
    assert.match(view.syncLabel({ ...ok, syncedAt: null, problem: 'offline' }, at).text, /^monday unreachable/);
    assert.match(view.syncLabel({ ...ok, problem: 'rate' }, at).text, /rate limited/);
    assert.equal(view.syncLabel({ connected: false, syncing: false, syncedAt: null, problem: null }, at).text, 'monday not connected');
  });
  await test('the task URL is built from a plain id only', async () => {
    assert.equal(view.taskUrl('123'), 'https://pickleplaysouthafrica-squad.monday.com/boards/5106174674/pulses/123');
    for (const bad of ['javascript:alert(1)', '1/../../x', '', '1 2', 12, null, '1'.repeat(31)]) assert.equal(view.taskUrl(bad), null);
    assert.equal(view.isTaskUrl('https://evil.example/boards/5106174674/pulses/1'), false);
  });
  await test('Mine is Owner includes Gustav; the strip counts only what the filter shows', async () => {
    const cols = { inProgress: [card('1', null), card('2', null, [J])], waiting: [], backlog: [], done: [] };
    assert.equal(view.filterColumns(cols, 'mine').inProgress.length, 1);
    assert.equal(view.filterColumns(cols, 'everyone').inProgress.length, 2);
    assert.equal(view.summarize(view.filterColumns(cols, 'mine'), '2026-11-04T10:00:00.000Z').inProgress, 1);
  });

  // ── Sync and actions ──────────────────────────────────────────────────────
  original.log('\nsync and actions');

  /** Fake timers: a list the test fires by hand. */
  const timers = () => {
    const list = [];
    return {
      list,
      setTimer: (fn, ms) => { const h = { fn, ms, live: true, at: null }; list.push(h); return h; },
      clearTimer: (h) => { h.live = false; },
      live: () => list.filter((h) => h.live),
    };
  };
  // A Wednesday, 14:00 local: working hours wherever the suite runs.
  const NOW = local(WED, 14);
  const makeSync = (state, clock = { t: NOW }, t = timers(), opts = {}) => {
    const changes = [];
    const events = [];
    const logs = [];
    const s = sync.createWorkSync({
      loadToken: async () => token.createMondayToken(TOKEN),
      makeClient: (tk) => mondayMod.createMondayClient({ fetch: state.fetch, token: tk, now: () => clock.t, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }),
      now: () => clock.t,
      paused: opts.paused,
      onChange: (p) => changes.push(structuredClone(p)),
      onEvents: (e) => events.push(...e),
      setTimer: t.setTimer, clearTimer: t.clearTimer,
      log: (l) => logs.push(l), me: G,
    });
    return { s, changes, events, logs, t, clock };
  };

  await test('no token: not connected, nothing fetched, nothing scheduled', async () => {
    const t = timers();
    const changes = [];
    const s = sync.createWorkSync({ loadToken: async () => null, makeClient: () => assert.fail('no client'), now: () => NOW, onChange: (p) => changes.push(p), onEvents: () => undefined, setTimer: t.setTimer, clearTimer: t.clearTimer });
    await s.start();
    assert.equal(changes.at(-1).status.connected, false);
    assert.equal(t.live().length, 0);
  });
  await test('fetch on start, then every 60 s; 10 s after an action', async () => {
    const m = monday([item('1')]);
    const { s, changes, t } = makeSync(m);
    await s.start();
    assert.equal(changes.at(-1).status.syncedAt, new Date(NOW).toISOString());
    assert.deepEqual(t.live().map((h) => h.ms), [60_000]);
    const r = await s.act((c) => c.setPriority('1', 'High'));
    assert.equal(r.ok, true);
    assert.deepEqual(t.live().map((h) => h.ms), [10_000]);
    const before = m.log.filter((x) => x.payload.query.includes('query Tasks')).length;
    const due = t.live()[0];
    due.live = false; // fired
    due.fn();
    await new Promise((r2) => setTimeout(r2, 10));
    assert.equal(m.log.filter((x) => x.payload.query.includes('query Tasks')).length, before + 1);
    assert.deepEqual(t.live().map((h) => h.ms), [60_000]);
  });
  await test('a later sync with Jaco\'s assignment reaches onEvents (the notice path)', async () => {
    const m = monday([item('1', { owners: [J], assigned: [J] })]);
    const clock = { t: NOW };
    const { s, events } = makeSync(m, clock);
    await s.start();
    m.rows[0] = item('1', { owners: [G], assigned: [J] });
    m.activities = [activity('70', '1', J, O, NOW + 30_000)];
    clock.t = NOW + 60_000;
    await s.refresh('test');
    assert.deepEqual(events.map((e) => [e.kind, e.actorId, e.taskId]), [['assigned', J, '1']]);
  });
  for (const [mode, problem] of [['offline', 'offline'], ['http401', 'auth'], ['http429', 'rate'], ['gqlRate', 'rate'], ['gqlAuth', 'auth'], ['gqlOther', 'server']]) {
    await test(`a ${mode} failure reads as "${problem}", with no server text anywhere`, async () => {
      const m = monday([item('1')]);
      const { s, changes, logs } = makeSync(m);
      await s.start();
      m.mode = mode;
      await s.refresh('test');
      assert.equal(changes.at(-1).status.problem, problem);
      assert.ok(changes.at(-1).status.syncedAt, 'the last good sync time is kept');
      const r = await s.act((c) => c.setPriority('1', 'Low'));
      assert.equal(r.ok, false);
      noToken('changes', changes); noToken('logs', logs); noToken('result', r);
    });
  }
  await test('actions report failure on a read-back mismatch, and say so plainly', async () => {
    const m = monday([item('1')]);
    const { s } = makeSync(m);
    await s.start();
    m.ignore = 'columns';
    const r = await s.act((c) => c.setStatus('1', 'Done'));
    assert.deepEqual(r, { ok: false, message: 'monday did not confirm the change. It may not have been made.' });
    m.ignore = 'move';
    const r2 = await s.act((c) => c.setStatus('1', 'Waiting'));
    assert.equal(r2.ok, false);
    m.ignore = null;
    const r3 = await s.act((c) => c.setStatus('1', 'Done'));
    assert.equal(r3.ok, true);
    assert.equal(r3.card.status, 'Done');
    assert.equal(r3.card.group, groups.Done);
  });
  await test('an unexpected error never passes its text on', async () => {
    const m = monday([item('1')]);
    const { s } = makeSync(m);
    await s.start();
    const r = await s.act(async () => { throw new Error(`boom ${TOKEN}`); });
    assert.equal(r.ok, false);
    noToken('result', r);
    assert.equal(sync.plainFailure(new token.MondayError('auth')), 'monday refused the token. Use Reconnect monday... in the tray.');
  });

  const flush = () => new Promise((r) => setImmediate(r));
  /** Run fake time forward to `until`, firing each timer at its due time, and count requests. */
  async function runClock(s, m, clock, t, until) {
    for (;;) {
      const live = t.live();
      if (!live.length) break;
      for (const h of live) if (h.at === null) h.at = clock.t + h.ms;
      const next = live.reduce((a, b) => (a.at <= b.at ? a : b));
      if (next.at >= until) break;
      clock.t = next.at;
      next.live = false;
      next.fn();
      for (let i = 0; i < 6; i++) await flush();
    }
    return m.log.length;
  }
  for (const [label, dow, lo, hi] of [['a weekday', WED, 600, 700], ['a Saturday', SAT, 90, 100]]) {
    await test(`24 h of ticks with no changes on ${label}: ${lo} to ${hi} requests, one per tick, inside the daily cap`, async () => {
      const m = monday([item('1'), item('2', { status: 'Waiting' })]);
      const clock = { t: local(dow, 0, 0) };
      const t = timers();
      const { s } = makeSync(m, clock, t);
      await s.start();
      const calls = await runClock(s, m, clock, t, local(dow, 0, 0) + 86_400_000);
      original.log(`        (${calls} requests in 24 h on ${label}; ${m.log.filter((x) => x.payload.variables.items).length} of them carried the items)`);
      assert.ok(calls >= lo && calls <= hi, String(calls));
      assert.ok(m.log.every((x) => /query Tasks/.test(x.payload.query)), 'a quiet board never needs a second request');
    });
  }
  await test('ticks: 60 s in working hours, 15 min outside, and the quiet night wakes at 07:30', async () => {
    assert.equal(sync.nextTickIn(local(WED, 10)), 60_000);
    assert.equal(sync.nextTickIn(local(WED, 18)), 15 * 60_000);
    assert.equal(sync.nextTickIn(local(WED, 7, 20)), 10 * 60_000);
    assert.equal(sync.nextTickIn(local(SAT, 12)), 15 * 60_000);
  });
  await test('the daily cap: a plain message with the 02:00 reset, and no request until then', async () => {
    const m = monday([item('1')]);
    const clock = { t: NOW };
    const t = timers();
    const { s, changes, logs } = makeSync(m, clock, t);
    await s.start();
    m.mode = 'daily';
    await s.refresh('test');
    assert.equal(changes.at(-1).status.problem, 'daily');
    assert.match(view.syncLabel(changes.at(-1).status, clock.t).text, /daily API limit reached, syncing resumes after 02:00 SAST/);
    const reset = sync.dailyResetAt(NOW);
    assert.equal(new Date(reset).getUTCHours(), 0);
    assert.deepEqual(t.live().map((h) => h.ms), [reset - NOW]);
    const before = m.log.length;
    clock.t = NOW + 3_600_000;
    await s.refresh('manual');
    const r = await s.act((c) => c.setPriority('1', 'Low'));
    assert.equal(m.log.length, before, 'no request while the cap is spent');
    assert.match(r.message, /resets at 02:00 \(SAST\)/);
    m.mode = null;
    clock.t = reset + 1000;
    await s.refresh('after reset');
    assert.equal(changes.at(-1).status.problem, null);
    noToken('logs', logs);
  });
  await test('a refused token stops polling until monday is reconnected', async () => {
    const m = monday([item('1')]);
    const t = timers();
    const { s, changes } = makeSync(m, { t: NOW }, t);
    await s.start();
    m.mode = 'http401';
    await s.refresh('test');
    assert.equal(changes.at(-1).status.problem, 'auth');
    assert.equal(t.live().length, 0, 'nothing scheduled');
    const before = m.log.length;
    await s.refresh('again');
    assert.equal(m.log.length, before);
    m.mode = null;
    await s.connect(token.createMondayToken(TOKEN));
    assert.equal(changes.at(-1).status.problem, null);
    assert.equal(t.live().length, 1);
  });
  await test('a request that never answers ends as "offline" within the timeout (the fake ignores its abort signal)', async () => {
    const m = monday([item('1')]);
    const { s, changes } = makeSync(m, { t: NOW }, timers(), { timeoutMs: 40 });
    await s.start();
    m.mode = 'hang';
    const started = Date.now();
    const r = await s.act((c) => c.setStatus('1', 'Done'));
    assert.ok(Date.now() - started < 2000);
    assert.equal(r.ok, false);
    assert.match(r.message, /did not answer in time/);
    await s.refresh('test');
    assert.equal(changes.at(-1).status.problem, 'offline');
  });
  await test('a paired screen does not poll monday', async () => {
    const m = monday([item('1')]);
    let screen = false;
    const { s } = makeSync(m, { t: NOW }, timers(), { paused: () => screen });
    await s.start();
    const before = m.log.length;
    screen = true;
    await s.refresh('test');
    assert.equal(m.log.length, before);
  });
  await test('a status that changed but did not move says so and resyncs at once', async () => {
    const m = monday([item('1')]);
    const t = timers();
    const { s } = makeSync(m, { t: NOW }, t);
    await s.start();
    m.ignore = 'move';
    const r = await s.act((c) => c.setStatus('1', 'Done'));
    assert.deepEqual(r, { ok: false, message: 'The status changed on monday, but the task was not moved to its column. The board is refreshing.' });
    assert.deepEqual(t.live().map((h) => h.ms), [1000]);
  });
  await test('the log says counts only: never an activity id, a name or a server word', async () => {
    const m = monday([item('1', { owners: [J], assigned: [J], name: 'Secret client name' })]);
    const clock = { t: NOW };
    const { s, logs } = makeSync(m, clock);
    await s.start();
    m.activities = [activity('72', '1', J, O, NOW + 1000), { ...activity('73', '1', J, O, NOW + 1000), id: 'not a valid id!' }];
    clock.t = NOW + 60_000;
    await s.refresh('test');
    assert.match(logs.at(-1), /^\[work\] poll \(test\): activity 1 of 2 parsed, items read, 0 notices, budget 19990000$/);
    assert.ok(!logs.join('\n').includes('5610e651') && !logs.join('\n').includes('Secret'));
  });

  // ── The toast window's arbiter ───────────────────────────────────────────
  original.log('\ntoast arbiter');
  const { createToastArbiter } = await load('src/main/toast-arbiter.ts');
  await test('a work notice waits for a chat notice that is up, never cutting it off', async () => {
    const a = createToastArbiter();
    assert.equal(a.chat('Laptop'), 'show');
    assert.equal(a.work(), 'wait');
    assert.equal(a.workHeld(), false);
    assert.equal(a.chatEnded(), 'work');
    assert.equal(a.workHeld(), true);
  });
  await test('chat during a work notice is deferred with a count per sender, and shown after it', async () => {
    const a = createToastArbiter();
    assert.equal(a.work(), 'now');
    assert.equal(a.chat('Laptop'), 'defer');
    assert.equal(a.chat('Laptop'), 'defer');
    assert.equal(a.chat('Office PC'), 'defer');
    assert.deepEqual(a.workReleased(), [['Laptop', 2], ['Office PC', 1]]);
    assert.deepEqual(a.workReleased(), []);
    assert.equal(a.chat('Laptop'), 'show');
  });

  // ── The IPC, the Connect dialog and the toast, end to end on a fake monday ──
  original.log('\nIPC, Connect dialog and notices (planted token)');

  const wall = new FakeWindow({});
  const toastWin = new FakeWindow({});
  const host = {
    isDev: false, screen: false, focus: false, mode: [], released: 0, clock: local(WED, 10),
    walls: () => [wall], isScreen: () => host.screen, focusMode: () => host.focus,
    setMode: (m2) => host.mode.push(m2), showWall: () => undefined, lendFocus: () => true,
    refreshTray: () => undefined, balloon: (a, b) => output.push(`balloon: ${a} ${b}`),
    toast: { show: (_w, _h, ready) => ready(toastWin), release: () => { host.released++; } },
    timeoutMs: 250, doneLimitMs: 200, noticeMs: 300,
    now: () => host.clock,
  };
  const jacos = ['3', '4', '5'].map((n) => item(n, { owners: [J], assigned: [J], name: `Jaco task ${n}` }));
  const m = monday([item('1', { owners: [J], assigned: [J], name: 'Lodge quote' }), item('2', { status: 'Waiting' }), ...jacos]);
  fetchImpl = (url, init) => m.fetch(url, init);
  const controller = work.createWork(host);
  const ipc = (channel, sender, ...args) => handlers.get(channel)({ sender }, ...args);
  const replies = [];
  const call = async (channel, sender, ...args) => {
    const r = await ipc(channel, sender, ...args);
    replies.push([channel, r]);
    return r;
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  await test('every Work channel is registered, and only these', async () => {
    assert.deepEqual([...handlers.keys()].sort(), [
      'connect:close', 'connect:submit', 'toast:workAction', 'work:action', 'work:connect',
      'work:create', 'work:focus', 'work:get', 'work:open',
    ]);
  });
  await test('before a token: loading until the store is read, then not connected', async () => {
    assert.equal(await call('work:get', wall.webContents), null, 'no false "not connected" before the token is looked at');
    controller.start();
    await settle();
    const p = await call('work:get', wall.webContents);
    assert.equal(p.status.connected, false);
  });
  let connectWin;
  await test('Connect: only the Connect window may submit a token; a wrong user or a refused token is not saved', async () => {
    assert.deepEqual(await call('connect:submit', wall.webContents, TOKEN), { ok: false, message: 'Not available here.' });
    await call('work:connect', wall.webContents);
    connectWin = windows.at(-1);
    assert.match(connectWin.loaded, /connect\.html$/);
    m.me = '555';
    const other = await call('connect:submit', connectWin.webContents, TOKEN);
    assert.equal(other.ok, false);
    assert.match(other.message, /another monday user/);
    m.me = G;
    m.mode = 'http401';
    const refusedToken = await call('connect:submit', connectWin.webContents, TOKEN);
    assert.equal(refusedToken.ok, false);
    assert.match(refusedToken.message, /did not accept/);
    m.mode = null;
    assert.equal((await call('connect:submit', connectWin.webContents, `${TOKEN} with spaces`)).ok, false);
    await assert.rejects(fs.access(path.join(tmp, 'monday-token.bin')));
  });
  await test('Connect: a good token is checked, stored encrypted, and the board syncs', async () => {
    const r = await call('connect:submit', connectWin.webContents, `  ${TOKEN}  `);
    assert.deepEqual(r, { ok: true, message: 'Connected.' });
    await settle();
    const bytes = await fs.readFile(path.join(tmp, 'monday-token.bin'));
    assert.ok(!bytes.includes(Buffer.from(TOKEN)));
    const p = await call('work:get', wall.webContents);
    assert.equal(p.status.connected, true);
    assert.equal(p.tasks.columns.waiting.length, 1);
  });
  await test('IPC from anything but a wall is refused; bad action shapes never reach monday', async () => {
    const stranger = fakeWebContents();
    assert.equal(await call('work:get', stranger), null);
    assert.deepEqual(await call('work:action', stranger, '1', { kind: 'status', value: 'Done' }), { ok: false, message: 'Not available here.' });
    const before = m.log.length;
    for (const [id, action] of [['1;drop', { kind: 'status', value: 'Done' }], ['1', { kind: 'status', value: 'Archived' }], ['1', { kind: 'due', value: 'tomorrow' }], ['1', { kind: 'comment', value: '  ' }], ['1', { kind: 'eval', value: 'x' }], ['1', null]]) {
      const r = await call('work:action', wall.webContents, id, action);
      assert.equal(r.ok, false);
    }
    assert.equal(m.log.length, before);
  });
  await test('Open in monday opens only the task URL built from the id', async () => {
    assert.equal(await call('work:open', wall.webContents, '2'), true);
    assert.equal(await call('work:open', wall.webContents, 'https://evil.example'), false);
    assert.equal(await call('work:open', wall.webContents, '2/../../x'), false);
    assert.deepEqual(opened, ['https://pickleplaysouthafrica-squad.monday.com/boards/5106174674/pulses/2']);
  });
  await test('a wall action returns the read-back card; a mismatch is a failure', async () => {
    const r = await call('work:action', wall.webContents, '2', { kind: 'status', value: 'In progress' });
    assert.equal(r.ok, true);
    assert.equal(r.card.status, 'In progress');
    m.ignore = 'columns';
    const bad = await call('work:action', wall.webContents, '2', { kind: 'priority', value: 'High' });
    assert.equal(bad.ok, false);
    m.ignore = null;
    const created = await call('work:create', wall.webContents, { name: 'New one', priority: 'Low', due: '2026-11-10' });
    assert.equal(created.ok, true);
    assert.equal(created.card.status, 'Not started');
    assert.equal((await call('work:create', wall.webContents, { name: '' })).ok, false);
    assert.equal((await call('work:create', wall.webContents, { name: 'x', due: 'soon' })).ok, false);
  });
  await test('a paired screen gets no Work data and cannot act', async () => {
    host.screen = true;
    assert.equal(await call('work:get', wall.webContents), null);
    assert.deepEqual(await call('work:action', wall.webContents, '2', { kind: 'status', value: 'Done' }), { ok: false, message: 'Not available here.' });
    host.screen = false;
  });
  let notice;
  await test('Jaco assigning a task puts a work notice in the toast: words only, no task id', async () => {
    m.rows[0] = item('1', { owners: [G], assigned: [J], name: 'Lodge quote' });
    m.activities = [activity('71', '1', J, O, host.clock + 1)];
    host.clock += 60_000;
    await ipc('work:action', wall.webContents, '2', { kind: 'due', value: '2026-11-12' });
    // The action scheduled a sync; run one now rather than wait 10 s.
    await controller.refresh();
    await settle();
    notice = toastWin.webContents.sent.filter(([c]) => c === 'toast:work').at(-1)?.[1];
    assert.ok(notice, 'a notice was sent');
    assert.deepEqual(Object.keys(notice).sort(), ['canDone', 'count', 'from', 'id', 'label', 'title']);
    assert.equal(notice.from, 'Jaco');
    assert.equal(notice.title, 'Lodge quote');
  });
  await test('the toast\'s Done marks the task done through monday; only the toast may press it', async () => {
    assert.equal((await call('toast:workAction', wall.webContents, notice.id, 'done')).ok, false);
    const r = await call('toast:workAction', toastWin.webContents, notice.id, 'done');
    assert.deepEqual(r, { ok: true, message: 'Marked done.' });
    assert.equal(column(m.rows[0], S).text, 'Done');
    assert.ok(wall.webContents.sent.some(([c, v]) => c === 'work:card' && v.id === '1' && v.status === 'Done'));
    assert.equal((await call('toast:workAction', toastWin.webContents, notice.id + 99, 'done')).ok, false);
  });
  /** Jaco hands Gustav task `n`; the next poll sees it. */
  const assign = async (n, activityId) => {
    const i = m.rows.findIndex((r) => r.id === n);
    m.rows[i] = item(n, { owners: [G], assigned: [J], name: `Jaco task ${n}` });
    m.activities = [activity(activityId, n, J, O, host.clock + 1)];
    host.clock += 60_000;
    await controller.refresh();
    await settle();
  };
  await test('a stalled Done ends in a failure state, and notices behind it collapse into one (the queue cannot grow)', async () => {
    await new Promise((r) => setTimeout(r, 400)); // the last notice has gone
    await assign('3', '80');
    const first = toastWin.webContents.sent.filter(([c]) => c === 'toast:work').at(-1)[1];
    assert.equal(first.title, 'Jaco task 3');
    m.mode = 'hangWrites';
    const pressed = ipc('toast:workAction', toastWin.webContents, first.id, 'done');
    await settle();
    assert.deepEqual(controller.noticeState(), { up: true, busy: true, queued: 0 });
    await assign('4', '81');
    await assign('5', '82');
    assert.deepEqual(controller.noticeState(), { up: true, busy: true, queued: 2 }, 'two notices, one queued entry');
    const r = await pressed;
    replies.push(['toast:workAction', r]);
    assert.equal(r.ok, false);
    assert.match(r.message, /has not answered yet|did not answer in time/);
    m.mode = null;
    await new Promise((res) => setTimeout(res, 450));
    const last = toastWin.webContents.sent.filter(([c]) => c === 'toast:work').at(-1)[1];
    assert.equal(last.count, 2);
    assert.equal(last.label, 'monday · 2 task updates');
    assert.equal(last.canDone, false);
    assert.equal(controller.noticeState().queued, 0);
  });
  await test('a refused token offers Reconnect monday..., and a new token replaces it and syncing resumes', async () => {
    const labels = () => controller.trayItems('work').map((i) => i.label);
    assert.ok(!labels().includes('Reconnect monday...'));
    m.mode = 'http401';
    host.clock += 60_000;
    await controller.refresh();
    const p = await call('work:get', wall.webContents);
    assert.equal(p.status.problem, 'auth');
    assert.match(view.syncLabel(p.status, host.clock).text, /use Reconnect monday in the tray/);
    assert.match((await call('work:action', wall.webContents, '2', { kind: 'priority', value: 'Low' })).message, /Use Reconnect monday\.\.\. in the tray/);
    assert.deepEqual(labels().slice(1), ['Reconnect monday...', 'Disconnect monday']);
    connectWin.close();
    controller.trayItems('work').find((i) => i.label === 'Reconnect monday...').click();
    const again = windows.at(-1);
    assert.ok(again !== connectWin && /connect\.html$/.test(again.loaded), 'Reconnect opens the Connect dialog');
    m.mode = null;
    const r = await call('connect:submit', again.webContents, TOKEN);
    assert.deepEqual(r, { ok: true, message: 'Connected.' });
    await settle();
    const after = await call('work:get', wall.webContents);
    assert.deepEqual([after.status.connected, after.status.problem], [true, null]);
    assert.deepEqual(labels().slice(1), ['Disconnect monday']);
  });
  await test('Disconnect deletes the token and tells the wall', async () => {
    const item0 = controller.trayItems('work').find((i) => i.label === 'Disconnect monday');
    assert.ok(item0);
    item0.click();
    await settle();
    await assert.rejects(fs.access(path.join(tmp, 'monday-token.bin')));
    assert.equal((await call('work:get', wall.webContents)).status.connected, false);
    assert.ok(controller.trayItems('work').some((i) => i.label === 'Connect monday...'));
  });
  await test('THE TOKEN: in no IPC reply, push, toast, log line, error or file', async () => {
    for (const [channel, r] of replies) noToken(`reply ${channel}`, r);
    for (const w of windows) noToken('pushes', w.webContents.sent);
    noToken('log', output.join('\n'));
    for (const f of await fs.readdir(tmp)) {
      const bytes = await fs.readFile(path.join(tmp, f)).catch(() => Buffer.alloc(0));
      assert.ok(!bytes.includes(Buffer.from(TOKEN)), `${f} holds the token in plain text`);
    }
    // The token did go to monday, in the Authorization header and only there.
    assert.ok(m.log.length > 5);
    for (const entry of m.log) {
      const safe = structuredClone({ url: entry.url, body: entry.init.body, headers: { ...entry.init.headers, Authorization: undefined } });
      noToken('request outside the header', safe);
    }
  });
  controller.stop();

  // ── Local days ────────────────────────────────────────────────────────────
  original.log('\nlocal days (TZ=Africa/Johannesburg, 00:30 local)');
  await test('at 00:30 in Johannesburg, today is the local day: due today is not overdue, the week starts on the local Monday', async () => {
    const out = path.join(tmp, 'work-view.cjs');
    await esbuild.build({ entryPoints: [path.join(root, 'src/shared/work-view.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
    const script = path.join(tmp, 'tz-probe.cjs');
    await fs.writeFile(script, `
      const v = require(${JSON.stringify(out)});
      const at = '2026-11-05T22:30:00.000Z'; // Friday 6 Nov, 00:30 SAST
      const card = (id, status, due, updatedAt) => ({ id, name: id, group: 'topics', status, priority: null, due, ownerIds: ['119615221'], assignedByIds: [], project: null, updatedAt: updatedAt || at });
      const cols = {
        inProgress: [card('a', 'In progress', '2026-11-06'), card('b', 'In progress', '2026-11-05')],
        waiting: [], backlog: [],
        done: [card('c', 'Done', null, '2026-11-01T22:30:00.000Z')], // Monday 2 Nov, 00:30 SAST
      };
      const s = v.summarize(cols, at);
      console.log(JSON.stringify({ tz: process.env.TZ, hour: new Date(at).getHours(), today: v.localDay(Date.parse(at)),
        overdueA: v.isOverdue(cols.inProgress[0], at), overdueB: v.isOverdue(cols.inProgress[1], at),
        overdue: s.overdue, dueThisWeek: s.dueThisWeek, doneThisWeek: s.doneThisWeek }));
    `);
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [script], { env: { ...process.env, TZ: 'Africa/Johannesburg' }, encoding: 'utf8' });
    const got = JSON.parse(r.stdout.trim());
    assert.deepEqual(got, { tz: 'Africa/Johannesburg', hour: 0, today: '2026-11-06', overdueA: false, overdueB: true, overdue: 1, dueThisWeek: 1, doneThisWeek: 1 });
  });

  // ── The projection wire ───────────────────────────────────────────────────
  original.log('\nnever projected');
  await test('toWire drops every Work field and the token, whatever the index carries', async () => {
    const out = path.join(tmp, 'wire.cjs');
    await esbuild.build({ entryPoints: [path.join(root, 'src/shared/projection-wire.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
    const { toWire } = require(out);
    const payload = { status: { connected: true, syncing: false, syncedAt: null, problem: null }, tasks: { at: 'x', columns: { inProgress: [card('1', null)] } } };
    const index = { totals: {}, projects: {}, sessions: {}, work: payload, tasks: payload.tasks, monday: { token: TOKEN }, mondayToken: TOKEN, workPayload: payload };
    const wire = toWire(index, { shareProjectNames: true, sourceLabel: 'PC', indexing: false });
    const text = JSON.stringify(wire);
    noToken('wire frame', text);
    for (const k of ['"work"', '"tasks"', '"monday"', '"mondayToken"', '"workPayload"', '"inProgress"', 'T1']) assert.ok(!text.includes(k), `wire carries ${k}`);
  });

  // ── The editions ──────────────────────────────────────────────────────────
  original.log('\neditions');
  const bundle = async (entry, edition, platform) => {
    const out = path.join(tmp, `${edition}-${path.basename(entry, '.ts')}-${platform}.js`);
    await esbuild.build({
      entryPoints: [path.join(root, entry)], outfile: out, bundle: true, minify: true, logLevel: 'error',
      platform, format: platform === 'node' ? 'cjs' : 'iife', target: platform === 'node' ? 'node20' : 'chrome120',
      external: ['electron', 'koffi', 'chokidar', 'fsevents'], define: { 'process.env.MBW_EDITION': JSON.stringify(edition) },
    });
    return fs.readFile(out, 'utf8');
  };
  const MARKERS = ['work:get', 'work:action', 'work:create', 'work:open', 'work:focus', 'work:connect', 'work:update', 'connect:submit', 'toast:workAction', 'mondayConnect', 'api.monday.com', 'monday'];
  const entries = [['src/main/index.ts', 'node'], ['src/preload/index.ts', 'node'], ['src/renderer/main.ts', 'browser'], ['src/renderer/toast.ts', 'browser']];
  const built = {};
  for (const edition of ['stats', 'full']) {
    built[edition] = {};
    for (const [entry, platform] of entries) built[edition][entry] = await bundle(entry, edition, platform);
  }
  await test('stats build: no Work IPC channel, preload member, monday code or token handling in any bundle', async () => {
    for (const [entry] of entries) {
      for (const marker of MARKERS) assert.ok(!built.stats[entry].includes(marker), `stats ${entry} contains ${marker}`);
    }
    assert.ok(!built.stats['src/main/index.ts'].includes('monday-token.bin'));
  });
  await test('full build: the same markers are present (so the stats check is not vacuous)', async () => {
    assert.ok(built.full['src/main/index.ts'].includes('work:get') && built.full['src/main/index.ts'].includes('api.monday.com'));
    assert.ok(built.full['src/preload/index.ts'].includes('work:get') && built.full['src/preload/index.ts'].includes('mondayConnect'));
    assert.ok(built.full['src/renderer/main.ts'].includes('monday'));
    assert.ok(built.full['src/renderer/toast.ts'].includes('toast:work') || built.full['src/preload/index.ts'].includes('toast:work'));
  });
} finally {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
  const relative = path.relative(os.tmpdir(), tmp);
  if (relative.startsWith('mbw-work-') && !relative.includes(path.sep)) await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
