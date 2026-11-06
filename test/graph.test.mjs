/**
 * Microsoft 365 through Graph (src/main/work/graph.ts), offline: a fake
 * Microsoft (token endpoint and Graph) and the real loopback listener.
 *
 *   - PKCE: the verifier and its S256 challenge, a fresh state per sign-in.
 *   - The loopback: bound to 127.0.0.1 only, exactly one request, a wrong
 *     state refused, a timeout, and closed afterwards in every case.
 *   - The sign-in end to end: the code is redeemed with the verifier, the
 *     mailbox must be gustav@muchbetter.world, the refresh token is stored
 *     encrypted, refresh rotates it.
 *   - Mail: the delta baseline notifies nothing; new mail does; bulk is
 *     classified; read, flag, archive, trash with read-back; never a DELETE;
 *     undo by the moved id; the body reaches the caller as text, never HTML.
 *   - THE TOKENS: planted access and refresh tokens are searched for in every
 *     return value, error, log line and file (only the encrypted store may
 *     hold one, and not in plain text).
 *
 * Nothing here reaches login.microsoftonline.com or graph.microsoft.com.
 */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mbw-graph-'));
const require = createRequire(import.meta.url);
const ACCESS1 = 'planted-access-token-ONE-must-not-leak-41f2';
const ACCESS2 = 'planted-access-token-TWO-must-not-leak-77aa';
const REFRESH1 = 'planted-refresh-token-ONE-must-not-leak-90cd';
const REFRESH2 = 'planted-refresh-token-TWO-must-not-leak-13be';
const CODE = 'planted.auth-code_ONE~must-not-leak';
const SECRETS = [ACCESS1, ACCESS2, REFRESH1, REFRESH2, CODE];
const key = randomBytes(32);
const GRAPH = 'https://graph.microsoft.com/v1.0';

const electron = {
  app: { getPath: () => tmp },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  },
};

const cache = new Map();
async function load(relative) {
  const filename = path.join(root, relative);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === 'electron') return electron;
    if (name.startsWith('.')) {
      const dependency = cache.get(path.resolve(path.dirname(filename), `${name}.ts`));
      assert.ok(dependency, `load local dependencies first: ${name}`);
      return dependency;
    }
    return require(name);
  };
  runInThisContext(`(function(require, module, exports) { ${compiled}\n})`, { filename })(localRequire, module, module.exports);
  cache.set(filename, module.exports);
  return module.exports;
}

await load('src/shared/mail-view.ts');
await load('src/main/work/mail-text.ts');
await load('src/main/work/mail-accounts.ts');
const G = await load('src/main/work/graph.ts');

const logs = [];
const returned = [];
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
for (const k of Object.keys(original)) console[k] = (...a) => logs.push(a.map(String).join(' '));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; original.log(`  PASS  ${name}`); }
  catch (error) {
    failed++;
    let text = String(error?.stack ?? error);
    for (const s of SECRETS) text = text.replaceAll(s, '[redacted]');
    original.log(`  FAIL  ${name}: ${text}`);
  }
}
const keep = (v) => { returned.push(v); return v; };
const clean = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  for (const s of SECRETS) assert.ok(!String(text).includes(s), `${label} holds a planted secret`);
};

// ── A fake Microsoft ────────────────────────────────────────────────────────

function message(n, o = {}) {
  return {
    id: `AAMkMSG${n}==`, receivedDateTime: new Date(Date.UTC(2026, 10, 6, 8, n)).toISOString(), isRead: false,
    flag: { flagStatus: 'notFlagged' }, subject: `Subject ${n}`, from: { emailAddress: { name: `Person ${n}`, address: `person${n}@example.com` } },
    bodyPreview: `Preview ${n}`, inferenceClassification: 'focused', internetMessageId: `<m${n}@example.com>`,
    webLink: `https://outlook.office365.com/owa/?ItemID=AAMkMSG${n}%3D%3D&exvsurl=1`, parentFolderId: 'FOLDER-INBOX',
    body: { contentType: 'html', content: `<p>Hello <b>${n}</b></p>` }, hasAttachments: false, headers: [], ...o,
  };
}

