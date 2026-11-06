import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mbw-mail-'));
const require = createRequire(import.meta.url);
const PASSWORD = 'test-only-mail-password-NOT-FOR-LOGS';
const key = randomBytes(32);
let encryption = true;
let cryptoError = false;
const electron = {
  app: { getPath: () => tmp },
  safeStorage: {
    isEncryptionAvailable: () => encryption,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) {
      if (cryptoError) throw new Error(PASSWORD);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(value) {
      if (cryptoError) throw new Error(PASSWORD);
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  },
};

// In-process transpilation, matching the Monday suite. No esbuild or real mail connection.
let allowRealImapflow = false;
const cache = new Map();
async function load(relative) {
  const filename = path.join(root, relative);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === 'electron') return electron;
    if (name === 'imapflow') {
      // Only the real-API test loads imapflow, and it never lets it connect.
      if (!allowRealImapflow) throw new Error('Tests must inject the fake transport.');
      return require('imapflow');
    }
    if (name.startsWith('.')) {
      const dependency = cache.get(path.resolve(path.dirname(filename), `${name}.ts`));
      assert.ok(dependency, 'load local dependencies first');
      return dependency;
    }
    return require(name);
  };
  runInThisContext(`(function(require, module, exports) { ${compiled}\n})`, { filename })(localRequire, module, module.exports);
  cache.set(filename, module.exports);
  return module.exports;
}
await load('src/shared/mail-view.ts');
const { mailToText, cleanMailText, BODY_LIMIT, DOWNLOAD_LIMIT } = await load('src/main/work/mail-text.ts');
const { createMailAccountStore, createMailCredential, validateMailAccount, mailFailure } = await load('src/main/work/mail-accounts.ts');
const { createImapMail, diffMail, reconnectDelay, imapflowClient, MAIL_POLL_MS, RECONNECT_CAP_MS } = await load('src/main/work/imap.ts');
const account = { id: 'gmail', kind: 'imap', label: 'Gmail', colour: '#123456', host: 'imap.gmail.com', port: 993, user: 'test@gmail.com' };
const godaddy = { ...account, id: 'pickle', host: 'imap.secureserver.net', user: 'gustav@pickleplaysouthafrica.org' };
const returned = [], errors = [], logs = [];
const originalConsole = { log: console.log, warn: console.warn, error: console.error, debug: console.debug, info: console.info };
for (const name of Object.keys(originalConsole)) console[name] = (...args) => logs.push(args.join(' '));
let passed = 0, failed = 0;
async function test(name, work) {
  try { await work(); passed++; originalConsole.log(`  PASS  ${name}`); }
  catch (error) { failed++; originalConsole.log(`  FAIL  ${name}: ${String(error).replaceAll(PASSWORD, '[redacted]')}`); }
}
function safe(value) {
  assert.ok(!JSON.stringify(value)?.includes(PASSWORD));
  returned.push(value);
  return value;
}
async function rejects(work, kind) {
  await assert.rejects(work, (error) => {
    assert.equal(error.name, 'MailError');
    if (kind) assert.equal(error.kind, kind);
    assert.ok(!String(error).includes(PASSWORD));
    assert.ok(!JSON.stringify(error).includes(PASSWORD));
    assert.equal(error.cause, undefined);
    errors.push(error);
    return true;
  });
}
function message(uid = 1, options = {}) {
  return {
    uid, flags: new Set(), size: 100,
    envelope: { from: [{ name: 'Person', address: 'person@example.com' }], subject: `Message ${uid}`,
      date: new Date('2026-11-06T12:00:00Z'), messageId: `<mail-${uid}@example.com>` },
    headers: Buffer.from(''), labels: new Set(),
    bodyStructure: { type: 'text/plain', part: '1', size: 100 },
    body: 'Hello', ...options,
  };
}

