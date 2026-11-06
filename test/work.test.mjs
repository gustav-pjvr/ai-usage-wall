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
import { graphMessage, imapMessage, imapServer, microsoft } from './fixtures/mail-fakes.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mbw-work-'));
const require = createRequire(import.meta.url);
const TOKEN = 'planted-monday-token-MUST-NOT-LEAK-7f3a';
// Mail (phase 2): a planted IMAP password and planted Microsoft tokens, searched for like the monday token.
const PASSWORD = 'planted-imap-app-password-MUST-NOT-LEAK-c2d9';
const ACCESS = 'planted-graph-access-token-MUST-NOT-LEAK-5e1b';
const REFRESH = 'planted-graph-refresh-token-MUST-NOT-LEAK-8a40';
const MS_CODE = 'planted.graph-code_MUST-NOT-LEAK';
const MAIL_SECRETS = [PASSWORD, ACCESS, REFRESH, MS_CODE];
/** What the system browser does with a URL main opens (the Microsoft sign-in, in the mail tests). */
let browserHook = null;
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
  shell: { openExternal: async (url) => { opened.push(url); if (browserHook && url.startsWith('https://login.microsoftonline.com/')) browserHook(url); } },
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
  catch (error) {
    failed++;
    let text = String(error?.stack ?? error).replaceAll(TOKEN, '[redacted]');
    for (const sec of MAIL_SECRETS) text = text.replaceAll(sec, '[redacted]');
    original.log(`  FAIL  ${name}: ${text}`);
  }
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
      // A new id per item, as monday gives (Make a task from a mail is the second create in a run).
      const id = String(901 + state.rows.filter((r) => Number(r.id) >= 901).length);
      state.rows.push(item(id, { name: v.name, priority: values[P]?.label, due: values[D]?.date }));
      data = { create_item: { id } };
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
  const mailView = await load('src/shared/mail-view.ts');
  await load('src/main/work/mail-text.ts');
  const mailAccounts = await load('src/main/work/mail-accounts.ts');
  const imapMod = await load('src/main/work/imap.ts');
  const graphMod = await load('src/main/work/graph.ts');
  const mailMod = await load('src/main/work/mail.ts');
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
  // ── Mail notice rules (design section 3, Gustav's decisions) ──────────────
  original.log('\nmail notice rules (injected clock)');
  const mev = (n, o = {}) => ({ kind: 'person', account: 'gmail', handle: `h${n}`, fromName: `Sender ${n}`, fromAddress: `s${n}@example.com`, subject: `Subject ${n}`, key: `gmail:10:${n}`, ...o });
  const mailNotifier = (clock, o = {}) => {
    const shown = [], saved = [], held = [];
    const n = notify.createMailNotifier({
      now: () => clock, focus: () => !!o.focus, vip: () => o.vip ?? ['jaco@example.com'],
      label: (id) => (id === 'gmail' ? 'Gmail' : 'Mail'), state: o.state ?? notify.emptyMailNoticeState(),
      save: (st) => saved.push(st), show: (x) => shown.push(x), hold: (c) => held.push(c),
    });
    return { n, shown, saved, held };
  };
  await test('new mail from a person in working hours: one notice with the sender and the subject, Mark read offered', () => {
    const t = mailNotifier(local(WED, 10));
    t.n.events([mev(1)]);
    assert.equal(t.shown.length, 1);
    const x = t.shown[0];
    assert.deepEqual([x.kind, x.label, x.from, x.title, x.count, x.canDone, x.mail.handle, x.taskId], ['mail', 'Gmail · new mail', 'Sender 1', 'Subject 1', 1, true, 'h1', null]);
  });
  await test('bulk mail (List-Unsubscribe, no-reply, Promotions or Social) never notifies and is not held', () => {
    const t = mailNotifier(local(WED, 10));
    t.n.events([mev(1, { kind: 'bulk' }), mev(2, { kind: 'bulk' })]);
    assert.equal(t.shown.length, 0);
    assert.deepEqual(t.held, []);
  });
  await test('the same mail never notifies twice, also after a restart; the saved state holds no address or subject', () => {
    const t = mailNotifier(local(WED, 10));
    t.n.events([mev(1)]);
    t.n.events([mev(1)]);
    assert.equal(t.shown.length, 1);
    const state = t.saved.at(-1);
    assert.ok(state.seen.every((k) => /^[0-9a-f]{32}$/.test(k)));
    assert.ok(!JSON.stringify(state).includes('example.com') && !JSON.stringify(state).includes('Subject'));
    const again = mailNotifier(local(WED, 11), { state: JSON.parse(JSON.stringify(state)) });
    again.n.events([mev(1)]);
    assert.equal(again.shown.length, 0);
  });
  await test('quiet hours and weekends: only VIP senders get through (any case), the rest are held for the morning', () => {
    for (const at of [local(WED, 19), local(WED, 7, 29), local(SAT, 12)]) {
      const t = mailNotifier(at);
      t.n.events([mev(1), mev(2, { fromAddress: 'Jaco@Example.com', fromName: 'Jaco' })]);
      assert.equal(t.shown.length, 1);
      assert.equal(t.shown[0].from, 'Jaco');
      assert.deepEqual(t.held, [1]);
    }
    const day = mailNotifier(local(WED, 7, 30));
    day.n.events([mev(1)]);
    assert.equal(day.shown.length, 1, '07:30 on a weekday is not quiet');
  });
  await test('focus mode: nothing is shown (VIPs neither), it is counted for the morning, and it does not come back', () => {
    const t = mailNotifier(local(WED, 10), { focus: true });
    t.n.events([mev(1), mev(2, { fromAddress: 'jaco@example.com' })]);
    assert.equal(t.shown.length, 0);
    assert.deepEqual(t.held, [2]);
    const after = mailNotifier(local(WED, 11), { state: t.saved.at(-1) });
    after.n.events([mev(1), mev(2)]);
    assert.equal(after.shown.length, 0);
  });
  await test('a burst of new mail is one notice with a count and no Mark read', () => {
    const t = mailNotifier(local(WED, 10));
    t.n.events([mev(1), mev(2), mev(3)]);
    assert.equal(t.shown.length, 1);
    const x = t.shown[0];
    assert.deepEqual([x.kind, x.label, x.count, x.canDone, x.from, x.title], ['burst', 'Mail · 3 new', 3, false, 'Sender 3 and others', 'Subject 3']);
  });
  await test('mail held by quiet hours counts into the task morning summary', () => {
    const saved = [];
    const tasks = notify.createWorkNotifier({ now: () => local(WED, 8, 5), focus: () => false, state: notify.emptyNotifierState(), save: (st) => saved.push(st), show: () => undefined });
    tasks.hold(2);
    assert.equal(tasks.snapshot().held, 2);
    tasks.hold(-1);
    tasks.hold(1.5);
    assert.equal(tasks.snapshot().held, 2);
  });
  await test('the VIP list keeps plain addresses only, lower-cased', () => {
    assert.deepEqual(notify.cleanVipList(['Jaco@Example.com', 'not an address', 42, 'a@b.co', 'a@b.co']), ['jaco@example.com', 'a@b.co']);
    assert.deepEqual(notify.cleanVipList('jaco@example.com'), []);
  });

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
  await test('mail center: a start overtaken by a suspend starts nothing; overlapping starts make one provider; a restart replaces it', async () => {
    const make = () => {
      const providers = [];
      let release;
      const gate = new Promise((r) => { release = r; });
      const provider = () => {
        const p = { started: 0, stopped: 0, start() { p.started++; }, stop() { p.stopped++; } };
        providers.push(p);
        return p;
      };
      const center = mailMod.createMailCenter({
        now: () => 0,
        imap: { load: async (id) => { await gate; return id === 'gmail' ? { account: { id: 'gmail' }, credential: {} } : null; }, save: async () => undefined, remove: async () => undefined },
        graph: { load: async () => null, signIn: async () => { throw new Error('no'); }, cancel() {}, remove: async () => undefined },
        makeImap: provider, makeGraph: provider, onChange: () => undefined, onEvents: () => undefined,
      });
      return { center, providers, release };
    };
    const a = make();
    const starting = a.center.start();
    a.center.suspend();
    a.release();
    await starting;
    assert.equal(a.providers.length, 0, 'nothing starts after the machine became a screen');
    assert.deepEqual(a.center.payload().accounts, []);
    const b = make();
    const both = Promise.all([b.center.start(), b.center.start()]);
    b.release();
    await both;
    assert.equal(b.providers.length, 1, 'one provider for one account, however many starts overlapped');
    await b.center.start();
    assert.equal(b.providers.length, 2);
    assert.equal(b.providers[0].stopped, 1, 'the replaced provider was stopped');
    assert.equal(b.providers[1].stopped, 0);
  });

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
    mailVip: () => [],
    imapClient: (options) => imap.factory(options),
    signInMs: 4000,
  };
  const jacos = ['3', '4', '5'].map((n) => item(n, { owners: [J], assigned: [J], name: `Jaco task ${n}` }));
  const m = monday([item('1', { owners: [J], assigned: [J], name: 'Lodge quote' }), item('2', { status: 'Waiting' }), ...jacos]);
  // A fake IMAP server and a fake Microsoft; monday's requests still go to the fake monday.
  const imap = imapServer(PASSWORD, [imapMessage(1), imapMessage(2, { body: '<p>Second</p>' })]);
  const ms = microsoft({ tenant: graphMod.TENANT_ID, clientId: graphMod.CLIENT_ID, access: ACCESS, refresh: REFRESH, code: MS_CODE, messages: [graphMessage(1)] });
  fetchImpl = (url, init) => (url.startsWith('https://api.monday.com/') ? m.fetch(url, init) : ms.fetch(url, init));
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
      'connect:close', 'connect:submit',
      'mail:action', 'mail:connect', 'mail:get', 'mail:open', 'mail:task', 'mail:undo', 'mail:web',
      'mailconnect:cancel', 'mailconnect:close', 'mailconnect:microsoft', 'mailconnect:state', 'mailconnect:submit',
      'toast:workAction', 'work:action', 'work:connect',
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
    assert.deepEqual(Object.keys(notice).sort(), ['canDone', 'count', 'doneLabel', 'from', 'id', 'label', 'title']);
    assert.equal(notice.doneLabel, 'Done');
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
  // ── Mail, end to end on fake servers (planted password and tokens) ──────
  original.log('\nmail: IPC, Connect mail, notices (planted password and tokens)');
  const notHere = { ok: false, message: 'Not available here.' };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  let mailWin;
  await test('mail before any account: known and empty (the panel offers Connect mail)', async () => {
    assert.deepEqual(await call('mail:get', wall.webContents), { known: true, accounts: [], rows: [] });
    assert.equal(await call('mail:get', fakeWebContents()), null);
  });
  await test('Connect mail: only its own window may submit; a wrong password or account is refused and nothing is stored', async () => {
    assert.deepEqual(await call('mailconnect:submit', wall.webContents, 'gmail', PASSWORD), notHere);
    assert.deepEqual(await call('mailconnect:microsoft', wall.webContents), notHere);
    await call('mail:connect', wall.webContents);
    mailWin = windows.at(-1);
    assert.match(mailWin.loaded, /mail-connect\.html$/);
    const bad = await call('mailconnect:submit', mailWin.webContents, 'gmail', 'not-the-password');
    assert.equal(bad.ok, false);
    assert.match(bad.message, /did not accept that app password/);
    for (const preset of ['m365', 'titan', '../x', null]) assert.equal((await call('mailconnect:submit', mailWin.webContents, preset, PASSWORD)).ok, false);
    assert.equal((await call('mailconnect:submit', mailWin.webContents, 'gmail', 'line\nbreak')).ok, false);
    await assert.rejects(fs.access(path.join(tmp, 'mail-accounts', 'gmail.bin')));
  });
  await test('Connect mail: a real IMAP login with the password first, then stored encrypted, and the inbox syncs', async () => {
    const r = await call('mailconnect:submit', mailWin.webContents, 'gmail', PASSWORD);
    assert.deepEqual(r, { ok: true, message: 'Gmail connected.' });
    assert.ok(imap.logins.includes('gustavpjvr@gmail.com'));
    const bytes = await fs.readFile(path.join(tmp, 'mail-accounts', 'gmail.bin'));
    assert.ok(!bytes.includes(Buffer.from(PASSWORD)));
    await settle();
    const p = await call('mail:get', wall.webContents);
    assert.deepEqual(p.accounts.map((a) => [a.id, a.status, a.unread]), [['gmail', 'ready', 2]]);
    assert.deepEqual(p.rows.map((x) => x.subject).sort(), ['Message 1', 'Message 2']);
    const state = await call('mailconnect:state', mailWin.webContents);
    assert.ok(state.find((a) => a.id === 'gmail').connected);
    assert.deepEqual(await call('mailconnect:state', wall.webContents), []);
    assert.ok(wall.webContents.sent.some(([c]) => c === 'mail:update'));
  });
  let row1;
  await test('open: the body is text made in main (no tags, no remote image); a forged handle or a stranger is refused', async () => {
    row1 = (await call('mail:get', wall.webContents)).rows.find((x) => x.subject === 'Message 1');
    const r = await call('mail:open', wall.webContents, row1.handle);
    assert.equal(r.ok, true);
    assert.match(r.body.text, /Body of 1/);
    assert.doesNotMatch(r.body.text, /[<>]|tracker/);
    assert.equal((await call('mail:open', wall.webContents, `${row1.handle}x`)).ok, false);
    assert.deepEqual(await call('mail:open', fakeWebContents(), row1.handle), notHere);
  });
  await test('read and flag read back; unknown kinds never reach the server; trash and archive undo; no deletes', async () => {
    let r = await call('mail:action', wall.webContents, row1.handle, 'read');
    assert.equal(r.ok, true);
    assert.equal(r.row.seen, true);
    r = await call('mail:action', wall.webContents, row1.handle, 'flag');
    assert.equal(r.row.flagged, true);
    const before = imap.calls.length;
    for (const kind of ['delete', 'expunge', 'send', null]) assert.equal((await call('mail:action', wall.webContents, row1.handle, kind)).ok, false);
    assert.equal(imap.calls.length, before);
    for (const kind of ['trash', 'archive']) {
      const live = (await call('mail:get', wall.webContents)).rows.find((x) => x.subject === 'Message 1');
      const a = await call('mail:action', wall.webContents, live.handle, kind);
      assert.equal(a.ok, true);
      assert.match(a.undo, /^[0-9a-f-]{36}$/);
      assert.ok(!(await call('mail:get', wall.webContents)).rows.some((x) => x.handle === live.handle));
      assert.deepEqual(await call('mail:undo', wall.webContents, a.undo), { ok: true });
      assert.equal((await call('mail:undo', wall.webContents, a.undo)).ok, false);
      await settle();
      assert.ok((await call('mail:get', wall.webContents)).rows.some((x) => x.subject === 'Message 1'), `back after ${kind} undo`);
    }
    // Trash undo moves back; archive undo COPIES back to INBOX (Gmail's Inbox label), never a move out of All Mail.
    assert.deepEqual(imap.calls.filter((c) => c[0] === 'move' || c[0] === 'copy'), [
      ['move', 'INBOX', '[Gmail]/Trash'], ['move', '[Gmail]/Trash', 'INBOX'], ['move', 'INBOX', '[Gmail]/All Mail'], ['copy', '[Gmail]/All Mail', 'INBOX'],
    ]);
  });
  await test('Make a task: a Backlog task named after the subject, through monday', async () => {
    const row2 = (await call('mail:get', wall.webContents)).rows.find((x) => x.subject === 'Message 2');
    const r = await call('mail:task', wall.webContents, row2.handle);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.card.name, 'Message 2');
    assert.equal(r.card.status, 'Not started');
    assert.equal((await call('mail:task', wall.webContents, 'forged')).ok, false);
  });
  await test('Open in Gmail opens only Gmail, for that message', async () => {
    const row2 = (await call('mail:get', wall.webContents)).rows.find((x) => x.subject === 'Message 2');
    assert.equal(await call('mail:web', wall.webContents, row2.handle), true);
    assert.equal(opened.at(-1), 'https://mail.google.com/mail/u/?authuser=gustavpjvr%40gmail.com#search/rfc822msgid%3Amail-2%40example.com');
    const count = opened.length;
    assert.equal(await call('mail:web', wall.webContents, 'https://evil.example'), false);
    assert.equal(await call('mail:web', fakeWebContents(), row2.handle), false);
    assert.equal(opened.length, count);
  });
  await test('Microsoft 365: the browser sign-in through the loopback, the token stored encrypted, its inbox joins first', async () => {
    browserHook = (url) => ms.browser(url);
    const r = await call('mailconnect:microsoft', mailWin.webContents);
    browserHook = null;
    assert.deepEqual(r, { ok: true, message: 'MuchBetter connected.' });
    await pause(80);
    const bytes = await fs.readFile(path.join(tmp, 'graph-token.bin'));
    for (const sec of MAIL_SECRETS) assert.ok(!bytes.includes(Buffer.from(sec)));
    const p = await call('mail:get', wall.webContents);
    assert.deepEqual(p.accounts.map((a) => a.id), ['muchbetter', 'gmail']);
    const g = p.rows.find((x) => x.subject === 'Graph subject 1');
    assert.ok(g);
    const a = await call('mail:action', wall.webContents, g.handle, 'archive');
    assert.equal(a.ok, true);
    assert.deepEqual(await call('mail:undo', wall.webContents, a.undo), { ok: true });
    assert.equal([...ms.messages.values()][0].parentFolderId, 'FOLDER-INBOX');
    assert.ok(ms.calls.every((c) => c.method !== 'DELETE'));
  });
  await test('new mail from a person: a toast with the sender and subject (words only), Mark read marks it through IMAP', async () => {
    await pause(350);
    const count = toastWin.webContents.sent.filter(([c]) => c === 'toast:work').length;
    imap.arrive(imapMessage(imap.nextUid++, { envelope: { from: [{ name: 'Anna Client', address: 'anna@client.example' }], subject: 'Homepage copy, second round', date: new Date(), messageId: '<new-1@client.example>' } }));
    await pause(80);
    const sent = toastWin.webContents.sent.filter(([c]) => c === 'toast:work');
    assert.equal(sent.length, count + 1);
    const n = sent.at(-1)[1];
    assert.deepEqual(Object.keys(n).sort(), ['canDone', 'count', 'doneLabel', 'from', 'id', 'label', 'title']);
    assert.deepEqual([n.label, n.from, n.title, n.doneLabel, n.canDone], ['Gmail · new mail', 'Anna Client', 'Homepage copy, second round', 'Mark read', true]);
    assert.equal((await call('toast:workAction', wall.webContents, n.id, 'done')).ok, false, 'only the toast may press it');
    assert.deepEqual(await call('toast:workAction', toastWin.webContents, n.id, 'done'), { ok: true, message: 'Marked read.' });
    const arrived = imap.boxes.get('INBOX').rows.find((x) => x.envelope.subject === 'Homepage copy, second round');
    assert.ok(arrived.flags.has('\\Seen'));
  });
  await test('Show switches to Work and opens that mail; bulk mail never shows a notice', async () => {
    await pause(350);
    imap.arrive(imapMessage(imap.nextUid++, { envelope: { from: [{ name: 'Jaco', address: 'jaco@example.com' }], subject: 'Quote numbers', date: new Date(), messageId: '<new-2@example.com>' } }));
    await pause(80);
    const n = toastWin.webContents.sent.filter(([c]) => c === 'toast:work').at(-1)[1];
    assert.equal(n.title, 'Quote numbers');
    await call('toast:workAction', toastWin.webContents, n.id, 'show');
    assert.equal(host.mode.at(-1), 'work');
    const hl = wall.webContents.sent.filter(([c]) => c === 'mail:highlight').at(-1);
    const row = (await call('mail:get', wall.webContents)).rows.find((x) => x.subject === 'Quote numbers');
    assert.equal(hl[1], row.handle);
    await pause(350);
    const count = toastWin.webContents.sent.filter(([c]) => c === 'toast:work').length;
    imap.arrive(imapMessage(imap.nextUid++, { headers: Buffer.from('List-Unsubscribe: <mailto:off@shop.example>\r\n') }));
    imap.arrive(imapMessage(imap.nextUid++, { envelope: { from: [{ name: 'Shop', address: 'no-reply@shop.example' }], subject: 'Sale', date: new Date(), messageId: '<s@shop.example>' } }));
    await pause(80);
    assert.equal(toastWin.webContents.sent.filter(([c]) => c === 'toast:work').length, count);
  });
  await test('the tray offers Connect mail and, per account, Reconnect and Disconnect, with no address in a label', async () => {
    const items = controller.trayItems('work');
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes('Connect mail...'));
    for (const l of ['MuchBetter mail', 'Gmail mail']) {
      const it = items.find((i) => i.label === l);
      assert.ok(it, l);
      assert.deepEqual(it.submenu.map((s) => s.label), ['Reconnect...', 'Disconnect']);
    }
    assert.ok(!JSON.stringify(labels).includes('@'));
  });
  await test('becoming a paired screen stops every mail account; unpairing starts them again', async () => {
    host.screen = true;
    controller.screenChanged();
    assert.ok(imap.clients.every((c) => c.closed), 'every IMAP connection is closed');
    assert.equal(await call('mail:get', wall.webContents), null);
    const before = imap.logins.length;
    const graphBefore = ms.calls.length;
    imap.arrive(imapMessage(imap.nextUid++));
    await pause(80);
    assert.equal(imap.logins.length, before, 'no reconnect while a screen');
    assert.equal(ms.calls.length, graphBefore, 'no Graph request while a screen');
    host.screen = false;
    controller.screenChanged();
    await pause(200);
    assert.ok(imap.logins.length > before, 'Gmail signs in again');
    assert.deepEqual((await call('mail:get', wall.webContents)).accounts.map((a) => a.id), ['muchbetter', 'gmail']);
  });
  await test('a paired screen gets no mail and cannot act on it', async () => {
    host.screen = true;
    const row2 = (() => null)();
    void row2;
    assert.equal(await call('mail:get', wall.webContents), null);
    assert.deepEqual(await call('mail:action', wall.webContents, row1.handle, 'read'), notHere);
    assert.deepEqual(await call('mail:open', wall.webContents, row1.handle), notHere);
    assert.equal(await call('mail:web', wall.webContents, row1.handle), false);
    host.screen = false;
  });
  await test('Disconnect deletes the stored password and the Microsoft sign-in', async () => {
    for (const l of ['Gmail mail', 'MuchBetter mail']) {
      controller.trayItems('work').find((i) => i.label === l).submenu.find((s) => s.label === 'Disconnect').click();
      await settle();
    }
    await assert.rejects(fs.access(path.join(tmp, 'mail-accounts', 'gmail.bin')));
    await assert.rejects(fs.access(path.join(tmp, 'graph-token.bin')));
    assert.deepEqual((await call('mail:get', wall.webContents)).accounts, []);
  });
  await test('THE MAIL SECRETS: the password and tokens are in no IPC reply, push, toast, log line or file in plain text', async () => {
    const hide = (label, value) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      for (const sec of MAIL_SECRETS) assert.ok(!String(text).includes(sec), `${label} holds a planted mail secret`);
    };
    for (const [channel, r] of replies) hide(`reply ${channel}`, r);
    for (const w of windows) hide('pushes', w.webContents.sent);
    hide('log', output.join('\n'));
    const walk = async (dir) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) await walk(f);
        else {
          const bytes = await fs.readFile(f);
          for (const sec of MAIL_SECRETS) assert.ok(!bytes.includes(Buffer.from(sec)), `${f} holds a mail secret in plain text`);
        }
      }
    };
    await walk(tmp);
    // The password went to the IMAP login, and the tokens to Microsoft, and only there.
    assert.ok(imap.clients.some((c) => c.options.auth.pass === PASSWORD));
    for (const c of ms.calls) hide('a Graph request body', c.body && !/oauth2/.test(c.url) ? c.body : '');
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
    assert.deepEqual(labels().slice(1).filter((l) => /monday/.test(l)), ['Reconnect monday...', 'Disconnect monday']);
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
    assert.deepEqual(labels().slice(1).filter((l) => /monday/.test(l)), ['Disconnect monday']);
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

  await test('toWire drops every mail field, password and token, whatever the index carries', async () => {
    const { toWire } = require(path.join(tmp, 'wire.cjs'));
    const mailPayload = { known: true, accounts: [{ id: 'gmail', label: 'Gmail', colour: '#e8574f', unread: 2, status: 'ready', syncedAt: null }], rows: [{ account: 'gmail', handle: 'H1', fromName: 'Anna', fromAddress: 'anna@client.example', subject: 'Quote', snippet: '', date: '2026-11-06T09:00:00Z', seen: false, flagged: false, bulk: false }] };
    const index = { totals: {}, projects: {}, sessions: {}, mail: mailPayload, inbox: mailPayload.rows, mailPassword: PASSWORD, graphToken: ACCESS, graphRefresh: REFRESH };
    const text = JSON.stringify(toWire(index, { shareProjectNames: true, sourceLabel: 'PC', indexing: false }));
    for (const sec of MAIL_SECRETS) assert.ok(!text.includes(sec));
    for (const k of ['"mail"', '"inbox"', 'anna@client.example', 'Quote', 'mailPassword', 'graphToken']) assert.ok(!text.includes(k), `wire carries ${k}`);
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
  const MARKERS = ['work:get', 'work:action', 'work:create', 'work:open', 'work:focus', 'work:connect', 'work:update', 'connect:submit', 'toast:workAction', 'mondayConnect', 'api.monday.com', 'monday',
    // Mail (phase 2): the IPC, the Connect mail bridge, the IMAP and Graph code, the accounts.
    'mail:get', 'mail:action', 'mail:open', 'mail:undo', 'mail:update', 'mailconnect:', 'mailConnect', 'imapflow', 'ImapFlow', 'imap.gmail.com', 'imap.secureserver.net',
    'graph.microsoft.com', 'login.microsoftonline.com', 'graph-token.bin', 'mail-accounts', 'jacojvr', 'gustav@muchbetter.world', 'pickleplaysouthafrica.org'];
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
    for (const marker of ['mail:get', 'mailconnect:', 'imap.gmail.com', 'graph.microsoft.com', 'login.microsoftonline.com', 'ImapFlow', 'graph-token.bin']) {
      assert.ok(built.full['src/main/index.ts'].includes(marker), `full main has ${marker}`);
    }
    assert.ok(built.full['src/preload/index.ts'].includes('mail:get') && built.full['src/preload/index.ts'].includes('mailConnect'));
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