function microsoft(options = {}) {
  const m = {
    calls: [], account: options.account ?? 'gustav@muchbetter.world', access: null, refresh: null, challenge: null, redirect: null,
    messages: new Map(), pending: [], gone: false, ignorePatch: false, throttle: 0, moves: 0, unread: 3,
  };
  for (const msg of options.messages ?? []) m.messages.set(msg.id, msg);
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (n) => headers[n] ?? headers[n.toLowerCase()] ?? null },
    json: async () => body,
  });
  const view = (msg, select) => {
    const fields = select ? select.split(',') : Object.keys(msg);
    const out = { id: msg.id };
    for (const f of fields) if (f in msg) out[f] = msg[f];
    if (fields.includes('internetMessageHeaders')) out.internetMessageHeaders = msg.headers;
    return out;
  };
  m.fetch = async (url, init) => {
    m.calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal, 'every request has an abort signal');
    if (url === `https://login.microsoftonline.com/${G.TENANT_ID}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('client_id'), G.CLIENT_ID);
      assert.equal(form.get('client_secret'), null, 'a public client sends no secret');
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== CODE) return reply(400, { error: 'invalid_grant', error_description: `code ${form.get('code')}` });
        assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), m.challenge, 'the verifier matches the challenge');
        assert.equal(form.get('redirect_uri'), m.redirect, 'the same redirect_uri as the authorize request');
        m.access = ACCESS1;
        m.refresh = REFRESH1;
        return reply(200, { access_token: ACCESS1, refresh_token: REFRESH1, expires_in: 3600, token_type: 'Bearer' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        m.refreshes = (m.refreshes ?? 0) + 1;
        if (m.holdRefresh) await m.holdRefresh;
        if (form.get('refresh_token') !== m.refresh) return reply(400, { error: 'invalid_grant', error_description: `refresh ${form.get('refresh_token')} is bad` });
        m.access = m.access === ACCESS1 ? ACCESS2 : ACCESS1;
        m.refresh = m.refresh === REFRESH1 ? REFRESH2 : REFRESH1;
        return reply(200, { access_token: m.access, refresh_token: m.refresh, expires_in: 3600 });
      }
      return reply(400, { error: 'unsupported_grant_type' });
    }
    assert.ok(url.startsWith(`${GRAPH}/`), `only Graph: ${url.slice(0, 40)}`);
    assert.notEqual(init.method, 'DELETE', 'never a DELETE');
    if (init.headers.Authorization !== `Bearer ${m.access}`) return reply(401, { error: { code: 'InvalidAuthenticationToken', message: `token ${init.headers.Authorization}` } });
    if (m.holdMe && url.startsWith(`${GRAPH}/me?`)) {
      m.meAsked = true;
      await m.holdMe;
    }
    if (m.failUnread && /unreadItemCount/.test(url)) {
      m.failUnread--;
      return reply(500, { error: { code: 'InternalServerError' } });
    }
    if (m.meUnauthorizedOnce && url.startsWith(`${GRAPH}/me?`)) {
      m.meUnauthorizedOnce = false;
      return reply(401, { error: { code: 'InvalidAuthenticationToken' } });
    }
    if (m.throttleHeaders && /internetMessageHeaders/.test(url)) {
      m.throttleHeaders--;
      return reply(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': '30' });
    }
    if (m.throttle) {
      m.throttle--;
      return reply(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': m.retryAfter ?? '7' });
    }
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    const select = u.searchParams.get('$select');
    if (p === '/me') return reply(200, { mail: m.account, userPrincipalName: m.account });
    if (p === '/me/mailFolders/inbox/messages/delta') {
      if (m.gone) {
        m.gone = false;
        return reply(410, { error: { code: 'SyncStateNotFound' } });
      }
      if (m.alwaysGone) {
        // Capped, so code that loops on 410 ends (as a 500) instead of hanging the suite.
        m.goneCalls = (m.goneCalls ?? 0) + 1;
        return m.goneCalls > 20 ? reply(500, {}) : reply(410, { error: { code: 'SyncStateNotFound' } });
      }
      const delta = u.searchParams.get('$deltatoken');
      if (!delta) {
        assert.match(url, /\$orderby=receivedDateTime\+desc/);
        assert.match(url, /\$filter=receivedDateTime\+ge\+\d{4}-/);
        assert.match(init.headers.Prefer, /^odata\.maxpagesize=\d+$/);
        const inbox = [...m.messages.values()].filter((x) => x.parentFolderId === 'FOLDER-INBOX').map((x) => view(x, select));
        return reply(200, { value: inbox, '@odata.deltaLink': `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=D1` });
      }
      const value = m.pending.splice(0);
      return reply(200, { value, '@odata.deltaLink': `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=D${m.calls.length}` });
    }
    if (p === '/me/mailFolders/inbox' && select === 'unreadItemCount') return reply(200, { unreadItemCount: m.unread });
    const folder = /^\/me\/mailFolders\/(inbox|archive|deleteditems)$/.exec(p);
    if (folder) return reply(200, { id: `FOLDER-${folder[1].toUpperCase()}` });
    const one = /^\/me\/messages\/([^/]+)(\/move|\/attachments)?$/.exec(p);
    if (one) {
      const msg = m.messages.get(one[1]);
      if (!msg) return reply(404, { error: { code: 'ErrorItemNotFound' } });
      if (one[2] === '/attachments') return reply(200, { value: [{ name: 'quote.pdf', size: 2048, isInline: false }, { name: 'logo.png', size: 10, isInline: true }] });
      if (one[2] === '/move') {
        assert.equal(init.method, 'POST');
        const dest = JSON.parse(init.body).destinationId;
        assert.ok(['archive', 'deleteditems', 'inbox'].includes(dest), `a well-known folder: ${dest}`);
        m.messages.delete(msg.id);
        const moved = { ...msg, id: `AAMkMOVED${++m.moves}==`, parentFolderId: `FOLDER-${dest.toUpperCase()}` };
        m.messages.set(moved.id, moved);
        return reply(201, view(moved));
      }
      if (init.method === 'PATCH') {
        if (!m.ignorePatch) Object.assign(msg, JSON.parse(init.body));
        return reply(200, view(msg));
      }
      return reply(200, view(msg, select));
    }
    return reply(404, { error: { code: 'NotFound' } });
  };
  return m;
}

/** What the browser does: follow the authorize URL to the loopback redirect with a code. */
function browser(m, behaviour = 'good') {
  return async (url) => {
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, `https://login.microsoftonline.com/${G.TENANT_ID}/oauth2/v2.0/authorize`);
    m.challenge = u.searchParams.get('code_challenge');
    m.redirect = u.searchParams.get('redirect_uri');
    const port = Number(new URL(m.redirect).port);
    const state = behaviour === 'state' ? 'not-the-state' : u.searchParams.get('state');
    setTimeout(() => http.get(`http://127.0.0.1:${port}/?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(state)}`, (r) => r.resume()).on('error', () => undefined), 5);
  };
}

