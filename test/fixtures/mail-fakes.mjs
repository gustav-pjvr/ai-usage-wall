/**
 * Fake mail servers for test/work.test.mjs: an IMAP client with imapflow's
 * shape (the methods src/main/work/imap.ts calls, checked against the real
 * library in test/mail.test.mjs) and a fake Microsoft (token endpoint and the
 * Graph calls src/main/work/graph.ts makes, as test/graph.test.mjs fakes it).
 * Neither ever deletes: both fail the test on any delete or expunge.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { Readable } from 'node:stream';

export function imapMessage(uid, o = {}) {
  return {
    uid, flags: new Set(), size: 100, internalDate: new Date(Date.UTC(2026, 10, 4, 7, uid % 60)),
    envelope: { from: [{ name: `Sender ${uid}`, address: `sender${uid}@example.com` }], subject: `Message ${uid}`,
      date: new Date(Date.UTC(2026, 10, 4, 7, uid % 60)), messageId: `<mail-${uid}@example.com>` },
    headers: Buffer.from(''), labels: new Set(),
    bodyStructure: { type: 'text/html', part: '1', size: 100 },
    body: `<p>Body of ${uid}</p><img src="https://tracker.example/${uid}.gif">`, ...o,
  };
}

/** One fake IMAP server shared by every client the app makes (a reconnect sees the same mailbox). */
export function imapServer(password, rows = [imapMessage(1)]) {
  const server = {
    password,
    boxes: new Map([['INBOX', { uidValidity: 10n, rows }], ['[Gmail]/All Mail', { uidValidity: 20n, rows: [] }], ['[Gmail]/Trash', { uidValidity: 30n, rows: [] }]]),
    clients: [], calls: [], nextUid: 1000, logins: [],
  };
  class FakeImap extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.capabilities = new Map(['IDLE', 'MOVE', 'UIDPLUS', 'X-GM-EXT-1'].map((c) => [c, true]));
      this.mailbox = false;
      server.clients.push(this);
    }
    async connect() {
      server.logins.push(this.options.auth.user);
      if (this.options.auth.pass !== server.password) throw Object.assign(new Error(`login failed for ${this.options.auth.pass}`), { authenticationFailed: true });
    }
    close() { this.closed = true; this.finishIdle(); this.emit('close'); }
    finishIdle() { this.idleResolve?.(true); this.idleResolve = null; }
    async getMailboxLock(name) {
      this.finishIdle();
      const box = server.boxes.get(name);
      assert.ok(box, `mailbox ${name}`);
      this.mailbox = { path: name, uidValidity: box.uidValidity, exists: box.rows.length };
      return { release: () => undefined };
    }
    rows() { return server.boxes.get(this.mailbox.path).rows; }
    async *fetch(range) {
      const [a, b] = range.split(':').map(Number);
      for (const r of this.rows().slice(a - 1, b)) yield r;
    }
    async fetchOne(uid) { return this.rows().find((r) => r.uid === uid) ?? false; }
    async download(uid) {
      const r = this.rows().find((x) => x.uid === uid);
      return { content: Readable.from([Buffer.from(r.body)]) };
    }
    async messageFlagsAdd(uid, flags) { for (const f of flags) this.rows().find((r) => r.uid === uid).flags.add(f); server.calls.push(['add', uid, flags]); return true; }
    async messageFlagsRemove(uid, flags) { for (const f of flags) this.rows().find((r) => r.uid === uid).flags.delete(f); server.calls.push(['remove', uid, flags]); return true; }
    async messageMove(uid, destination) {
      const row = this.rows().find((r) => r.uid === uid);
      const target = server.boxes.get(destination);
      const next = server.nextUid++;
      this.rows().splice(this.rows().indexOf(row), 1);
      target.rows.push({ ...row, flags: new Set(row.flags), uid: next });
      server.calls.push(['move', this.mailbox.path, destination]);
      return { uidValidity: target.uidValidity, uidMap: new Map([[uid, next]]) };
    }
    async messageCopy(uid, destination) {
      const row = this.rows().find((r) => r.uid === uid);
      const target = server.boxes.get(destination);
      const next = server.nextUid++;
      target.rows.push({ ...row, flags: new Set(row.flags), uid: next });
      server.calls.push(['copy', this.mailbox.path, destination]);
      return { uidValidity: target.uidValidity, uidMap: new Map([[uid, next]]) };
    }
    async mailboxCreate() { assert.fail('Gmail folders exist'); }
    async list() {
      return [...server.boxes.keys()].map((p) => ({ path: p, specialUse: p === '[Gmail]/All Mail' ? '\\All' : p === '[Gmail]/Trash' ? '\\Trash' : undefined }));
    }
    async search(query) {
      if (query.gmraw !== undefined) return this.rows().filter((r) => r.category).map((r) => r.uid);
      return this.rows().filter((r) => r.envelope.messageId === query.header['message-id']).map((r) => r.uid);
    }
    async status(name) { return { unseen: server.boxes.get(name).rows.filter((r) => !r.flags.has('\\Seen')).length }; }
    async noop() { this.finishIdle(); this.mailbox.exists = this.rows().length; }
    idle() { return new Promise((resolve) => { this.idleResolve = resolve; }); }
    messageDelete() { assert.fail('never delete'); }
    expunge() { assert.fail('never expunge'); }
    mailboxClose() { assert.fail('never close with expunge'); }
  }
  server.factory = (options) => new FakeImap(options);
  /** New mail arrives: the server tells the client that is idling. */
  server.arrive = (row) => {
    server.boxes.get('INBOX').rows.push(row);
    for (const c of server.clients) if (!c.closed) c.emit('exists', { path: 'INBOX', count: server.boxes.get('INBOX').rows.length });
  };
  return server;
}