class FakeClient extends EventEmitter {
  constructor(rows = [message()]) {
    super();
    this.capabilities = new Map(['IDLE', 'MOVE', 'UIDPLUS', 'X-GM-EXT-1'].map((c) => [c, true]));
    this.boxes = new Map([['INBOX', { uidValidity: 10n, rows }], ['[Gmail]/All Mail', { uidValidity: 20n, rows: [] }], ['[Gmail]/Trash', { uidValidity: 30n, rows: [] }]]);
    this.mailbox = false;
    this.calls = [];
    this.nextUid = 1000;
    this.mismatch = false;
    this.moveMismatch = false;
    this.mapping = true;
    this.closed = false;
    this.unseen = null;
  }
  async connect() { if (this.connectError) throw this.connectError; this.closed = false; }
  close() { this.closed = true; this.finishIdle(); this.emit('close'); }
  finishIdle() { this.idleResolve?.(true); this.idleResolve = null; }
  async getMailboxLock(name) {
    this.finishIdle();
    assert.equal(this.locked, undefined, 'no nested mailbox locks');
    assert.ok(this.boxes.has(name), 'mailbox exists');
    this.locked = name;
    const box = this.boxes.get(name);
    this.mailbox = { path: name, uidValidity: box.uidValidity, exists: box.rows.length };
    return { release: () => { this.locked = undefined; } };
  }
  rows() { return this.boxes.get(this.mailbox.path).rows; }
  async *fetch(range, query) {
    this.calls.push(['fetch', range, query]);
    assert.equal(query.source, undefined);
    assert.equal(query.bodyParts, undefined);
    assert.equal(query.bodyStructure, undefined);
    const [start, end] = range.split(':').map(Number);
    for (const row of this.rows().slice(start - 1, end)) yield row;
  }
  async fetchOne(uid, query, options) {
    assert.equal(options.uid, true);
    this.calls.push(['fetchOne', this.mailbox.path, uid, query]);
    if (this.readError) throw this.readError;
    return this.rows().find((r) => r.uid === uid) ?? false;
  }
  async download(uid, part, options) {
    this.calls.push(['download', uid, part, options]);
    assert.equal(options.uid, true);
    assert.equal(options.maxBytes, DOWNLOAD_LIMIT);
    const row = this.rows().find((r) => r.uid === uid);
    if (this.downloadError) throw this.downloadError;
    return { content: Readable.from([Buffer.from(row.body)]) };
  }
  async messageFlagsAdd(uid, values, options) { return this.changeFlags(uid, values, options, true); }
  async messageFlagsRemove(uid, values, options) { return this.changeFlags(uid, values, options, false); }
  async changeFlags(uid, values, options, add) {
    assert.equal(options.uid, true);
    this.calls.push(['flags', uid, values, add]);
    if (this.mismatch) return false;
    const flags = this.rows().find((r) => r.uid === uid).flags;
    for (const flag of values) { if (add) flags.add(flag); else flags.delete(flag); }
    return true;
  }
  async messageCopy(uid, destination, options) {
    assert.equal(options.uid, true);
    this.calls.push(['copy', this.mailbox.path, destination, uid]);
    const row = this.rows().find((r) => r.uid === uid);
    const target = this.boxes.get(destination);
    const next = this.nextUid++;
    target.rows.push({ ...structuredClone(row), uid: next });
    return { uidValidity: target.uidValidity, ...(this.mapping ? { uidMap: new Map([[uid, next]]) } : {}) };
  }
  async messageMove(uid, destination, options) {
    assert.equal(options.uid, true);
    this.calls.push(['move', this.mailbox.path, destination, uid]);
    const row = this.rows().find((r) => r.uid === uid);
    const target = this.boxes.get(destination);
    const next = this.nextUid++;
    // Gmail: moving out of All Mail only adds a label; the message stays in All Mail.
    const keeps = this.allMailKeeps && this.mailbox.path === '[Gmail]/All Mail';
    if (!this.moveMismatch && !keeps) this.rows().splice(this.rows().indexOf(row), 1);
    target.rows.push({ ...structuredClone(row), uid: next });
    if (this.destinationMismatch) target.rows.at(-1).flags.add('\\Seen');
    return { uidValidity: target.uidValidity, ...(this.mapping ? { uidMap: new Map([[uid, next]]) } : {}) };
  }
  async mailboxCreate(name) {
    this.calls.push(['create', name]);
    this.boxes.set(name, { uidValidity: 40n, rows: [] });
    return { created: true };
  }
  async list() {
    return [...this.boxes.keys()].map((name) => ({ path: name,
      specialUse: name === '[Gmail]/All Mail' ? '\\All' : name === '[Gmail]/Trash' ? '\\Trash' : undefined }));
  }
  async search(query, options) {
    assert.equal(options.uid, true);
    if (query.gmraw !== undefined) {
      this.calls.push(['gmraw', query.gmraw, query.uid]);
      return this.rows().filter((r) => r.category).map((r) => r.uid);
    }
    return this.rows().filter((r) => r.envelope.messageId === query.header['message-id']).map((r) => r.uid);
  }
  async status(name) { return { unseen: this.unseen ?? this.boxes.get(name).rows.filter((r) => !r.flags.has('\\Seen')).length }; }
  async noop() { this.finishIdle(); this.mailbox.exists = this.rows().length; }
  idle() { this.calls.push(['idle']); return new Promise((resolve) => { this.idleResolve = resolve; }); }
  messageDelete() { assert.fail('never delete'); }
  mailboxClose() { assert.fail('never close with expunge'); }
  expunge() { assert.fail('never expunge'); }
}
function setup(rows, overrides = {}) {
  const fake = new FakeClient(rows);
  const api = createImapMail({ account, credential: createMailCredential(PASSWORD), createClient(options) {
    assert.equal(options.host, (overrides.account ?? account).host);
    assert.equal(options.port, 993);
    assert.equal(options.secure, true);
    assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.tls.minVersion, 'TLSv1.2');
    assert.equal(options.tls.servername, options.host);
    assert.equal(options.auth.pass, PASSWORD);
    assert.equal(options.logger, false);
    assert.equal(options.emitLogs, false);
    assert.equal(options.logRaw, false);
    return fake;
  }, ...overrides });
  return { fake, api };
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };

