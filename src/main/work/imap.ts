/**
 * IMAP mail for Work mode (Gmail with an app password, GoDaddy with the
 * mailbox password): INBOX sync with IDLE and a 60 s poll, read, flag, archive
 * and trash with read-back, and a 5 s undo. docs/work-mode.md, "Mail".
 *
 * Checked against imapflow 2.2.6's real API (dist/cjs/imap-flow.d.ts and
 * types.d.ts): the constructor options below are all ImapFlowOptions; fetch
 * and fetchOne take a FetchQueryObject (uid, flags, envelope, size,
 * internalDate, headers as a list, labels, bodyStructure); download returns
 * { meta, content } with the transfer encoding and charset already decoded and
 * honours maxBytes; messageMove returns { uidValidity, uidMap } under UIDPLUS;
 * list() gives specialUse; search() takes { uid, header, gmraw }.
 *
 *   - TLS only: port 993, secure true, rejectUnauthorized true. A certificate
 *     error is a failure ('tls'), never bypassed.
 *   - logger false, emitLogs false, logRaw false: imapflow logs nothing, so a
 *     LOGIN line can never reach a log.
 *   - Never a permanent delete: a server without MOVE is refused before
 *     imapflow's COPY + \Deleted + EXPUNGE fallback could run, and nothing
 *     here calls messageDelete, expunge or mailboxClose.
 */
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { MailAccountView, MailBody, MailEvent, MailRow } from '../../shared/mail-view';
import { MailError, mailFailure, validateMailAccount, type MailAccount, type MailCredential } from './mail-accounts';
import { BODY_LIMIT, DOWNLOAD_LIMIT, mailToText, cleanMailText } from './mail-text';

export const MAIL_POLL_MS = 60_000;
/** How long Archive and Trash can be undone. */
export const UNDO_MS = 5000;
export const RECONNECT_CAP_MS = 300_000;
export const reconnectDelay = (failures: number): number => Math.min(RECONNECT_CAP_MS, 1000 * 2 ** Math.min(19, Math.max(0, failures)));

/** The transport boundary uses unknown for server values, including in tests. */
export interface MailConnection {
  mailbox: unknown;
  capabilities: Map<string, unknown>;
  connect(): Promise<unknown>;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetch(range: string, query: Record<string, unknown>, options?: { uid: boolean }): AsyncIterable<unknown>;
  fetchOne(uid: number, query: Record<string, unknown>, options: { uid: boolean }): Promise<unknown>;
  download(uid: number, part: string, options: { uid: boolean; maxBytes: number }): Promise<{ content?: Readable }>;
  messageFlagsAdd(uid: number, flags: string[], options: { uid: boolean }): Promise<unknown>;
  messageFlagsRemove(uid: number, flags: string[], options: { uid: boolean }): Promise<unknown>;
  messageMove(uid: number, destination: string, options: { uid: boolean }): Promise<unknown>;
  messageCopy(uid: number, destination: string, options: { uid: boolean }): Promise<unknown>;
  mailboxCreate(path: string): Promise<unknown>;
  list(): Promise<unknown>;
  search(query: Record<string, unknown>, options: { uid: boolean }): Promise<unknown>;
  status(path: string, query: { unseen: boolean }): Promise<unknown>;
  noop(): Promise<unknown>;
  idle(): Promise<unknown>;
}

export interface MailConnectOptions {
  host: string;
  port: 993;
  secure: true;
  auth: { user: string; pass: string };
  tls: { rejectUnauthorized: true; minVersion: 'TLSv1.2'; servername: string };
  logger: false;
  emitLogs: false;
  logRaw: false;
  disableAutoIdle: true;
  maxIdleTime: number;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}
export type MailClientFactory = (options: MailConnectOptions) => MailConnection;
// Lazy loading also lets the offline suite exercise the boundary without loading network code.
export const imapflowClient: MailClientFactory = (options) => {
  const { ImapFlow } = require('imapflow') as { ImapFlow: new (options: MailConnectOptions) => MailConnection };
  return new ImapFlow(options);
};