export function graphMessage(n, o = {}) {
  return {
    id: `AAMkMSG${n}==`, receivedDateTime: new Date(Date.UTC(2026, 10, 4, 9, n)).toISOString(), isRead: false,
    flag: { flagStatus: 'notFlagged' }, subject: `Graph subject ${n}`, from: { emailAddress: { name: `Client ${n}`, address: `client${n}@example.com` } },
    bodyPreview: `Preview ${n}`, inferenceClassification: 'focused', internetMessageId: `<g${n}@example.com>`,
    webLink: `https://outlook.office365.com/owa/?ItemID=AAMkMSG${n}%3D%3D`, parentFolderId: 'FOLDER-INBOX',
    body: { contentType: 'html', content: `<p>Graph body ${n}</p>` }, hasAttachments: false, headers: [], ...o,
  };
}

/** A fake Microsoft: the token endpoint and Graph. `secrets` are the tokens it hands out. */
export function microsoft({ tenant, clientId, access, refresh, code, account = 'gustav@muchbetter.world', messages = [] }) {
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const m = { calls: [], access: null, refresh: null, challenge: null, redirect: null, messages: new Map(), pending: [], moves: 0 };
  for (const x of messages) m.messages.set(x.id, x);
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });
  m.fetch = async (url, init) => {
    m.calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    if (url === `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('client_id'), clientId);
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== code) return reply(400, { error: 'invalid_grant' });
        assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), m.challenge);
        m.access = access; m.refresh = refresh;
        return reply(200, { access_token: access, refresh_token: refresh, expires_in: 3600 });
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === m.refresh) {
        return reply(200, { access_token: m.access, refresh_token: m.refresh, expires_in: 3600 });
      }
      return reply(400, { error: 'invalid_grant', error_description: `bad ${form.get('refresh_token')}` });
    }
    assert.ok(url.startsWith(`${GRAPH}/`));
    assert.notEqual(init.method, 'DELETE', 'never a DELETE');
    if (init.headers.Authorization !== `Bearer ${m.access}`) return reply(401, { error: { message: `bad ${init.headers.Authorization}` } });
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    if (p === '/me') return reply(200, { mail: account, userPrincipalName: account });
    if (p === '/me/mailFolders/inbox/messages/delta') {
      const value = u.searchParams.get('$deltatoken') ? m.pending.splice(0) : [...m.messages.values()].filter((x) => x.parentFolderId === 'FOLDER-INBOX');
      return reply(200, { value, '@odata.deltaLink': `${GRAPH}/me/mailFolders/inbox/messages/delta?$deltatoken=D${m.calls.length}` });
    }
    if (p === '/me/mailFolders/inbox' && u.searchParams.get('$select') === 'unreadItemCount') return reply(200, { unreadItemCount: 1 });
    const folder = /^\/me\/mailFolders\/(inbox|archive|deleteditems)$/.exec(p);
    if (folder) return reply(200, { id: `FOLDER-${folder[1].toUpperCase()}` });
    const one = /^\/me\/messages\/([^/]+)(\/move|\/attachments)?$/.exec(p);
    if (one) {
      const msg = m.messages.get(one[1]);
      if (!msg) return reply(404, {});
      if (one[2] === '/attachments') return reply(200, { value: [] });
      if (one[2] === '/move') {
        const dest = JSON.parse(init.body).destinationId;
        m.messages.delete(msg.id);
        const moved = { ...msg, id: `AAMkMOVED${++m.moves}==`, parentFolderId: `FOLDER-${dest.toUpperCase()}` };
        m.messages.set(moved.id, moved);
        return reply(201, moved);
      }
      if (init.method === 'PATCH') Object.assign(msg, JSON.parse(init.body));
      return reply(200, { ...msg, internetMessageHeaders: msg.headers });
    }
    return reply(404, {});
  };
  /** The system browser: follow the authorize URL to the loopback redirect. */
  m.browser = (url) => {
    const u = new URL(url);
    m.challenge = u.searchParams.get('code_challenge');
    m.redirect = u.searchParams.get('redirect_uri');
    const port = Number(new URL(m.redirect).port);
    setTimeout(() => http.get(`http://127.0.0.1:${port}/?code=${encodeURIComponent(code)}&state=${encodeURIComponent(u.searchParams.get('state'))}`, (r) => r.resume()).on('error', () => undefined), 5);
  };
  return m;
}