try {
  await test('password round-trip uses encrypted per-account files and returns opaque credentials', async () => {
    const store = createMailAccountStore();
    safe(await store.save({ id: 'gmail', preset: 'gmail', label: 'Gmail', colour: '#123456', user: 'test@gmail.com' }, PASSWORD));
    safe(await store.save({ id: 'pickle', preset: 'godaddy', label: 'Pickle', colour: '#abcdef', user: godaddy.user }, PASSWORD));
    const bytes = await fs.readFile(path.join(tmp, 'mail-accounts', 'gmail.bin'));
    assert.ok(!bytes.includes(Buffer.from(PASSWORD)));
    assert.ok(!bytes.includes(Buffer.from('test@gmail.com')));
    const loaded = safe(await store.load('gmail'));
    await loaded.credential.use(async (secret) => { assert.equal(secret, PASSWORD); });
    assert.equal(safe(await store.list()).length, 2);
    await store.remove('pickle');
    assert.equal(await store.load('pickle'), null);
  });
  await test('encryption failure, corrupted storage and unsafe account input fail without secret text', async () => {
    const store = createMailAccountStore();
    encryption = false;
    await rejects(() => store.load('gmail'), 'storage');
    encryption = true; cryptoError = true;
    await rejects(() => store.load('gmail'), 'storage');
    await rejects(() => store.save({ id: 'gmail', preset: 'gmail', label: 'Gmail', colour: '#123456', user: account.user }, PASSWORD), 'storage');
    cryptoError = false;
    await rejects(() => store.load('../outside'), 'storage');
    await fs.writeFile(path.join(tmp, 'mail-accounts', 'bad.bin'), 'not ciphertext');
    await rejects(() => store.load('bad'), 'storage');
    for (const invalid of [{ host: 'evil.example' }, { port: 143 }, { user: 'x\r\ny@example.com' }, { colour: 'url(evil)' }]) {
      assert.throws(() => validateMailAccount({ ...account, ...invalid }));
    }
  });
  await test('TLS is enforced, certificate and authentication failures are fixed errors', async () => {
    for (const [code, kind] of [['CERT_HAS_EXPIRED', 'tls'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'], ['AUTHENTICATIONFAILED', 'auth'], ['ECONNRESET', 'offline']]) {
      const { api, fake } = setup();
      fake.connectError = Object.assign(new Error(PASSWORD), { code });
      await rejects(() => api.sync(), kind);
      assert.ok(fake.closed);
      api.stop();
    }
  });
  await test('sync fetches only newest 200 envelopes, full inbox unread count and no bodies', async () => {
    const { api, fake } = setup(Array.from({ length: 250 }, (_, i) => message(i + 1)));
    const snapshot = safe(await api.sync());
    assert.equal(snapshot.rows.length, 200);
    assert.equal(snapshot.account.unread, 250);
    assert.equal(fake.calls.find((c) => c[0] === 'fetch')[1], '51:250');
    assert.equal(fake.calls.filter((c) => c[0] === 'download').length, 0);
    assert.ok(snapshot.rows.every((r) => r.snippet === ''));
    api.stop();
  });
  await test('empty mailbox avoids the IMAP 1:0 range', async () => {
    const { api, fake } = setup([]);
    assert.equal((await api.sync()).rows.length, 0);
    assert.equal(fake.calls.filter((c) => c[0] === 'fetch').length, 0);
    api.stop();
  });
  await test('malformed envelopes are dropped and external strings are sanitized', async () => {
    const badDate = message(2); badDate.envelope.date = new Date('bad');
    const badFrom = message(3); badFrom.envelope.from[0].address = 'not-an-address';
    const badSubject = message(4); badSubject.envelope.subject = { secret: PASSWORD };
    const echoed = message(5); echoed.envelope.subject = `<b>${PASSWORD}</b>\u202e\u200b`;
    const { api, fake } = setup([message(), badDate, badFrom, badSubject, echoed, message(-2), message(8, { flags: [] })]);
    fake.unseen = 7;
    const snapshot = safe(await api.sync());
    assert.equal(snapshot.rows.length, 2);
    // A subject is text, not HTML: the markup stays (as text), the password does not, and the controls go.
    assert.equal(snapshot.rows[1].subject, '<b>[redacted]</b>');
    api.stop();
  });
  await test('HTML tokenizer drops active content and exposes actual link URLs', () => {
    const result = mailToText('<style>hide</style><script>steal()</script><p>Hello <b>world</b><img src="https://tracker.test/pixel"><a href="https://real.example/path?q=1&amp;b=2">Bank</a></p>');
    assert.match(result, /Hello world/);
    assert.match(result, /Bank \(https:\/\/real.example\/path\?q=1&b=2\)/);
    assert.doesNotMatch(result, /<|>|hide|steal|tracker/);
    assert.doesNotMatch(mailToText('<a href="javascript:alert(1)">click</a><!--hidden-->'), /javascript|hidden/);
    assert.doesNotMatch(mailToText('&lt;script&gt;visible&lt;/script&gt;'), /[<>]/);
    assert.doesNotMatch(mailToText('<script>never closes'), /never/);
    assert.equal(mailToText('before<img src="unfinished'), 'before');
  });
  await test('text caps strip controls, bidi and zero-width formatting', () => {
    assert.equal(cleanMailText('A\u0000\u0007\u007f\u0085\u202e\u200b\u2066\ufeffB\nC\tD'), 'AB\nC\tD');
    assert.equal(mailToText('x'.repeat(30_000), false).length, BODY_LIMIT);
    assert.equal(mailToText('<b>Hi</b>', false), '<b>Hi</b>', 'plain text is never tokenized');
    assert.equal(mailToText('A&#x202e;&#8203;B'), 'AB');
  });
  await test('open downloads a decoded text part only, caps it and lists attachments', async () => {
    const row = message(1, { body: `<script>bad</script><p>${PASSWORD}</p><a href="https://example.com">Visit</a>${'x'.repeat(30_000)}`,
      bodyStructure: { type: 'multipart/mixed', childNodes: [
        { part: '1', type: 'text/html', size: 40_000 },
        { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'report\u202e.pdf' }, size: 1234 },
      ] } });
    const { api, fake } = setup([row]);
    const handle = (await api.sync()).rows[0].handle;
    const body = safe(await api.open(handle));
    assert.equal(body.text.length, BODY_LIMIT);
    assert.doesNotMatch(body.text, /<|>|bad/);
    assert.match(body.text, /Visit \(https:\/\/example.com\/\)/);
    assert.deepEqual(body.attachments, [{ name: 'report.pdf', size: 1234 }]);
    assert.equal(fake.calls.find((c) => c[0] === 'download')[2], '1');
    api.stop();
  });
  await test('plain alternative preferred and raw MIME never returned', async () => {
    const { api, fake } = setup([message(1, { body: 'Plain body', bodyStructure: { type: 'multipart/alternative', childNodes: [
      { part: '1', type: 'text/html', size: 100 }, { part: '2', type: 'text/plain', size: 100 },
    ] } })]);
    const body = safe(await api.open((await api.sync()).rows[0].handle));
    assert.equal(body.text, 'Plain body');
    assert.equal(fake.calls.find((c) => c[0] === 'download')[2], '2');
    api.stop();
  });
  await test('HTML-decoded secrets stay redacted and opened bodies supply bounded snippets', async () => {
    const encoded = [...PASSWORD].map((ch) => `&#${ch.charCodeAt(0)};`).join('');
    const row = message(1, { body: `<p>${encoded}</p>`, bodyStructure: { type: 'text/html', part: '1', size: 100 } });
    row.envelope.subject = encoded;
    const { api } = setup([row]);
    const initial = safe(await api.sync());
    // A subject is MIME text: entities in it are literal characters, not a hidden password.
    assert.equal(initial.rows[0].subject, encoded);
    assert.equal(safe(await api.open(initial.rows[0].handle)).text, '[redacted]');
    assert.equal(safe(await api.sync()).rows[0].snippet, '[redacted]');
    api.stop();
  });
  await test('every action rejects forged and stale handles before mutation', async () => {
    const { api, fake } = setup();
    const handle = (await api.sync()).rows[0].handle;
    for (const method of ['open', 'markRead', 'markUnread', 'flag', 'unflag', 'archive', 'trash']) {
      await rejects(() => api[method](`${handle}x`), 'invalid');
    }
    fake.boxes.get('INBOX').uidValidity = 99n;
    await rejects(() => api.markRead(handle), 'invalid');
    await rejects(() => api.archive(handle), 'invalid');
    assert.equal(fake.calls.filter((c) => ['move', 'flags'].includes(c[0])).length, 0);
    api.stop();
  });
  await test('read/unread and flag/unflag re-read the actual flags', async () => {
    const { api } = setup();
    const handle = (await api.sync()).rows[0].handle;
    assert.equal(safe(await api.markRead(handle)).seen, true);
    assert.equal(safe(await api.markUnread(handle)).seen, false);
    assert.equal(safe(await api.flag(handle)).flagged, true);
    assert.equal(safe(await api.unflag(handle)).flagged, false);
    api.stop();
  });
  await test('read-back mismatch reports failure for flags and location', async () => {
    for (const variant of ['mismatch', 'moveMismatch', 'destinationMismatch']) {
      const { api, fake } = setup();
      const handle = (await api.sync()).rows[0].handle;
      fake[variant] = true;
      await rejects(() => variant === 'mismatch' ? api.markRead(handle) : api.trash(handle), 'mismatch');
      api.stop();
    }
  });
  await test('Gmail archive and trash MOVE; undo of trash moves back, undo of archive COPIES back to INBOX (never out of All Mail)', async () => {
    for (const method of ['archive', 'trash']) {
      const { api, fake } = setup();
      const handle = (await api.sync()).rows[0].handle;
      const result = safe(await api[method](handle));
      const undone = safe(await api.undo(result.undo));
      assert.notEqual(undone.handle, handle);
      const moves = fake.calls.filter((c) => c[0] === 'move' || c[0] === 'copy');
      const target = method === 'archive' ? '[Gmail]/All Mail' : '[Gmail]/Trash';
      assert.deepEqual(moves, method === 'archive'
        ? [['move', 'INBOX', target, 1], ['copy', target, 'INBOX', 1000]]
        : [['move', 'INBOX', target, 1], ['move', target, 'INBOX', 1000]]);
      assert.equal(fake.mailbox.path, 'INBOX');
      await rejects(() => api.undo(result.undo), 'invalid');
      api.stop();
    }
  });
  await test('GoDaddy creates Archive and Trash folders when missing', async () => {
    for (const method of ['archive', 'trash']) {
      const { api, fake } = setup(undefined, { account: godaddy });
      fake.boxes.delete('[Gmail]/All Mail'); fake.boxes.delete('[Gmail]/Trash');
      const result = safe(await api[method]((await api.sync()).rows[0].handle));
      const folder = method === 'archive' ? 'Archive' : 'Trash';
      assert.ok(fake.calls.some((c) => c[0] === 'create' && c[1] === folder));
      safe(await api.undo(result.undo));
      api.stop();
    }
  });
  await test('servers without MOVE are refused before the library can expunge', async () => {
    const { api, fake } = setup(); fake.capabilities.delete('MOVE');
    await rejects(async () => api.trash((await api.sync()).rows[0].handle), 'unsupported');
    assert.equal(fake.calls.filter((c) => c[0] === 'move').length, 0);
    api.stop();
  });
  await test('missing COPYUID uses a unique verified message-id, and ambiguity fails', async () => {
    const { api, fake } = setup(); fake.mapping = false; fake.capabilities.delete('UIDPLUS');
    const result = safe(await api.archive((await api.sync()).rows[0].handle));
    safe(await api.undo(result.undo));
    api.stop();
    const second = setup(); second.fake.mapping = false;
    second.fake.boxes.get('[Gmail]/All Mail').rows.push({ ...message(1), uid: 999 });
    await rejects(async () => second.api.archive((await second.api.sync()).rows[0].handle), 'mismatch');
    second.api.stop();
  });
  await test('undo validates destination UIDVALIDITY and the five-second lifetime', async () => {
    let time = 1000;
    const { api, fake } = setup(undefined, { now: () => time });
    const result = await api.trash((await api.sync()).rows[0].handle);
    fake.boxes.get('[Gmail]/Trash').uidValidity = 31n;
    await rejects(() => api.undo(result.undo), 'invalid');
    time += 5001;
    await rejects(() => api.undo(result.undo), 'invalid');
    api.stop();
  });
  await test('diff emits only new INBOX messages, classifies bulk and ignores resets and own undo', async () => {
    const { api, fake } = setup();
    const before = await api.sync();
    assert.deepEqual(diffMail(null, before), []);
    fake.boxes.get('[Gmail]/All Mail').rows.push(message(800));
    const newsletter = message(2, { headers: Buffer.from('List-Unsubscribe: <mailto:off@example.com>\r\n') });
    const noreply = message(3); noreply.envelope.from[0].address = 'no-reply@example.com';
    const promotions = message(4, { labels: new Set(['\\Promotions']) });
    const social = message(5, { labels: new Set(['Category/Social']) });
    fake.boxes.get('INBOX').rows.push(newsletter, noreply, promotions, social, message(6));
    const next = await api.sync();
    assert.deepEqual(safe(diffMail(before, next)).map((e) => e.kind), ['bulk', 'bulk', 'bulk', 'bulk', 'person']);
    assert.deepEqual(diffMail(next, await api.sync()), []);
    const result = await api.archive(next.rows[0].handle);
    await api.undo(result.undo);
    assert.deepEqual(diffMail(next, await api.sync()), []);
    const old = await api.sync();
    fake.boxes.get('INBOX').uidValidity = 999n;
    assert.deepEqual(diffMail(old, await api.sync()), []);
    api.stop();
  });
  await test('IDLE events sync and the 60-second poll also works without IDLE', async () => {
    for (const idle of [true, false]) {
      const timers = new Map(); let id = 0;
      const views = [];
      const { api, fake } = setup(undefined, { schedule: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, cancel: (token) => timers.delete(token) });
      if (!idle) fake.capabilities.delete('IDLE');
      api.start((view, events) => views.push({ view, events }));
      await flush();
      assert.equal(views.length, 1);
      assert.equal([...timers.values()][0].ms, MAIL_POLL_MS);
      assert.equal(fake.calls.some((c) => c[0] === 'idle'), idle);
      fake.boxes.get('INBOX').rows.push(message(2));
      if (idle) fake.emit('exists', { path: 'INBOX', count: 2 });
      else { const timer = [...timers.values()][0]; timers.clear(); timer.fn(); }
      await flush();
      assert.equal(views.length, 2);
      assert.equal(views[1].events.length, 1);
      api.stop();
      assert.equal(timers.size, 0);
    }
  });
  await test('IDLE close reconnects using new clients and caps backoff at five minutes', async () => {
    const timers = new Map(), clients = [], views = [], delays = [];
    let id = 0, broken = false, time = 1000;
    const api = createImapMail({ account, credential: createMailCredential(PASSWORD),
      now: () => time,
      createClient: () => { const c = new FakeClient(); if (broken) c.connectError = Object.assign(new Error(PASSWORD), { code: 'ECONNRESET' }); clients.push(c); return c; },
      schedule: (fn, ms) => { delays.push(ms); timers.set(++id, { fn, ms }); return id; }, cancel: (token) => timers.delete(token),
    });
    api.start((v) => views.push(v), (e) => errors.push(e)); await flush();
    broken = true; clients[0].emit('close');
    assert.equal([...timers.values()][0].ms, 1000);
    for (let i = 0; i < 12; i++) {
      const timer = [...timers.values()][0]; timers.clear(); timer.fn(); await flush();
    }
    assert.equal([...timers.values()][0].ms, RECONNECT_CAP_MS);
    assert.ok(delays.every((d) => d <= RECONNECT_CAP_MS));
    assert.equal(reconnectDelay(1000), RECONNECT_CAP_MS);
    broken = false;
    const timer = [...timers.values()][0]; timers.clear(); timer.fn(); await flush();
    assert.equal(views.length, 2);
    assert.equal([...timers.values()][0].ms, MAIL_POLL_MS);
    time += MAIL_POLL_MS;
    const stable = [...timers.values()][0]; timers.clear(); stable.fn(); await flush();
    clients.at(-1).emit('error', Object.assign(new Error(PASSWORD), { code: 'ECONNRESET' }));
    assert.equal([...timers.values()][0].ms, 1000);
    api.stop();
  });
  await test('repeated immediate IDLE failures retain backoff across successful logins', async () => {
    const timers = new Map(); let id = 0;
    const api = createImapMail({ account, credential: createMailCredential(PASSWORD), now: () => 1000,
      createClient: () => {
        const c = new FakeClient();
        c.idle = async () => { throw Object.assign(new Error(PASSWORD), { code: 'ECONNRESET' }); };
        return c;
      },
      schedule: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, cancel: (token) => timers.delete(token),
    });
    api.start(() => {}, (error) => errors.push(error)); await flush();
    assert.equal([...timers.values()][0].ms, 1000);
    for (let i = 0; i < 12; i++) {
      const timer = [...timers.values()][0]; timers.clear(); timer.fn(); await flush();
    }
    assert.equal([...timers.values()][0].ms, RECONNECT_CAP_MS);
    api.stop();
  });
  await test('Gmail Promotions and Social come from Gmail search (X-GM-RAW), not from labels it never lists', async () => {
    const promo = message(2, { category: true });
    const { api, fake } = setup([message(1), promo]);
    const snapshot = await api.sync();
    const call = fake.calls.find((c) => c[0] === 'gmraw');
    assert.deepEqual(call, ['gmraw', 'category:promotions OR category:social', '1:2']);
    assert.deepEqual(snapshot.rows.map((r) => [r.subject, r.bulk]), [['Message 1', false], ['Message 2', true]]);
    api.stop();
    const plain = setup([message(1)]);
    plain.fake.capabilities.delete('X-GM-EXT-1');
    await plain.api.sync();
    assert.ok(!plain.fake.calls.some((c) => c[0] === 'gmraw'), 'only Gmail is asked');
    plain.api.stop();
  });
  await test('a failed category search costs the tab check only, unless the connection is gone', async () => {
    const { api, fake } = setup([message(1)]);
    fake.search = async () => { throw Object.assign(new Error(PASSWORD), { code: 'NO' }); };
    assert.equal((await api.sync()).rows.length, 1);
    fake.search = async () => { throw Object.assign(new Error(PASSWORD), { code: 'ECONNRESET' }); };
    await rejects(() => api.sync(), 'offline');
    api.stop();
  });
  await test('arrival time (INTERNALDATE) orders the inbox; an unparseable Date header falls back to it', async () => {
    const late = message(1, { internalDate: new Date('2026-11-06T15:00:00Z') });
    const early = message(2, { internalDate: new Date('2026-11-06T09:00:00Z') });
    early.envelope.date = 'Mon, 99 Foo 2026';
    const { api, fake } = setup([late, early]);
    const rows = (await api.sync()).rows;
    assert.deepEqual(rows.map((r) => [r.subject, r.date]), [['Message 1', '2026-11-06T15:00:00.000Z'], ['Message 2', '2026-11-06T09:00:00.000Z']]);
    assert.equal(fake.calls.find((c) => c[0] === 'fetch')[2].internalDate, true);
    api.stop();
  });
  await test('Gmail archive undo copies back: the message stays in All Mail, is in INBOX again, read back, and nothing moves out of All Mail', async () => {
    const { api, fake } = setup();
    fake.allMailKeeps = true;
    const handle = (await api.sync()).rows[0].handle;
    const { undo } = safe(await api.archive(handle));
    safe(await api.undo(undo));
    assert.ok(fake.boxes.get('INBOX').rows.length === 1, 'back in the inbox');
    assert.equal(fake.boxes.get('[Gmail]/All Mail').rows.length, 1, 'still in All Mail, as Gmail keeps it');
    assert.ok(!fake.calls.some((c) => c[0] === 'move' && c[1] === '[Gmail]/All Mail'), 'no MOVE out of All Mail');
    assert.equal(fake.calls.filter((c) => c[0] === 'copy').length, 1);
    // A copy that does not read back as the same message is a failure, as a move would be.
    const bad = setup();
    const h2 = (await bad.api.sync()).rows[0].handle;
    const r2 = await bad.api.archive(h2);
    bad.fake.destinationMismatch = true;
    const copy = bad.fake.messageCopy.bind(bad.fake);
    bad.fake.messageCopy = async (...a) => { const out = await copy(...a); bad.fake.boxes.get('INBOX').rows.at(-1).flags.add('\\Seen'); return out; };
    await rejects(() => bad.api.undo(r2.undo), 'mismatch');
    bad.api.stop();
    api.stop();
    const trash = setup();
    trash.fake.allMailKeeps = true;
    const t = await trash.api.trash((await trash.api.sync()).rows[0].handle);
    safe(await trash.api.undo(t.undo));
    trash.api.stop();
  });
  await test('GoDaddy archives to the folder marked \\Archive when there is one, before creating "Archive"', async () => {
    const { api, fake } = setup(undefined, { account: godaddy });
    fake.boxes.delete('[Gmail]/All Mail'); fake.boxes.delete('[Gmail]/Trash');
    fake.boxes.set('INBOX.Archived', { uidValidity: 50n, rows: [] });
    fake.boxes.set('INBOX.Deleted Items', { uidValidity: 51n, rows: [] });
    fake.list = async () => [...fake.boxes.keys()].map((name) => ({ path: name,
      specialUse: name === 'INBOX.Archived' ? '\\Archive' : name === 'INBOX.Deleted Items' ? '\\Trash' : undefined }));
    const handle = (await api.sync()).rows[0].handle;
    await api.archive(handle);
    assert.deepEqual(fake.calls.filter((c) => c[0] === 'move').at(-1), ['move', 'INBOX', 'INBOX.Archived', 1]);
    assert.ok(!fake.calls.some((c) => c[0] === 'create'));
    api.stop();
  });
  await test('Open in Gmail finds the message by its Message-ID; GoDaddy opens its webmail', async () => {
    const { api } = setup();
    const handle = (await api.sync()).rows[0].handle;
    assert.equal(api.webUrl(handle), 'https://mail.google.com/mail/u/?authuser=test%40gmail.com#search/rfc822msgid%3Amail-1%40example.com');
    assert.throws(() => api.webUrl(`${handle}x`));
    api.stop();
    const g = setup(undefined, { account: godaddy });
    assert.equal(g.api.webUrl((await g.api.sync()).rows[0].handle), 'https://email.godaddy.com/');
    g.api.stop();
  });
  await test('new mail events carry the sender address (for VIPs) and a stable key, never the password', async () => {
    const { api, fake } = setup();
    const before = await api.sync();
    fake.boxes.get('INBOX').rows.push(message(2));
    const events = safe(diffMail(before, await api.sync()));
    assert.deepEqual(events.map((e) => [e.fromAddress, e.key]), [['person@example.com', 'gmail:10:2']]);
    api.stop();
  });
  await test('plain text is never tokenized: <https://...>, <anna@...> and a stray < keep everything after them', () => {
    const samples = [
      'See the brief <https://client.example/brief?a=1&b=2> before Friday.',
      'From: Anna <anna@client.example>\nThanks!',
      'If a < b then the rest of this line, and the next one,\nmust survive.',
    ];
    for (const text of samples) assert.equal(mailToText(text, false), text);
    // HTML bodies still go through the tokenizer.
    assert.equal(mailToText('<p>a <b>b</b></p>', true), 'a b');
  });
  await test('a subject or sender with < and > survives IMAP sync as text', async () => {
    const row = message(1);
    row.envelope.subject = 'Re: <anna@client.example> asked about 3 < 5 rooms';
    row.envelope.from[0].name = 'Anna <Client>';
    const { api } = setup([row]);
    const r = (await api.sync()).rows[0];
    assert.equal(r.subject, 'Re: <anna@client.example> asked about 3 < 5 rooms');
    assert.equal(r.fromName, 'Anna <Client>');
    api.stop();
  });
  await test('a text/plain body keeps <https://...> links and everything after a stray <', async () => {
    const body = 'Link: <https://client.example/x>\nIf 3 < 5, keep this.\nRegards';
    const { api } = setup([message(1, { body, bodyStructure: { type: 'text/plain', part: '1', size: 100 } })]);
    const opened = await api.open((await api.sync()).rows[0].handle);
    assert.equal(opened.text, body);
    api.stop();
  });
  await test("imapflow's own error codes map to fixed kinds", () => {
    for (const [code, kind] of [['ETIMEOUT', 'offline'], ['CONNECT_TIMEOUT', 'offline'], ['GREETING_TIMEOUT', 'offline'], ['NoConnection', 'offline'], ['ETHROTTLE', 'rate'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls']]) {
      const e = mailFailure(Object.assign(new Error(PASSWORD), { code }));
      assert.equal(e.kind, kind, code);
      assert.ok(!String(e).includes(PASSWORD));
    }
    assert.equal(mailFailure(Object.assign(new Error(PASSWORD), { authenticationFailed: true })).kind, 'auth');
  });
  await test("the REAL imapflow 2.2.6: imap.ts's options are its options, TLS verified, logging off, every method it calls exists", async () => {
    allowRealImapflow = true;
    try {
      const types = await fs.readFile(path.join(root, 'node_modules/imapflow/dist/cjs/types.d.ts'), 'utf8');
      const block = (name) => {
        const start = types.indexOf(`export interface ${name} {`);
        assert.ok(start >= 0, name);
        const end = types.indexOf('\n}', start);
        return new Set([...types.slice(start, end).matchAll(/^\s{4}([A-Za-z]+)\??:/gm)].map((m) => m[1]));
      };
      let real = null;
      let built = null;
      const api = createImapMail({ account, credential: createMailCredential(PASSWORD), createClient(options) {
        built = options;
        real = imapflowClient(options);
        // Never a real connection from a test: the first network step fails here instead.
        real.connect = async () => { throw Object.assign(new Error(PASSWORD), { code: 'ECONNREFUSED' }); };
        return real;
      } });
      await rejects(() => api.sync(), 'offline');
      assert.ok(real, 'imapflow constructed');
      assert.equal(real.constructor.name, 'ImapFlow');
      const known = block('ImapFlowOptions');
      for (const k of Object.keys(built)) assert.ok(known.has(k), `ImapFlowOptions has ${k}`);
      assert.equal(real.options.secure, true);
      assert.equal(real.options.port, 993);
      assert.equal(real.options.tls.rejectUnauthorized, true, 'certificates are verified');
      assert.notEqual(real.options.tls.rejectUnauthorized, false);
      assert.equal(real.options.logger, false);
      assert.equal(real.options.emitLogs, false);
      assert.equal(real.options.logRaw, false);
      assert.ok(real.capabilities instanceof Map);
      for (const m of ['connect', 'close', 'on', 'getMailboxLock', 'fetch', 'fetchOne', 'download', 'messageFlagsAdd', 'messageFlagsRemove', 'messageMove', 'messageCopy', 'mailboxCreate', 'list', 'search', 'status', 'noop', 'idle']) {
        assert.equal(typeof real[m], 'function', `ImapFlow.${m}`);
      }
      const fetchKeys = block('FetchQueryObject');
      for (const k of ['uid', 'flags', 'envelope', 'size', 'internalDate', 'headers', 'labels', 'bodyStructure']) assert.ok(fetchKeys.has(k), `FetchQueryObject.${k}`);
      for (const k of ['uid', 'maxBytes']) assert.ok(block('DownloadOptions').has(k), `DownloadOptions.${k}`);
      for (const k of ['uid', 'header', 'gmraw']) assert.ok(block('SearchObject').has(k), `SearchObject.${k}`);
      for (const k of ['uidValidity', 'uidMap']) assert.ok(block('CopyResponseObject').has(k), `CopyResponseObject.${k}`);
      for (const k of ['path', 'specialUse']) assert.ok(block('ListResponse').has(k), `ListResponse.${k}`);
      for (const k of ['path', 'uidValidity', 'exists']) assert.ok(block('MailboxObject').has(k), `MailboxObject.${k}`);
      // With logger false imapflow writes nothing, even at error level, so a LOGIN line cannot reach a log.
      const count = logs.length;
      real.log.error({ msg: PASSWORD, err: new Error(PASSWORD) });
      real.log.fatal({ msg: PASSWORD });
      real.log.info({ msg: PASSWORD });
      assert.equal(logs.length, count, 'imapflow logged something');
      api.stop();
    } finally {
      allowRealImapflow = false;
    }
  });
  await test('server and download errors never expose credentials', async () => {
    const { api, fake } = setup();
    const handle = (await api.sync()).rows[0].handle;
    fake.readError = new Error(PASSWORD);
    await rejects(() => api.flag(handle), 'server');
    fake.readError = null; fake.downloadError = new Error(PASSWORD);
    await rejects(() => api.open(handle), 'server');
    api.stop();
    safe(api);
    assert.ok(!JSON.stringify(returned).includes(PASSWORD));
    assert.ok(!JSON.stringify(errors).includes(PASSWORD));
    assert.ok(!logs.join('\n').includes(PASSWORD));
  });
  await test('pinned dependency lock has a complete compatible production dependency tree', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
    const semver = require('semver');
    const base = 'node_modules/imapflow';
    const entry = lock.packages[base];
    assert.equal(entry.version, manifest.dependencies.imapflow);
    assert.match(manifest.dependencies.imapflow, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[''].dependencies.imapflow, entry.version);
    const pending = [[base, entry]], visited = new Set();
    while (pending.length) {
      const [parentPath, parent] = pending.pop();
      for (const [name, range] of Object.entries(parent.dependencies ?? {})) {
        // Node's own lookup: this package's node_modules, then each enclosing one, up to the root
        // (npm may hoist a dependency, as `npm audit fix` hoisted socks' ip-address).
        const candidates = [];
        for (let at = parentPath; at; at = at.includes('/node_modules/') ? at.slice(0, at.lastIndexOf('/node_modules/')) : '') {
          candidates.push(`${at}/node_modules/${name}`);
        }
        candidates.push(`node_modules/${name}`);
        const childPath = candidates.find((c) => lock.packages[c]) ?? candidates[0];
        const child = lock.packages[childPath];
        assert.ok(child, `locked dependency ${name}`);
        assert.ok(semver.satisfies(child.version, range), `${name} satisfies ${range}`);
        assert.match(child.integrity, /^sha512-/);
        if (!visited.has(childPath)) { visited.add(childPath); pending.push([childPath, child]); }
      }
    }
  });
} finally {
  for (const [name, fn] of Object.entries(originalConsole)) console[name] = fn;
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