export interface MailSnapshot { account: MailAccountView; rows: MailRow[] }
interface SnapshotInfo { id: string; validity: string; highest: number; events: { uid: number; event: MailEvent }[] }
const snapshots = new WeakMap<MailSnapshot, SnapshotInfo>();

/** The first sync and a UIDVALIDITY reset establish a baseline, without notifying old mail. */
export function diffMail(prev: MailSnapshot | null, next: MailSnapshot): MailEvent[] {
  const before = prev && snapshots.get(prev);
  const after = snapshots.get(next);
  if (!before || !after || before.id !== after.id || before.validity !== after.validity) return [];
  return after.events.filter(({ uid }) => uid > before.highest).map(({ event }) => ({ ...event }));
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MailError('server');
  return value as ObjectValue;
}
function uint(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 0xffffffff) throw new MailError('server');
  return value;
}
function validity(value: unknown): string {
  if (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') throw new MailError('server');
  const s = String(value);
  if (!/^[1-9]\d{0,9}$/.test(s)) throw new MailError('server');
  uint(Number(s));
  return s;
}
function flags(value: unknown): Set<string> {
  if (!(value instanceof Set) || value.size > 1000 || [...value].some((v) => typeof v !== 'string' || v.length > 1024)) throw new MailError('server');
  return value as Set<string>;
}
function handleFor(account: string, uid: number, v: string): string {
  return Buffer.from(JSON.stringify([account, uid, v])).toString('base64url');
}
const uidOptions = { uid: true };
const envelopeQuery = { uid: true, flags: true, envelope: true, size: true, internalDate: true };

export function createImapMail({ account: input, credential, createClient = imapflowClient, now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = (timer) => clearTimeout(timer as NodeJS.Timeout),
}: {
  account: MailAccount;
  credential: MailCredential;
  createClient?: MailClientFactory;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}) {
  const account = Object.freeze(validateMailAccount(input));
  if (Object.values(account).some((value) => typeof value === 'string' && credential.redact(value) !== value)) throw new MailError('invalid');
  let client: MailConnection | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let running = false;
  let timer: unknown;
  let failures = 0;
  let connectedAt = 0;
  let syncPending = false;
  let idleClient: MailConnection | null = null;
  let listener: ((snapshot: MailSnapshot, events: MailEvent[]) => void) | undefined;
  let onError: ((error: MailError) => void) | undefined;
  let previous: MailSnapshot | null = null;
  const issued = new Map<string, { uid: number; validity: string }>();
  const undoMoves = new Map<string, { path: string; uid: number; validity: string; expires: number; kind: 'archive' | 'trash' }>();
  const ownArrivals = new Set<number>();
  const snippets = new Map<string, string>();
  const bulkSenders = new Map<string, boolean>();
  /** handle -> Message-ID, for Gmail's "Open in Gmail" link. Main only. */
  const messageIds = new Map<string, string>();

  function text(value: unknown, max: number): string {
    if (typeof value !== 'string') throw new MailError('server');
    // Envelope fields are MIME-decoded text, not HTML: cleaned, never tokenized.
    return cleanMailText(credential.redact(mailToText(credential.redact(value), false, DOWNLOAD_LIMIT)), max);
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      if (stopped) throw new MailError('offline');
      try { return await work(); } catch (error) { throw mailFailure(error); }
    });
    queue = result.catch(() => {});
    return result;
  }
  function disconnect(c: MailConnection): void {
    if (client === c) client = null;
    if (idleClient === c) idleClient = null;
    try { c.close(); } catch { /* No transport text escapes, even from close. */ }
  }
  function arm(ms: number): void {
    if (!running || stopped) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => { timer = undefined; requestSync(); }, ms);
  }
  function transportFailed(c: MailConnection, error: unknown): void {
    if (client !== c) return;
    disconnect(c);
    if (running && !syncPending) {
      try { onError?.(mailFailure(error)); } catch { /* Observer errors are isolated. */ }
      arm(reconnectDelay(failures++));
    }
  }
  async function connection(): Promise<MailConnection> {
    if (client) return client;
    return credential.use(async (password) => {
      const c = createClient({ host: account.host, port: 993, secure: true,
        auth: { user: account.user, pass: password },
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: account.host },
        logger: false, emitLogs: false, logRaw: false, disableAutoIdle: true,
        maxIdleTime: MAIL_POLL_MS, connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 90_000,
      });
      client = c;
      c.on('error', (error) => transportFailed(c, error));
      c.on('close', () => transportFailed(c, new MailError('offline')));
      c.on('exists', () => {
        if (client === c && c.mailbox && typeof c.mailbox === 'object' && (c.mailbox as ObjectValue).path === 'INBOX') requestSync();
      });
      c.on('flags', () => { if (client === c) requestSync(); });
      c.on('expunge', () => { if (client === c) requestSync(); });
      try {
        await c.connect();
        if (stopped || client !== c) throw new MailError('offline');
        connectedAt = now();
        return c;
      } catch (error) { disconnect(c); throw mailFailure(error); }
    });
  }
  async function mailbox<T>(c: MailConnection, path: string, work: (v: string) => Promise<T>): Promise<T> {
    const lock = await c.getMailboxLock(path);
    try {
      const box = object(c.mailbox);
      if (box.path !== path) throw new MailError('mismatch');
      return await work(validity(box.uidValidity));
    } finally { lock.release(); }
  }
  function parseRow(raw: unknown, v: string): MailRow | null {
    try {
      const r = object(raw), envelope = object(r.envelope);
      const uid = uint(r.uid), f = flags(r.flags);
      if (!Array.isArray(envelope.from) || !envelope.from.length) return null;
      const from = object(envelope.from[0]);
      if (typeof from.address !== 'string' || from.address.length > 254 ||
          !/^[^\s<>@\u0000-\u001f]+@[^\s<>@]+\.[^\s<>@]+$/.test(from.address) ||
          cleanMailText(from.address, 254) !== from.address) return null;
      // Arrival time (INTERNALDATE) first, as Graph's receivedDateTime; the Date header when the server gives none.
      // imapflow leaves an unparseable Date header as a string, so both are checked.
      const when = [r.internalDate, envelope.date].find((d): d is Date => d instanceof Date && Number.isFinite(d.getTime()));
      if (!when) return null;
      if (r.headers !== undefined && !Buffer.isBuffer(r.headers)) return null;
      const labels = r.labels === undefined ? new Set<string>() : flags(r.labels);
      const bulk = /(?:^|[._+-])no-?reply(?:[._+-]|@)/i.test(from.address) ||
        (Buffer.isBuffer(r.headers) && /(?:^|\r?\n)list-unsubscribe\s*:/i.test(r.headers.subarray(0, 64_000).toString('utf8'))) ||
        [...labels].some((label) => /^(?:\\|\^)?(?:category[\/:])?(promotions|social)$/i.test(label));
      return {
        account: account.id, handle: handleFor(account.id, uid, v),
        fromName: text(from.name ?? '', 200), fromAddress: text(from.address, 254),
        subject: text(envelope.subject ?? '', 500), snippet: snippets.get(handleFor(account.id, uid, v)) ?? '', date: when.toISOString(),
        seen: f.has('\\Seen'), flagged: f.has('\\Flagged'), bulk,
      };
    } catch { return null; }
  }
  async function syncInternal(): Promise<MailSnapshot> {
    const c = await connection();
    return mailbox(c, 'INBOX', async (v) => {
      await c.noop();
      const box = object(c.mailbox);
      const count = box.exists;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new MailError('server');
      const rows: MailRow[] = [];
      const pendingIds = new Map<string, string>();
      const uidOf = (handle: string): number => (JSON.parse(Buffer.from(handle, 'base64url').toString('utf8')) as [string, number, string])[1];
      let highest = 0;
      if (count) {
        const seen = new Set<number>();
        for await (const raw of c.fetch(`${Math.max(1, count - 199)}:${count}`, {
          ...envelopeQuery, headers: ['list-unsubscribe'], labels: c.capabilities.has('X-GM-EXT-1'),
        })) {
          const row = parseRow(raw, v);
          if (!row) continue;
          const uid = uint(object(raw).uid);
          highest = Math.max(highest, uid);
          if (seen.has(uid)) continue;
          seen.add(uid);
          rows.push(row);
          const id = messageId(object(raw));
          if (id) pendingIds.set(row.handle, id);
          if (rows.length > 200) throw new MailError('server');
        }
      }
      // Gmail does not list its category tabs as X-GM-LABELS: ask its own search which of these rows are Promotions or Social.
      if (rows.length && c.capabilities.has('X-GM-EXT-1')) {
        const uids = rows.map((r) => uidOf(r.handle));
        try {
          const found = await c.search({ uid: `${Math.min(...uids)}:${Math.max(...uids)}`, gmraw: 'category:promotions OR category:social' }, uidOptions);
          if (Array.isArray(found)) {
            const bulk = new Set(found.filter((u): u is number => typeof u === 'number'));
            for (const row of rows) if (bulk.has(uidOf(row.handle))) row.bulk = true;
          }
        } catch (error) {
          // A category search that fails costs only the tab check; a dead connection fails the next command anyway.
          if (mailFailure(error).kind === 'offline') throw error;
        }
      }
      const unseen = object(await c.status('INBOX', { unseen: true })).unseen;
      if (typeof unseen !== 'number' || !Number.isSafeInteger(unseen) || unseen < 0) throw new MailError('server');
      const before = previous && snapshots.get(previous);
      if (before?.validity === v) highest = Math.max(highest, before.highest);
      else ownArrivals.clear();
      rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      const snapshot: MailSnapshot = { account: { id: account.id, label: account.label, colour: account.colour,
        unread: unseen, status: 'ready', syncedAt: new Date(now()).toISOString(), provider: 'imap' }, rows };
      issued.clear();
      bulkSenders.clear();
      messageIds.clear();
      for (const [handle, id] of pendingIds) messageIds.set(handle, id);
      pendingIds.clear();
      for (const row of rows) {
        const decoded = JSON.parse(Buffer.from(row.handle, 'base64url').toString('utf8'));
        issued.set(row.handle, { uid: decoded[1], validity: v });
        bulkSenders.set(row.handle, row.bulk);
      }
      for (const handle of snippets.keys()) if (!issued.has(handle)) snippets.delete(handle);
      snapshots.set(snapshot, { id: account.id, validity: v, highest,
        events: rows.filter((r) => !ownArrivals.has(issued.get(r.handle)!.uid)).map((r) => ({
          uid: issued.get(r.handle)!.uid,
          event: { kind: r.bulk ? 'bulk' : 'person', account: r.account, handle: r.handle, fromName: r.fromName,
            fromAddress: r.fromAddress, subject: r.subject, key: `${account.id}:${v}:${issued.get(r.handle)!.uid}` },
        })),
      });
      ownArrivals.clear();
      return snapshot;
    });
  }
  function beginIdle(): void {
    const c = client;
    if (!running || !c || idleClient === c || !c.capabilities.has('IDLE')) return;
    idleClient = c;
    // Do not hold the operation queue while IDLE waits. A command automatically interrupts it.
    void c.idle().catch((error) => transportFailed(c, error)).finally(() => {
      if (idleClient === c) idleClient = null;
    });
  }
  function requestSync(): void {
    if (!running || stopped || syncPending) return;
    syncPending = true;
    void enqueue(syncInternal).then((snapshot) => {
      if (stopped) return;
      const events = diffMail(previous, snapshot);
      previous = snapshot;
      // A connection that fails immediately in IDLE must keep its backoff history.
      if (now() - connectedAt >= MAIL_POLL_MS) failures = 0;
      try { listener?.(snapshot, events); } catch { /* A view consumer cannot break sync. */ }
      arm(MAIL_POLL_MS);
    }, (error) => {
      if (client) disconnect(client);
      try { onError?.(mailFailure(error)); } catch { /* A view consumer cannot break reconnect. */ }
      arm(reconnectDelay(failures++));
    }).finally(() => { syncPending = false; beginIdle(); });
  }
  function decode(handle: string): { uid: number; validity: string } {
    if (typeof handle !== 'string' || handle.length > 256 || !/^[A-Za-z0-9_-]+$/.test(handle)) throw new MailError('invalid');
    const known = issued.get(handle);
    if (!known || handleFor(account.id, known.uid, known.validity) !== handle) throw new MailError('invalid');
    return known;
  }
  async function read(c: MailConnection, uid: number): Promise<ObjectValue> {
    const r = object(await c.fetchOne(uid, envelopeQuery, uidOptions));
    if (uint(r.uid) !== uid) throw new MailError('mismatch');
    flags(r.flags);
    return r;
  }
  async function withHandle<T>(handle: string, work: (c: MailConnection, uid: number) => Promise<T>): Promise<T> {
    const h = decode(handle);
    const c = await connection();
    return mailbox(c, 'INBOX', async (v) => {
      if (v !== h.validity) throw new MailError('invalid');
      await read(c, h.uid);
      return work(c, h.uid);
    });
  }
  async function restoreInbox(c: MailConnection): Promise<void> {
    await mailbox(c, 'INBOX', async () => {});
  }
  async function action<T>(work: () => Promise<T>): Promise<T> {
    return enqueue(async () => {
      try { return await work(); }
      finally {
        if (client) {
          try { await restoreInbox(client); } catch (error) { transportFailed(client, error); }
        }
        requestSync();
      }
    });
  }
  function changeFlag(handle: string, flag: string, add: boolean): Promise<MailRow> {
    return action(() => withHandle(handle, async (c, uid) => {
      await (add ? c.messageFlagsAdd(uid, [flag], uidOptions) : c.messageFlagsRemove(uid, [flag], uidOptions));
      const r = await read(c, uid);
      if (flags(r.flags).has(flag) !== add) throw new MailError('mismatch');
      const row = parseRow(r, decode(handle).validity);
      if (!row) throw new MailError('mismatch');
      row.bulk = bulkSenders.get(handle) ?? row.bulk;
      return row;
    }));
  }
  async function destination(c: MailConnection, kind: 'archive' | 'trash'): Promise<string> {
    const gmail = account.host === 'imap.gmail.com';
    const raw = await c.list();
    if (!Array.isArray(raw)) throw new MailError('server');
    // Gmail archives to All Mail; other servers to their \Archive folder, by special use first, by name second.
    const special = kind === 'trash' ? '\\Trash' : gmail ? '\\All' : '\\Archive';
    const folders = raw.map(object);
    const found = folders.find((f) => f.specialUse === special && typeof f.path === 'string' && f.path.toUpperCase() !== 'INBOX');
    const path = found?.path ?? (gmail ? (kind === 'trash' ? '[Gmail]/Trash' : '[Gmail]/All Mail') : (kind === 'trash' ? 'Trash' : 'Archive'));
    if (typeof path !== 'string' || !path || path.length > 1024 || path.toUpperCase() === 'INBOX' || cleanMailText(path, 1024) !== path) throw new MailError('server');
    if (!gmail && !folders.some((f) => f.path === path)) await c.mailboxCreate(path);
    return path;
  }
  function messageId(r: ObjectValue): string | null {
    const value = object(r.envelope).messageId;
    return typeof value === 'string' && /^<[^<>\s\u0000-\u001f]{1,990}>$/.test(value) ? value : null;
  }
  function sameMessage(before: ObjectValue, after: ObjectValue): boolean {
    const a = flags(before.flags), b = flags(after.flags);
    const e = object(before.envelope), f = object(after.envelope);
    return before.size === after.size && (messageId(before) === messageId(after)) &&
      e.subject === f.subject && JSON.stringify(e.from) === JSON.stringify(f.from) &&
      ['\\Seen', '\\Flagged'].every((flag) => a.has(flag) === b.has(flag));
  }
  /**
   * Move one message and prove where it went. `copy` is Gmail's archive
   * undo: COPY from All Mail to INBOX (Gmail adds the Inbox label), so the
   * message stays in All Mail, which is not a failure, and nothing is expunged.
   */
  async function move(c: MailConnection, source: string, uid: number, v: string, target: string, copy = false): Promise<{ uid: number; validity: string }> {
    // ImapFlow's non-MOVE fallback expunges. Refuse it before making any change (a COPY never expunges).
    if (!copy && !c.capabilities.has('MOVE')) throw new MailError('unsupported');
    let before: ObjectValue;
    let moved: unknown;
    await mailbox(c, source, async (current) => {
      if (current !== v) throw new MailError('invalid');
      before = await read(c, uid);
      if (!c.capabilities.has('UIDPLUS') && !messageId(before)) throw new MailError('unsupported');
      moved = copy ? await c.messageCopy(uid, target, uidOptions) : await c.messageMove(uid, target, uidOptions);
      if (!moved || (!copy && await c.fetchOne(uid, { uid: true }, uidOptions))) throw new MailError('mismatch');
    });
    return mailbox(c, target, async (current) => {
      const result = object(moved);
      let targetUid: number;
      if (result.uidMap instanceof Map && result.uidMap.has(uid)) {
        if (validity(result.uidValidity) !== current) throw new MailError('mismatch');
        targetUid = uint(result.uidMap.get(uid));
      } else {
        const id = messageId(before!);
        if (!id) throw new MailError('mismatch');
        const matches = await c.search({ header: { 'message-id': id } }, uidOptions);
        if (!Array.isArray(matches) || matches.length !== 1) throw new MailError('mismatch');
        targetUid = uint(matches[0]);
      }
      if (!sameMessage(before!, await read(c, targetUid))) throw new MailError('mismatch');
      return { uid: targetUid, validity: current };
    });
  }
  function moveOut(handle: string, kind: 'archive' | 'trash'): Promise<{ undo: string }> {
    return action(async () => {
      const h = decode(handle), c = await connection();
      if (!c.capabilities.has('MOVE')) throw new MailError('unsupported');
      await mailbox(c, 'INBOX', async (v) => {
        if (v !== h.validity) throw new MailError('invalid');
        await read(c, h.uid);
      });
      const path = await destination(c, kind);
      const moved = await move(c, 'INBOX', h.uid, h.validity, path);
      issued.delete(handle);
      for (const [token, entry] of undoMoves) if (entry.expires < now()) undoMoves.delete(token);
      const undo = randomUUID();
      undoMoves.set(undo, { path, ...moved, expires: now() + UNDO_MS, kind });
      return { undo };
    });
  }

  return Object.freeze({
    sync: () => enqueue(async () => { const snapshot = await syncInternal(); previous = snapshot; return snapshot; }),
    start(receive: (snapshot: MailSnapshot, events: MailEvent[]) => void, failed?: (error: MailError) => void): void {
      if (stopped) throw new MailError('offline');
      listener = receive; onError = failed;
      if (!running) { running = true; requestSync(); }
    },
    stop(): void {
      stopped = true; running = false;
      if (timer !== undefined) cancel(timer);
      if (client) disconnect(client);
      issued.clear(); undoMoves.clear(); snippets.clear(); bulkSenders.clear(); messageIds.clear();
    },
    markRead: (handle: string) => changeFlag(handle, '\\Seen', true),
    markUnread: (handle: string) => changeFlag(handle, '\\Seen', false),
    flag: (handle: string) => changeFlag(handle, '\\Flagged', true),
    unflag: (handle: string) => changeFlag(handle, '\\Flagged', false),
    archive: (handle: string) => moveOut(handle, 'archive'),
    trash: (handle: string) => moveOut(handle, 'trash'),
    undo: (token: string) => action(async (): Promise<{ handle: string }> => {
      const entry = typeof token === 'string' ? undoMoves.get(token) : undefined;
      if (!entry || entry.expires < now()) throw new MailError('invalid');
      const c = await connection();
      // Gmail: an archived message is in All Mail without the Inbox label. A MOVE out of All
      // Mail is not what Gmail means by it; a COPY to INBOX adds the label back and never
      // expunges anything. It is then read back in INBOX like a move.
      const moved = await move(c, entry.path, entry.uid, entry.validity, 'INBOX', account.host === 'imap.gmail.com' && entry.kind === 'archive');
      undoMoves.delete(token);
      const handle = handleFor(account.id, moved.uid, moved.validity);
      issued.set(handle, moved); ownArrivals.add(moved.uid);
      return { handle };
    }),
    open: (handle: string) => action(() => withHandle(handle, async (c, uid): Promise<MailBody> => {
      const raw = object(await c.fetchOne(uid, { uid: true, bodyStructure: true }, uidOptions));
      if (uint(raw.uid) !== uid) throw new MailError('mismatch');
      const attachments: MailBody['attachments'] = [];
      const parts: { part: string; html: boolean }[] = [];
      let nodes = 0;
      function visit(value: unknown, depth = 0): void {
        if (++nodes > 500 || depth > 30) throw new MailError('server');
        const node = object(value);
        if (typeof node.type !== 'string') throw new MailError('server');
        const type = node.type.toLowerCase();
        const disposition = typeof node.disposition === 'string' ? node.disposition.toLowerCase() : '';
        const parameters = node.parameters ? object(node.parameters) : {};
        const dispositionParameters = node.dispositionParameters ? object(node.dispositionParameters) : {};
        const name = dispositionParameters.filename ?? parameters.name;
        if (disposition === 'attachment' || name !== undefined || (!type.startsWith('multipart/') && !['text/plain', 'text/html'].includes(type))) {
          if (typeof node.size !== 'number' || !Number.isSafeInteger(node.size) || node.size < 0) throw new MailError('server');
          attachments.push({ name: text(name ?? 'Attachment', 255), size: node.size });
          return;
        }
        if (['text/plain', 'text/html'].includes(type)) {
          const part = node.part ?? '1';
          if (typeof part !== 'string' || !/^\d+(?:\.\d+)*$/.test(part) || part.length > 100) throw new MailError('server');
          parts.push({ part, html: type === 'text/html' });
        }
        if (node.childNodes !== undefined) {
          if (!Array.isArray(node.childNodes)) throw new MailError('server');
          for (const child of node.childNodes) visit(child, depth + 1);
        }
      }
      visit(raw.bodyStructure);
      // Prefer the plain alternative; never download attachment bytes or the whole RFC822 source.
      const part = parts.find((p) => !p.html) ?? parts[0];
      let body = '';
      if (part) {
        const { content } = await c.download(uid, part.part, { uid: true, maxBytes: DOWNLOAD_LIMIT });
        if (!content) throw new MailError('server');
        const chunks: Buffer[] = [];
        let length = 0;
        try {
          for await (const chunk of content) {
            if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') throw new MailError('server');
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            chunks.push(bytes.subarray(0, DOWNLOAD_LIMIT - length));
            length += chunks[chunks.length - 1].length;
            if (length >= DOWNLOAD_LIMIT) { content.destroy(); break; }
          }
        } finally { content.destroy(); }
        body = cleanMailText(credential.redact(mailToText(credential.redact(Buffer.concat(chunks).toString('utf8')), part.html, DOWNLOAD_LIMIT)), BODY_LIMIT);
      }
      snippets.set(handle, body.replace(/\s+/g, ' ').slice(0, 200));
      return { handle, text: body, attachments };
    })),
    /**
     * The message in the account's own web mail, built here from fixed hosts:
     * Gmail finds it by its Message-ID; GoDaddy's webmail has no per-message
     * link, so it opens the inbox.
     */
    webUrl(handle: string): string {
      decode(handle);
      if (account.host !== 'imap.gmail.com') return 'https://email.godaddy.com/';
      const id = messageIds.get(handle);
      const base = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account.user)}`;
      return id ? `${base}#search/rfc822msgid%3A${encodeURIComponent(id.slice(1, -1))}` : `${base}#inbox`;
    },
  });
}
