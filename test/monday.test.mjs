import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mbw-monday-'));
const require = createRequire(import.meta.url);
const TOKEN = 'test-only-monday-credential-DO-NOT-LEAK';
const key = randomBytes(32);
let encryption = true;
let cryptoError = false;
let storagePath = tmp;
const electron = {
  app: { getPath: () => storagePath },
  safeStorage: {
    isEncryptionAvailable: () => encryption,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) {
      if (cryptoError) throw new Error(TOKEN);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      if (cryptoError) throw new Error(TOKEN);
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  },
};

// The installed TS compiler runs in-process, so this suite needs no esbuild child
// process. Only Electron is stubbed; storage uses the real temporary filesystem.
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
      assert.ok(dependency, 'load the local dependency first');
      return dependency;
    }
    return require(name);
  };
  runInThisContext(`(function(require, module, exports) { ${compiled}\n})`, { filename })(localRequire, module, module.exports);
  cache.set(filename, module.exports);
  return module.exports;
}

let passed = 0;
let failed = 0;
const errors = [];
const requests = [];
const output = [];
const originalWarn = console.warn;
const originalError = console.error;
console.warn = (...args) => output.push(args.join(' '));
console.error = (...args) => output.push(args.join(' '));
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (error) { failed++; console.log(`  FAIL  ${name}: ${String(error).replaceAll(TOKEN, '[redacted]')}`); }
}
async function rejects(fn, pattern) {
  await assert.rejects(fn, (error) => {
    errors.push(error);
    assert.ok(!String(error).includes(TOKEN));
    assert.ok(!JSON.stringify(error).includes(TOKEN));
    assert.equal(error.cause, undefined);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const B = '5106174674', G = '119615221', J = '119615219';
const S = 'color_mm86v4eh', O = 'multiple_person_mm86z4cd', A = 'multiple_person_mm869xm7';
const P = 'color_mm86ddn1', D = 'date_mm86ewhc', R = 'board_relation_mm86t9nv';
const groups = { 'Not started': 'group_mm86nn5y', 'In progress': 'topics', Waiting: 'group_mm861qv1', Done: 'group_mm86644p' };
const AT = '2026-11-06T12:00:00.000Z';
const LATER = '2026-11-06T12:01:00.000Z';
const CHANGE = '2026-11-06T12:00:30.000Z';
const personValue = (ids) => JSON.stringify({ personsAndTeams: ids.map((v) => ({ id: Number(v), kind: 'person' })) });
function item(itemId = '1', options = {}) {
  const status = options.status ?? 'Not started';
  return {
    id: itemId, name: options.name ?? 'Task', updated_at: options.updatedAt ?? AT,
    board: { id: options.board ?? B }, group: { id: options.group ?? groups[status] ?? groups['Not started'] },
    column_values: [
      { id: S, text: status, value: null },
      { id: O, text: '', value: personValue(options.owners ?? [G]) },
      { id: A, text: '', value: personValue(options.assigned ?? [G]) },
      { id: P, text: options.priority ?? 'Medium', value: null },
      { id: D, text: '', value: options.due ? JSON.stringify({ date: options.due }) : null },
      { id: R, text: null, value: null, display_value: options.project ?? '' },
    ],
    updates: options.comments ?? [],
  };
}
const column = (row, key) => row.column_values.find((c) => c.id === key);
/** Activity ids are UUID strings on the real account (2026-11-06); '100' becomes a stable UUID. */
const uuid = (n) => `5610e651-0915-407e-8382-${String(n).padStart(12, '0')}`;
// created_at as monday sends it: 17 digits of 1e-7 s since the epoch.
const activity = (activityId, itemId, actor = J, columnId = S, event = 'update_column_value', at = CHANGE) => ({
  id: uuid(activityId), user_id: actor, event,
  created_at: String(BigInt(Date.parse(at)) * 10_000n),
  data: JSON.stringify({ pulse_id: itemId, ...(columnId ? { column_id: columnId } : {}) }),
});
const comment = (commentId, actor = J, text = 'Hello', at = CHANGE) => ({
  id: commentId, creator: { id: actor }, text_body: text, created_at: at,
});

function fake(rows = [], activities = []) {
  const state = { rows: structuredClone(rows), activities, log: [], ignore: null, cursor: null, pages: [], graphql: null, transport: null, froms: [] };
  state.fetch = async (url, init) => {
    const entry = { url, ...init, payload: JSON.parse(init.body) };
    requests.push(entry);
    state.log.push(entry);
    assert.equal(url, 'https://api.monday.com/v2');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, TOKEN);
    assert.equal(init.headers['API-Version'], '2026-10');
    assert.equal(init.headers['Content-Type'], 'application/json');
    if (state.transport) throw new Error(state.transport);
    if (state.graphql) return { ok: true, json: async () => ({ errors: [{ message: state.graphql }] }) };
    const { query, variables: v } = entry.payload;
    let data;
    const page = () => (state.pages.length ? state.pages.shift() : { items: state.rows, cursor: state.cursor });
    if (query.includes('query Tasks')) {
      // The tick: the log since the last poll, the board's latest comments, items only on a full read.
      assert.match(query, /activity_logs\(limit: 200, page: 1, from: \$from\)/);
      state.froms.push(v.from);
      assert.match(query, /updates\(limit: 25\) \{ id created_at item_id creator \{ id \} \}/);
      assert.match(query, /items_page\(limit: 200\) @include\(if: \$items\)/);
      assert.match(query, /BoardRelationValue/);
      assert.ok(!/updates\(limit: 100\)|text_body/.test(query), 'no per-item updates and no comment bodies');
      assert.match(v.from, /^\d{4}-\d{2}-\d{2}T/);
      const updates = state.rows.filter((r) => r && Array.isArray(r.updates)).flatMap((r) => r.updates.map((u) => ({ id: u.id, created_at: u.created_at, item_id: r.id, creator: u.creator })));
      data = { complexity: { before: 19_999_000, query: 1000 }, boards: [{ id: B, activity_logs: state.activities.slice(0, 200), updates, ...(v.items ? { items_page: page() } : {}) }] };
    } else if (query.includes('query Logs')) {
      assert.match(query, /activity_logs\(limit: 200, page: \$page, from: \$from\)/);
      data = { boards: [{ id: B, activity_logs: state.activities.slice((v.page - 1) * 200, v.page * 200) }] };
    } else if (query.includes('query Items')) {
      data = { boards: [{ id: B, items_page: page() }] };
    } else if (query.includes('query Page')) {
      data = { next_items_page: page() };
    } else if (query.includes('query Task(')) {
      assert.ok(!/text_body/.test(query), 'a read-back never asks for comment bodies');
      data = { items: state.rows.filter((r) => v.ids.includes(r.id)).map((r) => ({ ...r, updates: r.updates.map((u) => ({ id: u.id })) })) };
    } else if (query.includes('change_multiple_column_values')) {
      const row = state.rows.find((r) => r.id === v.item);
      assert.ok(row);
      if (state.ignore !== 'columns') {
        for (const [key, value] of Object.entries(JSON.parse(v.values))) {
          if (key === S || key === P) column(row, key).text = value.label;
          else column(row, key).value = value === null ? null : JSON.stringify(value);
        }
      }
      data = { change_multiple_column_values: { id: v.item } };
    } else if (query.includes('move_item_to_group')) {
      if (state.ignore !== 'move') state.rows.find((r) => r.id === v.item).group.id = v.group;
      data = { move_item_to_group: { id: v.item } };
    } else if (query.includes('create_update')) {
      if (state.ignore !== 'comment') {
        const text = v.body.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
        state.rows.find((r) => r.id === v.item).updates.unshift(comment('900', G, text));
      }
      data = { create_update: { id: '900' } };
    } else if (query.includes('create_item')) {
      const values = JSON.parse(v.values);
      assert.deepEqual(values[S], { label: 'Not started' });
      assert.deepEqual(values[O], JSON.parse(personValue([G])));
      assert.deepEqual(values[A], JSON.parse(personValue([G])));
      assert.match(query, /group_id: "group_mm86nn5y"/);
      const created = item('901', { name: v.name, priority: values[P]?.label, due: values[D]?.date });
      if (state.ignore === 'create') column(created, O).value = personValue([J]);
      state.rows.push(created);
      data = { create_item: { id: '901' } };
    } else throw new Error('Unexpected test query');
    return { ok: true, json: async () => structuredClone({ data }) };
  };
  return state;
}

try {
  await load('src/shared/work-view.ts');
  const { saveMondayToken, loadMondayToken, createMondayToken } = await load('src/main/work/monday-token.ts');
  const { createMondayClient, diffTasks } = await load('src/main/work/monday.ts');
  const client = (state, at = AT, token = TOKEN) => createMondayClient({ fetch: state.fetch, token, now: () => Date.parse(at) });
  const view = async (rows, logs = [], at = AT) => client(fake(rows, logs), at).fetchBoard();
  const kinds = (events) => events.map((e) => e.kind).sort();

  await test('missing credential returns null', async () => assert.equal(await loadMondayToken(), null));
  await test('encrypted disk round-trip exposes only an HTTP credential', async () => {
    assert.equal(await saveMondayToken(TOKEN), undefined);
    const bytes = await fs.readFile(path.join(tmp, 'monday-token.bin'));
    assert.ok(!bytes.includes(Buffer.from(TOKEN)));
    assert.ok(!bytes.includes(Buffer.from(TOKEN, 'utf16le')));
    const credential = await loadMondayToken();
    assert.deepEqual(Object.keys(credential), ['post']);
    assert.equal(JSON.stringify(credential), '{}');
    const state = fake([item()]);
    assert.equal((await client(state, AT, credential).fetchBoard()).columns.backlog.length, 1);
    assert.equal(state.log[0].headers.Authorization, TOKEN);
    assert.deepEqual(await fs.readdir(tmp), ['monday-token.bin']);
  });
  await test('encryption unavailable refuses writes and preserves encrypted file', async () => {
    const before = await fs.readFile(path.join(tmp, 'monday-token.bin'));
    encryption = false;
    try {
      await rejects(() => saveMondayToken(TOKEN), /securely save/);
      await rejects(() => loadMondayToken(), /securely load/);
      assert.deepEqual(await fs.readFile(path.join(tmp, 'monday-token.bin')), before);
    } finally { encryption = true; }
  });
  await test('safeStorage exceptions cannot reveal credentials', async () => {
    cryptoError = true;
    try {
      await rejects(() => saveMondayToken(TOKEN));
      await rejects(() => loadMondayToken());
    } finally { cryptoError = false; }
  });
  await test('filesystem exceptions cannot reveal credentials', async () => {
    storagePath = path.join(tmp, 'monday-token.bin', TOKEN);
    try {
      await rejects(() => saveMondayToken(TOKEN));
      storagePath = path.join(tmp, 'read-error');
      await fs.mkdir(path.join(storagePath, 'monday-token.bin'), { recursive: true });
      await rejects(() => loadMondayToken());
    }
    finally { storagePath = tmp; }
  });
  await test('plaintext and corrupt credential files are rejected', async () => {
    await fs.writeFile(path.join(tmp, 'monday-token.bin'), TOKEN);
    await rejects(() => loadMondayToken());
    await fs.writeFile(path.join(tmp, 'monday-token.bin'), Buffer.from([1, 2]));
    await rejects(() => loadMondayToken());
    await saveMondayToken(TOKEN);
  });
  await test('invalid token errors contain no supplied value', async () => {
    await rejects(async () => createMondayToken(`${TOKEN}\n`));
    await rejects(() => saveMondayToken(`${TOKEN}\n`));
  });
  await test('transport, GraphQL, HTTP and JSON failures redact server text', async () => {
    for (const failure of ['transport', 'graphql', 'http', 'json']) {
      const state = fake();
      if (failure === 'transport' || failure === 'graphql') state[failure] = TOKEN;
      else state.fetch = async () => ({ ok: failure !== 'http', json: async () => { throw new Error(TOKEN); } });
      await rejects(() => client(state).fetchBoard(), /request failed/);
    }
  });
  await test('one board request returns four columns, capped strings and summaries', async () => {
    const state = fake([
      item('1', { status: 'In progress', due: '2026-11-05' }),
      item('2', { status: 'Waiting', due: '2026-11-07' }),
      item('3', { name: 'x'.repeat(600), project: 'p'.repeat(600), assigned: [J] }),
      item('4', { status: 'Done' }),
    ]);
    const result = await client(state).fetchBoard();
    assert.equal(state.log.length, 1);
    assert.equal(result.at, AT);
    assert.deepEqual(Object.keys(result), ['at', 'columns', 'counts']);
    assert.equal(result.columns.backlog[0].name.length, 500);
    assert.equal(result.columns.backlog[0].project.length, 500);
    assert.deepEqual(result.counts, { inProgress: 1, waiting: 1, backlog: 1, done: 1, overdue: 1, dueThisWeek: 1, newFromJaco: 1, doneThisWeek: 1 });
    assert.ok(!JSON.stringify(result).includes('activity_logs'));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
  await test('cursor pages are fetched without per-item queries', async () => {
    const state = fake();
    state.pages = [{ items: [item('1')], cursor: 'next-page' }, { items: [item('2')], cursor: null }];
    const result = await client(state).fetchBoard();
    assert.equal(result.columns.backlog.length, 2);
    assert.equal(state.log.length, 2);
    assert.match(state.log[1].payload.query, /query Page/);
    assert.deepEqual(state.log[1].payload.variables, { cursor: 'next-page' });
  });
  await test('repeated cursors fail instead of looping', async () => {
    const state = fake([item()]); state.cursor = 'repeat';
    await rejects(() => client(state).fetchBoard(), /cursor/);
    assert.equal(state.log.length, 2);
  });
  await test('malformed items are dropped independently', async () => {
    const mutations = [
      (r) => { r.id = '1;query'; }, (r) => { r.name = {}; }, (r) => { r.name = ' '; },
      (r) => { r.group.id = 'unknown'; }, (r) => { r.board.id = '123'; },
      (r) => { r.updated_at = '2026-02-30T00:00:00Z'; },
      (r) => { column(r, S).text = 'Surprise'; }, (r) => { column(r, P).text = 'Urgent'; },
      (r) => { column(r, D).value = '{broken'; },
      (r) => { column(r, D).value = JSON.stringify({ date: '2026-02-30' }); },
      (r) => { column(r, D).value = JSON.stringify({ date: '06/11/2026' }); },
      (r) => { column(r, O).value = personValue(['invalid']); },
      (r) => { column(r, A).value = '[]'; }, (r) => { column(r, R).display_value = {}; },
      (r) => { r.column_values.pop(); }, (r) => { r.column_values.push(r.column_values[0]); },
    ];
    const bad = mutations.map((mutate, i) => { const r = item(String(i + 10)); mutate(r); return r; });
    const result = await view([null, {}, ...bad, item('1')]);
    assert.deepEqual(result.columns.backlog.map((r) => r.id), ['1']);
  });
  await test('Done is limited to seven days, including the exact boundary; Dropped excluded', async () => {
    const result = await view([
      item('1', { status: 'Done', updatedAt: '2026-10-30T11:59:59.999Z' }),
      item('2', { status: 'Done', updatedAt: '2026-10-30T12:00:00.000Z' }),
      item('3', { status: 'Done', updatedAt: AT }), item('4', { status: 'Dropped' }),
    ]);
    assert.deepEqual(result.columns.done.map((r) => r.id), ['2', '3']);
    assert.equal(Object.values(result.columns).flat().length, 2);
  });
  for (const status of Object.keys(groups)) {
    await test(`status ${status} sends label and group, reading each write back`, async () => {
      const state = fake([item()]);
      const result = await client(state).setStatus('1', status);
      assert.equal(result.status, status); assert.equal(result.group, groups[status]);
      assert.deepEqual(JSON.parse(state.log[1].payload.variables.values), { [S]: { label: status } });
      assert.match(state.log[2].payload.query, /query Task\(/);
      assert.equal(state.log[3].payload.variables.group, groups[status]);
      assert.match(state.log[4].payload.query, /query Task\(/);
    });
  }
  await test('Dropped sets the label and preserves the group', async () => {
    const state = fake([item('1', { status: 'Waiting' })]);
    const result = await client(state).setStatus('1', 'Dropped');
    assert.equal(result.group, groups.Waiting);
    assert.equal(result.status, 'Dropped');
    assert.equal(state.log.length, 3);
  });
  for (const [failure, pattern] of [['columns', /verification failed/], ['move', /status changed but the task was not moved/]]) {
    await test(`status success with unapplied ${failure} fails as "${pattern.source}"`, async () => {
      const state = fake([item()]); state.ignore = failure;
      await rejects(() => client(state).setStatus('1', 'Done'), pattern);
      assert.match(state.log.at(-1).payload.query, /query Task\(/);
    });
  }
  await test('a group move that fails outright after the label changed says "not moved"', async () => {
    const state = fake([item()]);
    const inner = state.fetch;
    state.fetch = async (url, init) => (init.body.includes('move_item_to_group') ? { ok: false, status: 500, json: async () => ({}) } : inner(url, init));
    await rejects(() => client(state).setStatus('1', 'Done'), /not moved/);
    assert.equal(column(state.rows[0], S).text, 'Done');
  });
  await test('priority and due changes, including clearing due, read back', async () => {
    const state = fake([item()]); const c = client(state);
    assert.equal((await c.setPriority('1', 'High')).priority, 'High');
    assert.equal((await c.setDue('1', '2026-11-09')).due, '2026-11-09');
    assert.equal((await c.setDue('1', null)).due, null);
    assert.equal(state.log.filter((r) => r.payload.query.includes('query Task(')).length, 6);
  });
  await test('priority and due writes reject silent failures', async () => {
    const state = fake([item()]); state.ignore = 'columns'; const c = client(state);
    await rejects(() => c.setPriority('1', 'Low'), /verification failed/);
    await rejects(() => c.setDue('1', '2026-11-09'), /verification failed/);
  });
  await test('comments are trimmed, escape HTML, keep line breaks as <br>, and succeed when the new id reads back', async () => {
    const state = fake([item()]);
    await client(state).addComment('1', '  Use <draft> & review\nthen send  ');
    assert.equal(state.log[1].payload.variables.body, 'Use &lt;draft&gt; &amp; review<br>then send');
    assert.match(state.log[2].payload.query, /query Task\(/);
  });
  await test('a task name is trimmed, and its read-back is compared with whitespace collapsed', async () => {
    const state = fake();
    const inner = state.fetch;
    // monday tidies whitespace in names: "New  task" can come back as "New task".
    state.fetch = async (url, init) => {
      const r = await inner(url, init);
      if (init.body.includes('create_item')) state.rows.at(-1).name = 'New task';
      return r;
    };
    const card = await client(state).createTask({ name: '  New   task ' });
    assert.equal(state.log[0].payload.variables.name, 'New   task');
    assert.equal(card.name, 'New task');
  });
  await test('comment success without the new comment fails', async () => {
    const state = fake([item('1', { comments: [comment('899', G, 'Hello')] })]); state.ignore = 'comment';
    await rejects(() => client(state).addComment('1', 'Hello'), /comment verification failed/);
  });
  await test('new task sets Backlog, Gustav owner and assigner, then verifies all requested values', async () => {
    const state = fake();
    const result = await client(state).createTask({ name: 'New task', priority: 'High', due: '2026-11-09' });
    assert.equal(result.name, 'New task'); assert.equal(result.priority, 'High'); assert.equal(result.due, '2026-11-09');
    assert.deepEqual(result.ownerIds, [G]); assert.deepEqual(result.assignedByIds, [G]);
    assert.equal(state.log.length, 2);
    assert.match(state.log[1].payload.query, /query Task\(/);
  });
  await test('new task with unapplied ownership fails', async () => {
    const state = fake(); state.ignore = 'create';
    await rejects(() => client(state).createTask({ name: 'Task' }), /verification failed/);
  });
  await test('actions cannot write outside the Tasks board', async () => {
    const state = fake([item('1', { board: '123' })]); const c = client(state);
    for (const act of [() => c.setStatus('1', 'Done'), () => c.setPriority('1', 'High'), () => c.setDue('1', null), () => c.addComment('1', 'Hello')]) {
      await rejects(act, /Tasks board item/);
    }
    assert.ok(state.log.every((r) => r.payload.query.startsWith('query')));
  });
  await test('invalid action inputs fail before HTTP with no echoed values', async () => {
    const state = fake(); const c = client(state);
    for (const act of [
      () => c.setStatus('1', TOKEN), () => c.setPriority('1', TOKEN), () => c.setDue('1', TOKEN),
      () => c.setDue('1', '2026-02-30'), () => c.setStatus(TOKEN, 'Done'),
      () => c.addComment('1', ''), () => c.createTask({ name: '', priority: TOKEN }),
      () => c.createTask({ name: 'Task', priority: TOKEN }), () => c.createTask({ name: 'Task', due: TOKEN }),
    ]) await rejects(act);
    assert.equal(state.log.length, 0);
  });
  await test('initial load and unchanged snapshots do not notify', async () => {
    const first = await view([item()]);
    assert.deepEqual(diffTasks(null, first, G), []);
    assert.deepEqual(diffTasks(first, await view([item()], [], LATER), G), []);
  });
  await test('assignment by Jaco emits exactly assigned', async () => {
    const first = await view([item('1', { owners: [J], assigned: [J] })]);
    const next = await view([item('1', { assigned: [J] })], [activity('100', '1', J, O)], LATER);
    const events = diffTasks(first, next, G);
    assert.deepEqual(kinds(events), ['assigned']); assert.equal(events[0].actorId, J);
    assert.equal(events[0].taskId, '1'); assert.equal(events[0].taskName, 'Task');
    assert.equal(events[0].at, CHANGE);
  });
  await test('new task created by Jaco for Gustav emits assigned', async () => {
    const first = await view([]);
    const next = await view([item('1', { assigned: [J] })], [activity('100', '1', J, null, 'create_pulse')], LATER);
    assert.deepEqual(kinds(diffTasks(first, next, G)), ['assigned']);
  });
  await test('assignment and movement in one poll use current ownership too', async () => {
    const first = await view([item('1', { owners: [J], assigned: [J] })]);
    const next = await view([item('1', { assigned: [J], status: 'In progress' })], [
      activity('100', '1', J, O), activity('101', '1'),
    ], LATER);
    assert.deepEqual(kinds(diffTasks(first, next, G)), ['assigned', 'moved']);
  });
  for (const relationship of ['owns', 'assigned']) {
    await test(`Jaco moving and commenting on a task Gustav ${relationship} emits exactly those notices`, async () => {
      const options = relationship === 'owns' ? { owners: [G], assigned: [J] } : { owners: [J], assigned: [G] };
      const first = await view([item('1', options)]);
      const next = await view([item('1', { ...options, status: 'In progress', comments: [comment('200')] })], [activity('100', '1')], LATER);
      assert.deepEqual(kinds(diffTasks(first, next, G)), ['commented', 'moved']);
    });
  }
  await test('group-only movement by Jaco emits moved', async () => {
    const first = await view([item()]);
    const next = await view([item('1', { group: groups['In progress'] })], [activity('100', '1', J, null, 'move_pulse_into_group')], LATER);
    assert.deepEqual(kinds(diffTasks(first, next, G)), ['moved']);
  });
  await test('leaving Waiting by another person emits only leftWaiting', async () => {
    const first = await view([item('1', { status: 'Waiting' })]);
    const next = await view([item('1', { status: 'In progress' })], [activity('100', '1', '555')], LATER);
    assert.deepEqual(kinds(diffTasks(first, next, G)), ['leftWaiting']);
  });
  await test('Dropped stays out of the view but can resolve a Waiting notice', async () => {
    const first = await view([item('1', { status: 'Waiting' })]);
    const next = await view([item('1', { status: 'Dropped' })], [activity('100', '1')], LATER);
    assert.equal(Object.values(next.columns).flat().length, 0);
    assert.deepEqual(kinds(diffTasks(first, next, G)), ['leftWaiting', 'moved']);
  });
  await test('activity ids are UUIDs and times 17-digit 1e-7 s strings; ISO also parses; bad ids are dropped', async () => {
    const first = await view([item('1', { owners: [J], assigned: [J] })]);
    const iso = { ...activity('100', '1', J, O), created_at: CHANGE };
    const next = await view([item('1', { assigned: [J] })], [iso, { ...activity('101', '1', J, O), id: 'bad id!' }], LATER);
    const events = diffTasks(first, next, G);
    assert.deepEqual(events.map((e) => [e.kind, e.id, e.at]), [['assigned', `assigned:${uuid('100')}`, CHANGE]]);
    assert.equal(new Date(Number(BigInt('17939553412686034') / 10_000n)).toISOString().slice(0, 10), '2026-11-06');
  });
  await test('no upper time bound: a change stamped after this poll\'s clock still notifies', async () => {
    const first = await view([item('1', { owners: [J], assigned: [J] })]);
    const ahead = '2026-11-06T12:03:00.000Z'; // the poll's own clock says 12:01
    const next = await view([item('1', { assigned: [J] })], [activity('100', '1', J, O, 'update_column_value', ahead)], LATER);
    assert.deepEqual(kinds(diffTasks(first, next, G)), ['assigned']);
  });
  await test('a change up to 120 s before the previous poll still counts; older does not', async () => {
    const first = await view([item('1', { owners: [J], assigned: [J] }), item('2', { owners: [J], assigned: [J] })]);
    const next = await view([item('1', { assigned: [J] }), item('2', { assigned: [J] })], [
      activity('100', '1', J, O, 'update_column_value', '2026-11-06T11:58:30.000Z'),
      activity('101', '2', J, O, 'update_column_value', '2026-11-06T11:57:30.000Z'),
    ], LATER);
    assert.deepEqual(diffTasks(first, next, G).map((e) => e.taskId), ['1']);
  });
  await test('a quiet log reuses the items: one request, no item read', async () => {
    const state = fake([item('1')]);
    const c = client(state);
    const first = await c.fetchBoard();
    const r = await c.poll(first);
    assert.equal(r.refetched, false);
    assert.equal(state.log.length, 2);
    assert.equal(state.log[1].payload.variables.items, false);
    state.activities = [activity('100', '1', '555')];
    const r2 = await c.poll(r.view);
    assert.equal(r2.refetched, true);
    assert.match(state.log.at(-1).payload.query, /query Items/);
    assert.deepEqual([r2.received, r2.parsed], [1, 1]);
  });
  /*
   * Log lag: the items are read AFTER Jaco's change but BEFORE its log entry
   * shows up. Snapshot comparison alone then never notifies (the next poll
   * sees the entry and an unchanged card). The entry's own values decide.
   */
  const label = (text) => ({ label: { index: 1, text, style: { color: '#fdab3d' } }, post_id: null });
  const persons = (ids) => ({ personsAndTeams: ids.map((v) => ({ id: Number(v), kind: 'person' })), changed_at: CHANGE });
  const described = (activityId, itemId, actor, columnId, value, previous, at = CHANGE, event = 'update_column_value', extra = {}) => ({
    id: uuid(activityId), user_id: actor, event, created_at: String(BigInt(Date.parse(at)) * 10_000n),
    data: JSON.stringify({ pulse_id: Number(itemId), ...(columnId ? { column_id: columnId } : {}),
      ...(value !== undefined ? { value } : {}), ...(previous !== undefined ? { previous_value: previous } : {}), ...extra }),
  });
  /** Three polls: v0 before the change; v1 reads the changed items with the log still empty; v2 sees the entry; v3 again. */
  async function lag(rowsBefore, rowsAfter, entries) {
    const state = fake(rowsBefore);
    const clock = { t: Date.parse(AT) };
    const c = createMondayClient({ fetch: state.fetch, token: TOKEN, now: () => clock.t });
    const v0 = await c.fetchBoard();
    state.rows = structuredClone(rowsAfter);
    clock.t += 60_000;
    const v1 = (await c.poll(v0, { full: true })).view;
    state.activities = entries;
    clock.t += 60_000;
    const v2 = (await c.poll(v1)).view;
    clock.t += 60_000;
    const v3 = (await c.poll(v2)).view;
    return [diffTasks(v0, v1, G), diffTasks(v1, v2, G), diffTasks(v2, v3, G)].map(kinds);
  }
  await test('log lag: Jaco moving a task out of Waiting still notifies, exactly once, from the log entry', async () => {
    const lagAt = '2026-11-06T12:00:50.000Z';
    const got = await lag([item('1', { status: 'Waiting', assigned: [J] })], [item('1', { status: 'In progress', assigned: [J] })],
      [described('100', '1', J, S, label('In progress'), label('Waiting'), lagAt)]);
    assert.deepEqual(got, [[], ['leftWaiting', 'moved'], []]);
  });
  await test('log lag: Jaco assigning a task still notifies, exactly once', async () => {
    const got = await lag([item('1', { owners: [J], assigned: [J] })], [item('1', { owners: [G], assigned: [J] })],
      [described('100', '1', J, O, persons([G]), persons([J]), '2026-11-06T12:00:50.000Z')]);
    assert.deepEqual(got, [[], ['assigned'], []]);
  });
  await test('log lag: a group move that says source and destination leaves Waiting, exactly once', async () => {
    const got = await lag([item('1', { status: 'Waiting' })], [item('1', { status: 'Waiting', group: groups['In progress'] })],
      [described('100', '1', J, null, undefined, undefined, '2026-11-06T12:00:50.000Z', 'move_pulse_from_group',
        { source_group: { id: groups.Waiting, title: 'Waiting' }, dest_group: { id: groups['In progress'], title: 'In progress' } })]);
    assert.deepEqual(got, [[], ['leftWaiting', 'moved'], []]);
  });
  await test('described entries: Gustav\'s own move never notifies, and the latest change decides the actor', async () => {
    const own = await lag([item('1', { status: 'Waiting' })], [item('1', { status: 'Done' })],
      [described('100', '1', G, S, label('Done'), label('Waiting'))]);
    assert.deepEqual(own, [[], [], []]);
    const both = await lag([item('1', { status: 'Waiting' })], [item('1', { status: 'Done' })], [
      described('100', '1', J, S, label('In progress'), label('Waiting'), '2026-11-06T12:00:10.000Z'),
      described('101', '1', G, S, label('Done'), label('In progress'), '2026-11-06T12:00:40.000Z'),
    ]);
    assert.deepEqual(both, [[], [], []]);
    const unrelated = await lag([item('1', { status: 'Waiting', owners: [J], assigned: [J] })], [item('1', { status: 'Done', owners: [J], assigned: [J] })],
      [described('100', '1', J, S, label('Done'), label('Waiting'))]);
    assert.deepEqual(unrelated, [[], [], []]);
  });
  await test('a full log page reads the next one, up to 5 pages; past that it says so and reads the items again', async () => {
    const many = (n) => Array.from({ length: n }, (_, i) => activity(String(1000 + i), '1', '555', P));
    const state = fake([item('1')], many(450));
    const c = client(state);
    const v0 = await c.fetchBoard();
    assert.deepEqual(state.log.map((x) => x.payload.query.match(/query (\w+)/)[1]), ['Tasks', 'Logs', 'Logs']);
    assert.deepEqual(state.log.slice(1).map((x) => x.payload.variables.page), [2, 3]);
    state.log.length = 0;
    state.activities = many(1200);
    const r = await c.poll(v0);
    assert.deepEqual(state.log.map((x) => x.payload.query.match(/query (\w+)/)[1]), ['Tasks', 'Logs', 'Logs', 'Logs', 'Logs', 'Items']);
    assert.deepEqual([r.received, r.truncated, r.refetched], [1000, true, true]);
  });
  await test('from is sent in whole seconds: exactly "2026-11-06T11:59:00Z"', async () => {
    const state = fake([item('1')]);
    const clock = { t: Date.parse(LATER) + 456 };
    const c = createMondayClient({ fetch: state.fetch, token: TOKEN, now: () => clock.t });
    const v0 = await c.fetchBoard(); // its at is 12:01:00.456
    await c.poll(v0);
    assert.deepEqual(state.froms, ['2026-11-06T11:59:00Z', '2026-11-06T11:59:00Z']);
  });
  await test('Gustav assigning, moving, leaving Waiting and commenting never notifies', async () => {
    const first = await view([item('1', { status: 'Waiting', owners: [J] })]);
    const next = await view([item('1', { status: 'Done', assigned: [J], comments: [comment('200', G)] })], [
      activity('100', '1', G, O), activity('101', '1', G),
    ], LATER);
    assert.deepEqual(diffTasks(first, next, G), []);
  });
  await test('an earlier Jaco move cannot misattribute Gustav latest move', async () => {
    const first = await view([item('1', { status: 'Waiting' })]);
    const next = await view([item('1', { status: 'Done' })], [
      activity('100', '1', J, S, 'update_column_value', '2026-11-06T12:00:10.000Z'),
      activity('101', '1', G),
    ], LATER);
    assert.deepEqual(diffTasks(first, next, G), []);
  });
  await test('unrelated tasks, other authors and priority changes do not notify', async () => {
    const first = await view([item('1', { owners: [J], assigned: [J] }), item('2'), item('3')]);
    const next = await view([
      item('1', { owners: [J], assigned: [J], status: 'Done', comments: [comment('200')] }),
      item('2', { status: 'Done', comments: [comment('201', '555')] }), item('3', { priority: 'High' }),
    ], [activity('100', '1'), activity('101', '2', '555'), activity('102', '3', J, P)], LATER);
    assert.deepEqual(diffTasks(first, next, G), []);
  });
  await test('stale, malformed and missing actor evidence do not notify', async () => {
    const first = await view([item()]);
    const next = await view([item('1', { status: 'Done', comments: [comment('200', J, 'old', '2026-11-05T12:00:00.000Z')] })], [
      activity('100', '1', J, S, 'update_column_value', '2026-11-05T12:00:00.000Z'),
      { ...activity('101', '1'), user_id: TOKEN }, { ...activity('102', '1'), data: '{bad' },
    ], LATER);
    assert.deepEqual(diffTasks(first, next, G), []);
    assert.deepEqual(diffTasks(JSON.parse(JSON.stringify(first)), next, G), []);
  });
  await test('already observed comments do not notify again', async () => {
    const first = await view([item('1', { comments: [comment('200', J, 'Hello', AT)] })]);
    const next = await view([item('1', { comments: [comment('200', J, 'Hello', AT)] })], [], LATER);
    assert.deepEqual(diffTasks(first, next, G), []);
  });
  await test('all thrown errors and all fetch log fields except Authorization contain no token', async () => {
    assert.ok(errors.length >= 20);
    for (const error of errors) assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(TOKEN));
    for (const entry of requests) {
      assert.ok(entry.signal instanceof AbortSignal, 'every request carries a timeout signal');
      const safe = structuredClone({ url: entry.url, method: entry.method, body: entry.body, headers: entry.headers, payload: entry.payload });
      delete safe.headers.Authorization;
      assert.ok(!JSON.stringify(safe).includes(TOKEN));
    }
    assert.ok(!output.join('\n').includes(TOKEN));
  });
} finally {
  console.warn = originalWarn;
  console.error = originalError;
  // The only recursive removal is this suite's own verified temporary directory.
  const relative = path.relative(os.tmpdir(), tmp);
  if (relative.startsWith('mbw-monday-') && !relative.includes(path.sep)) await fs.rm(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