const get = (port, query, host = '127.0.0.1') => new Promise((resolve, reject) => {
  const req = http.get({ host, port, path: `/${query}`, agent: false }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
});
const refusedAt = (port, host) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.on('connect', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(true));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  original.log('\nPKCE and the loopback listener');

  await test('PKCE: a 43 character base64url verifier and its S256 challenge, fresh every time', () => {
    const a = G.pkce(), b = G.pkce();
    assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(a.challenge, createHash('sha256').update(a.verifier).digest('base64url'));
    assert.notEqual(a.verifier, b.verifier);
    assert.notEqual(G.newState(), G.newState());
    const url = new URL(G.authorizeUrl({ challenge: a.challenge, state: 'S1', redirectUri: 'http://127.0.0.1:5555' }));
    assert.equal(url.origin + url.pathname, `https://login.microsoftonline.com/${G.TENANT_ID}/oauth2/v2.0/authorize`);
    for (const [k, v] of Object.entries({ client_id: G.CLIENT_ID, response_type: 'code', code_challenge: a.challenge, code_challenge_method: 'S256', state: 'S1', redirect_uri: 'http://127.0.0.1:5555', scope: 'offline_access User.Read Mail.ReadWrite' })) {
      assert.equal(url.searchParams.get(k), v, k);
    }
    assert.equal(url.searchParams.get('code_verifier'), null, 'the verifier never leaves the app before the token request');
    assert.ok(!G.SCOPES.includes('Mail.Send'), 'no Mail.Send until phase 4 sends mail');
  });

  await test('the listener is on 127.0.0.1 only, takes exactly one request, then is closed', async () => {
    const loop = await G.startLoopback('STATE-1', 5000);
    assert.equal(loop.redirectUri, `http://127.0.0.1:${loop.port}`, 'the redirect is the IPv4 literal the listener is on (RFC 8252 8.3)');
    assert.ok(await refusedAt(loop.port, '::1'), 'not on the IPv6 loopback');
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) assert.ok(await refusedAt(loop.port, lan.address), 'not on a network address');
    const first = await get(loop.port, `?code=${encodeURIComponent(CODE)}&state=STATE-1`);
    assert.equal(first.status, 200);
    clean('the page the browser shows', first.body);
    assert.equal(await loop.code, CODE);
    assert.ok(loop.closed());
    await wait(30);
    assert.ok(await refusedAt(loop.port, '127.0.0.1'), 'a second request finds nothing listening');
  });

  await test('a wrong state is refused at once (not waited past), and the listener closes', async () => {
    const loop = await G.startLoopback('STATE-2', 5000);
    const r = await get(loop.port, `?code=${encodeURIComponent(CODE)}&state=STATE-X`);
    assert.equal(r.status, 400);
    await assert.rejects(loop.code, (e) => e.name === 'SignInError' && e.reason === 'state' && !String(e).includes(CODE));
    assert.ok(loop.closed());
    await wait(30);
    assert.ok(await refusedAt(loop.port, '127.0.0.1'));
  });

  await test('an error from Microsoft, a missing code and another path all fail closed', async () => {
    for (const [query, reason] of [['?error=access_denied&state=S', 'denied'], ['?state=S', 'invalid'], ['nope?code=x&state=S', 'invalid'], ['?code=%3Cscript%3E&state=S', 'invalid']]) {
      const loop = await G.startLoopback('S', 5000);
      await get(loop.port, query);
      await assert.rejects(loop.code, (e) => e.reason === reason, query);
      assert.ok(loop.closed());
    }
  });

  await test('no answer within the time limit: "timeout", and the listener closes', async () => {
    const loop = await G.startLoopback('S', 80);
    await assert.rejects(loop.code, (e) => e.reason === 'timeout');
    assert.ok(loop.closed());
    await wait(20);
    assert.ok(await refusedAt(loop.port, '127.0.0.1'));
    const two = await G.startLoopback('S', 5000);
    two.cancel();
    await assert.rejects(two.code, (e) => e.reason === 'cancelled');
    assert.ok(two.closed());
  });

  original.log('\nsign-in, the stored token and the session');
  const file = path.join(tmp, 'graph-token.bin');

  await test('sign-in: code redeemed with the verifier, the mailbox checked, the refresh token stored encrypted', async () => {
    const m = microsoft();
    const account = G.createGraphAccount({ fetch: m.fetch, openExternal: browser(m), file, timeoutMs: 2000, signInMs: 5000 });
    const session = keep(await account.signIn());
    assert.deepEqual(Object.keys(session).sort(), ['close', 'request'], 'the session is opaque');
    const bytes = await fs.readFile(file);
    for (const s of SECRETS) assert.ok(!bytes.includes(Buffer.from(s)), 'no secret in plain text on disk');
    const me = keep(await session.request('GET', '/me?$select=mail'));
    assert.equal(me.body.mail, 'gustav@muchbetter.world');
    const loaded = keep(await account.load());
    assert.ok(loaded);
  });

  await test('another Microsoft account is refused and nothing is stored', async () => {
    const m = microsoft({ account: 'someone@muchbetter.world' });
    const other = path.join(tmp, 'other-token.bin');
    const account = G.createGraphAccount({ fetch: m.fetch, openExternal: browser(m), file: other, timeoutMs: 2000, signInMs: 5000 });
    await assert.rejects(account.signIn(), (e) => e.reason === 'account');
    await assert.rejects(fs.access(other));
  });

  await test('a browser that comes back with the wrong state: refused, no token request at all', async () => {
    const m = microsoft();
    const other = path.join(tmp, 'state-token.bin');
    const account = G.createGraphAccount({ fetch: m.fetch, openExternal: browser(m, 'state'), file: other, timeoutMs: 2000, signInMs: 5000 });
    await assert.rejects(account.signIn(), (e) => e.reason === 'state');
    assert.equal(m.calls.length, 0);
    await assert.rejects(fs.access(other));
  });

  await test('refresh rotates the refresh token on disk; a 401 refreshes once and retries', async () => {
    const m = microsoft();
    m.access = ACCESS1; m.refresh = REFRESH1;
    const rotated = [];
    const s = G.createGraphSession({ fetch: m.fetch, refresh: REFRESH1, rotate: async (t) => { rotated.push(t); }, timeoutMs: 2000 });
    keep(await s.request('GET', '/me'));
    assert.equal(rotated.length, 1, 'no access token yet: one refresh, rotated');
    m.access = 'revoked';
    keep(await s.request('GET', '/me'));
    assert.equal(rotated.length, 2, 'a 401 refreshes once and retries');
    // The rotated values are what the store saw; they are never returned anywhere else.
    clean('the replies', returned);
  });

  await test('a refused refresh token is "auth"; a 429 is "rate" with its Retry-After; no server words', async () => {
    const m = microsoft();
    m.refresh = REFRESH2;
    const s = G.createGraphSession({ fetch: m.fetch, refresh: REFRESH1, rotate: async () => undefined, timeoutMs: 2000 });
    await assert.rejects(s.request('GET', '/me'), (e) => e.kind === 'auth' && !String(e).includes(REFRESH1) && !JSON.stringify(e).includes(REFRESH1));
    m.refresh = REFRESH1;
    const t = G.createGraphSession({ fetch: m.fetch, refresh: REFRESH1, rotate: async () => undefined, timeoutMs: 2000 });
    keep(await t.request('GET', '/me'));
    m.throttle = 1;
    await assert.rejects(t.request('GET', '/me'), (e) => e.kind === 'rate' && e.retryAfterMs === 7000);
    await assert.rejects(t.request('GET', 'https://evil.example/v1.0/me'), (e) => e.kind === 'invalid');
  });

  original.log('\nmail through Graph');

  // A fixed clock before every sample message's arrival (08:00 UTC on), so "new" is decided by the rules, not the day the suite runs.
  const mailSetup = (messages, now = () => Date.UTC(2026, 10, 6, 7, 0)) => {
    const m = microsoft({ messages });
    m.access = ACCESS1; m.refresh = REFRESH1;
    const session = G.createGraphSession({ fetch: m.fetch, refresh: REFRESH1, rotate: async () => undefined, timeoutMs: 2000, now });
    const timers = [];
    const mail = G.createGraphMail({ session, account: { id: 'muchbetter', label: 'MuchBetter', colour: '#4f8fe8' }, now,
      schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => undefined });
    return { m, mail, timers };
  };

  await test('the first delta is a baseline (no notices); later mail is an event; Other, List-Unsubscribe and no-reply are bulk; @removed drops a row', async () => {
    const { m, mail, timers } = mailSetup([message(1), message(2, { isRead: 'true' })]);
    const seen = [];
    mail.start((s, events) => seen.push({ s, events }));
    await wait(30);
    assert.equal(seen.length, 1);
    const first = keep(seen[0]);
    assert.equal(first.events.length, 0, 'old mail does not notify');
    assert.equal(first.s.rows.length, 2);
    assert.equal(first.s.rows[0].subject, 'Subject 2', 'newest first');
    assert.equal(first.s.rows[0].seen, true, '"true" as a string reads as read, as in the Graph samples');
    assert.equal(first.s.account.unread, 3);
    assert.equal(first.s.account.provider, 'graph');
    assert.equal(timers.at(-1).ms, 60_000, 'the next sync in 60 s');
    const fresh = message(3);
    const promo = message(4, { inferenceClassification: 'other' });
    const listed = message(5, { headers: [{ name: 'List-Unsubscribe', value: '<mailto:x@y>' }] });
    const noreply = message(6, { from: { emailAddress: { name: 'Shop', address: 'no-reply@shop.example' } } });
    for (const x of [fresh, promo, listed, noreply]) m.messages.set(x.id, x);
    m.pending.push(fresh, promo, listed, noreply, { id: 'AAMkMSG1==', '@removed': { reason: 'deleted' } });
    timers.at(-1).fn();
    await wait(40);
    assert.equal(seen.length, 2);
    const last = keep(seen[1]);
    const kinds = Object.fromEntries(last.events.map((e) => [e.subject, e.kind]));
    assert.deepEqual(kinds, { 'Subject 3': 'person', 'Subject 4': 'bulk', 'Subject 5': 'bulk', 'Subject 6': 'bulk' });
    assert.ok(last.events.every((e) => /^muchbetter:[0-9a-f]{32}$/.test(e.key)), 'stable hashed keys');
    assert.ok(!last.s.rows.some((r) => r.subject === 'Subject 1'), '@removed drops the row');
    const headerChecks = m.calls.filter((c) => /internetMessageHeaders/.test(c.url)).length;
    assert.ok(headerChecks >= 1 && headerChecks <= 5, 'headers are asked for a few new messages only');
    mail.stop();
  });

  await test('a 429 waits at least its Retry-After before the next sync', async () => {
    const { m, mail, timers } = mailSetup([message(1)]);
    m.throttle = 1;
    m.retryAfter = '120';
    let failedKind = null;
    mail.start(() => undefined, (e) => { failedKind = e.kind; });
    await wait(30);
    assert.equal(failedKind, 'rate');
    assert.equal(timers.at(-1).ms, 120_000, 'Retry-After 120 s is longer than the 60 s tick, so it wins');
    mail.stop();
  });

  await test('an expired delta (410) starts a new baseline that notifies nothing', async () => {
    const { m, mail } = mailSetup([message(1)]);
    await mail.sync();
    m.gone = true;
    m.messages.set('AAMkMSG9==', message(9));
    const seen = [];
    mail.start((s, events) => seen.push({ s, events }));
    await wait(40);
    assert.equal(seen.at(-1).events.length, 0);
    assert.ok(seen.at(-1).s.rows.some((r) => r.subject === 'Subject 9'));
    mail.stop();
  });

  await test('read, unread, flag and unflag PATCH and read back; a write that does not stick is a failure', async () => {
    const { m, mail } = mailSetup([message(1)]);
    const h = (await mail.sync()).rows[0].handle;
    assert.equal(keep(await mail.markRead(h)).seen, true);
    assert.equal(keep(await mail.markUnread(h)).seen, false);
    assert.equal(keep(await mail.flag(h)).flagged, true);
    assert.equal(keep(await mail.unflag(h)).flagged, false);
    const patches = m.calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body));
    assert.deepEqual(patches, [{ isRead: true }, { isRead: false }, { flag: { flagStatus: 'flagged' } }, { flag: { flagStatus: 'notFlagged' } }]);
    m.ignorePatch = true;
    await assert.rejects(mail.markRead(h), (e) => e.kind === 'mismatch');
    await assert.rejects(mail.markRead(`${h}x`), (e) => e.kind === 'invalid');
    mail.stop();
  });

  await test('archive and trash MOVE to the well-known folders, proved by the moved id; never DELETE; undo moves back', async () => {
    for (const [method, dest] of [['archive', 'archive'], ['trash', 'deleteditems']]) {
      const { m, mail } = mailSetup([message(1)]);
      const h = (await mail.sync()).rows[0].handle;
      const { undo } = keep(await mail[method](h));
      const move = m.calls.find((c) => /\/move$/.test(c.url));
      assert.equal(move.method, 'POST');
      assert.deepEqual(JSON.parse(move.body), { destinationId: dest });
      assert.equal([...m.messages.values()][0].parentFolderId, `FOLDER-${dest.toUpperCase()}`);
      const back = keep(await mail.undo(undo));
      assert.match(back.handle, /^[A-Za-z0-9_-]+$/);
      assert.equal([...m.messages.values()][0].parentFolderId, 'FOLDER-INBOX', 'back in the inbox');
      const lastMove = m.calls.filter((c) => /\/move$/.test(c.url)).at(-1);
      assert.match(decodeURIComponent(lastMove.url), /AAMkMOVED1==\/move$/, 'undo moves the id the first move returned');
      assert.deepEqual(JSON.parse(lastMove.body), { destinationId: 'inbox' });
      await assert.rejects(mail.undo(undo), (e) => e.kind === 'invalid');
      assert.ok(m.calls.every((c) => c.method !== 'DELETE'));
      mail.stop();
    }
  });

  await test('undo after 5 seconds is refused', async () => {
    let clock = 1000;
    const m = microsoft({ messages: [message(1)] });
    m.access = ACCESS1; m.refresh = REFRESH1;
    const session = G.createGraphSession({ fetch: m.fetch, refresh: REFRESH1, rotate: async () => undefined, timeoutMs: 2000, now: () => clock });
    const mail = G.createGraphMail({ session, account: { id: 'muchbetter', label: 'MuchBetter', colour: '#4f8fe8' }, now: () => clock, schedule: () => 0, cancel: () => undefined });
    const { undo } = await mail.trash((await mail.sync()).rows[0].handle);
    clock += 5001;
    await assert.rejects(mail.undo(undo), (e) => e.kind === 'invalid');
    mail.stop();
  });

  await test('the body is fetched on open and comes back as text: no tags, no remote image, links as text', async () => {
    const html = '<html><head><style>p{}</style></head><body><script>steal()</script><p>Hi Gustav,</p><img src="https://tracker.example/p.gif"><a href="https://bank.example/login">Pay here</a></body></html>';
    const { mail } = mailSetup([message(1, { body: { contentType: 'html', content: html }, hasAttachments: true })]);
    const h = (await mail.sync()).rows[0].handle;
    const body = keep(await mail.open(h));
    assert.doesNotMatch(body.text, /[<>]|steal|tracker|p\{\}/);
    assert.match(body.text, /Hi Gustav,/);
    assert.match(body.text, /Pay here \(https:\/\/bank\.example\/login\)/);
    assert.deepEqual(body.attachments, [{ name: 'quote.pdf', size: 2048 }]);
    assert.match(mail.webUrl(h), /^https:\/\/outlook\.office365\.com\/owa\//);
    mail.stop();
  });

  await test('a webLink that is not Outlook is never used', async () => {
    const { mail } = mailSetup([message(1, { webLink: 'https://evil.example/owa' })]);
    const h = (await mail.sync()).rows[0].handle;
    assert.equal(mail.webUrl(h), 'https://outlook.office.com/mail/inbox');
    mail.stop();
  });

  await test('a store over 500: an old message changed in Outlook is not new mail; a message that just arrived is', async () => {
    const old = Array.from({ length: 600 }, (_, i) => message(1000 + i, { receivedDateTime: new Date(Date.UTC(2026, 9, 10) + i * 3_600_000).toISOString() }));
    const { m, mail, timers } = mailSetup(old);
    const seen = [];
    mail.start((s, events) => seen.push({ s, events }));
    await wait(80);
    assert.equal(seen[0].s.rows.length, 200);
    // The oldest is long out of the 500 kept; Outlook marks it read and the delta sends it again.
    const oldest = { ...m.messages.get('AAMkMSG1000=='), isRead: true };
    m.pending.push(oldest, message(7));
    timers.at(-1).fn();
    await wait(80);
    assert.deepEqual(seen[1].events.map((e) => e.subject), ['Subject 7']);
    mail.stop();
  });

  await test('a delta that keeps expiring (410 twice in a row) fails in plain words instead of looping', async () => {
    const { m, mail } = mailSetup([message(1)]);
    await mail.sync();
    m.alwaysGone = true;
    await assert.rejects(mail.sync(), (e) => e.kind === 'server' && e.message === 'Mail operation failed.');
    assert.equal(m.goneCalls, 2);
    mail.stop();
  });

  await test('a 429 while checking headers keeps the new mail: its notice goes out on the next tick', async () => {
    const { m, mail, timers } = mailSetup([message(1)]);
    const seen = [], errs = [];
    mail.start((s, events) => seen.push(events), (e) => errs.push(e.kind));
    await wait(40);
    const fresh = message(3);
    m.messages.set(fresh.id, fresh);
    m.pending.push(fresh);
    m.throttleHeaders = 1;
    timers.at(-1).fn();
    await wait(40);
    assert.deepEqual(errs, ['rate']);
    assert.equal(timers.at(-1).ms, 60_000, 'waits (Retry-After 30 s, under the 60 s tick)');
    timers.at(-1).fn();
    await wait(40);
    assert.deepEqual(seen.at(-1).map((e) => [e.subject, e.kind]), [['Subject 3', 'person']]);
    mail.stop();
  });

  await test('plain text from Graph keeps < and >: a subject with <anna@...> and a text body with <https://...>', async () => {
    const { mail } = mailSetup([message(1, { subject: 'Re: <anna@client.example> 3 < 5', body: { contentType: 'text', content: 'See <https://client.example/x> and 3 < 5.\nBye' } })]);
    const s = await mail.sync();
    assert.equal(s.rows[0].subject, 'Re: <anna@client.example> 3 < 5');
    assert.equal((await mail.open(s.rows[0].handle)).text, 'See <https://client.example/x> and 3 < 5.\nBye');
    mail.stop();
  });

  await test('Disconnect during a token refresh: the rotated token is never written back after the file is deleted', async () => {
    const m = microsoft();
    const f = path.join(tmp, 'race-token.bin');
    const account = G.createGraphAccount({ fetch: m.fetch, openExternal: browser(m), file: f, timeoutMs: 2000, signInMs: 5000 });
    await account.signIn();
    // A loaded session has no access token yet: its first request refreshes, and refresh rotates.
    const s = await account.load();
    let release;
    m.holdRefresh = new Promise((r) => { release = r; });
    const pending = s.request('GET', '/me').catch((e) => e);
    await wait(30);
    assert.equal(m.refreshes, 1, 'the refresh is in flight');
    await account.remove();
    await assert.rejects(fs.access(f));
    m.holdRefresh = null;
    release();
    const r = await pending;
    await wait(60);
    await assert.rejects(fs.access(f), 'the token file came back after Disconnect');
    assert.equal(r.kind, 'offline', 'a closed session makes no more requests');
  });

  await test('no rotated token is written before the mailbox check passes (another account rotates nothing to disk)', async () => {
    const m = microsoft({ account: 'someone@muchbetter.world' });
    m.meUnauthorizedOnce = true;
    const f = path.join(tmp, 'gate-token.bin');
    const account = G.createGraphAccount({ fetch: m.fetch, openExternal: browser(m), file: f, timeoutMs: 2000, signInMs: 5000 });
    await assert.rejects(account.signIn(), (e) => e.reason === 'account');
    assert.equal(m.refreshes, 1, 'the 401 made the session refresh (and rotate) during the check');
    await assert.rejects(fs.access(f));
  });

  await test("the new-mail cut-off is server time: a PC clock two days ahead still notifies mail that just arrived", async () => {
    const { m, mail, timers } = mailSetup([message(1), message(2)], () => Date.UTC(2026, 10, 8, 7, 0));
    const seen = [];
    mail.start((s, events) => seen.push(events));
    await wait(40);
    const fresh = message(9, { receivedDateTime: '2026-11-06T09:00:00.000Z' });
    m.messages.set(fresh.id, fresh);
    m.pending.push(fresh);
    timers.at(-1).fn();
    await wait(40);
    assert.deepEqual(seen.at(-1).map((e) => e.subject), ['Subject 9']);
    mail.stop();
  });

  await test('a failed unread count after the delta advanced keeps the new mail: its notice goes out on the next tick', async () => {
    const { m, mail, timers } = mailSetup([message(1)]);
    const seen = [], errs = [];
    mail.start((s, events) => seen.push(events), (e) => errs.push(e.kind));
    await wait(40);
    const fresh = message(4);
    m.messages.set(fresh.id, fresh);
    m.pending.push(fresh);
    m.failUnread = 1;
    timers.at(-1).fn();
    await wait(40);
    assert.deepEqual(errs, ['server']);
    timers.at(-1).fn();
    await wait(40);
    assert.deepEqual(seen.at(-1).map((e) => e.subject), ['Subject 4']);
    mail.stop();
  });

  await test('Disconnect during the sign-in mailbox check: nothing is stored and the sign-in does not count', async () => {
    const m = microsoft();
    const f = path.join(tmp, 'signin-race-token.bin');
    const account = G.createGraphAccount({ fetch: m.fetch, openExternal: browser(m), file: f, timeoutMs: 2000, signInMs: 5000 });
    let release;
    m.holdMe = new Promise((r) => { release = r; });
    const signing = account.signIn().then(() => 'signed in', (e) => e.reason);
    for (let i = 0; i < 100 && !m.meAsked; i++) await wait(10);
    assert.ok(m.meAsked, 'the mailbox check is in flight');
    await account.remove();
    m.holdMe = null;
    release();
    assert.equal(await signing, 'cancelled');
    await wait(30);
    await assert.rejects(fs.access(f), 'the sign-in stored a token after Disconnect');
    assert.equal(account.openSessions(), 0);
  });

  await test('closed sessions leave the open set: a failed check, a closed load, and Disconnect', async () => {
    const m = microsoft({ account: 'someone@muchbetter.world' });
    const f = path.join(tmp, 'live-token.bin');
    const account = G.createGraphAccount({ fetch: m.fetch, openExternal: browser(m), file: f, timeoutMs: 2000, signInMs: 5000 });
    await assert.rejects(account.signIn(), (e) => e.reason === 'account');
    assert.equal(account.openSessions(), 0, 'after a failed mailbox check');
    m.account = 'gustav@muchbetter.world';
    const good = await account.signIn();
    assert.equal(account.openSessions(), 1);
    good.close();
    assert.equal(account.openSessions(), 0, 'after close (a reconnect or a screen suspend)');
    const loaded = await account.load();
    assert.equal(account.openSessions(), 1);
    loaded.close();
    assert.equal(account.openSessions(), 0);
    await account.load();
    await account.remove();
    assert.equal(account.openSessions(), 0, 'after Disconnect');
  });

  await test('THE TOKENS: in no return value, error, log line or file in plain text', async () => {
    clean('returned values', returned);
    clean('log', logs.join('\n'));
    for (const f of await fs.readdir(tmp)) {
      const bytes = await fs.readFile(path.join(tmp, f)).catch(() => Buffer.alloc(0));
      for (const s of SECRETS) assert.ok(!bytes.includes(Buffer.from(s)), `${f} holds a secret in plain text`);
    }
  });
} finally {
  for (const [k, fn] of Object.entries(original)) console[k] = fn;
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
