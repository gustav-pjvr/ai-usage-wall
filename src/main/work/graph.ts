/**
 * Microsoft 365 mail for Work mode, through Microsoft Graph
 * (docs/work-mode.md, "Mail"; design section 2.2 and 4).
 *
 * SIGN-IN: OAuth 2.0 authorization code flow with PKCE (S256) for a public
 * client. No MSAL: two form posts and a loopback listener are the whole flow,
 * and every step is visible and tested here.
 *   - The system browser opens the sign-in page (shell.openExternal, never a
 *     window of ours, so the password is typed into Microsoft's page only).
 *   - The redirect comes back to http://127.0.0.1:<random port> (RFC 8252
 *     section 8.3: the IP literal of the listener, not "localhost", which a
 *     browser may try on ::1 first). The listener is bound to 127.0.0.1 only,
 *     takes exactly ONE request and then closes, and gives up after 3 minutes.
 *   - `state` is a fresh random value per sign-in and must come back exactly.
 *   - The signed-in mailbox must be gustav@muchbetter.world, as a monday token
 *     must be Gustav's: any other account is refused and nothing is stored.
 *
 * THE TOKENS: the refresh token is stored with Electron safeStorage (Windows
 * DPAPI) in graph-token.bin, like monday-token.bin; refresh rotates it and the
 * new one replaces the old on disk. The access token lives in this closure
 * only. Rotation writes only after the mailbox check has passed, and never
 * after Disconnect (a generation and a write queue, below). Neither is ever
 * returned by any function here, logged, put in a
 * payload, or sent to a renderer. Failures are fixed kinds (MailError), never
 * server text: a token endpoint error can echo the request.
 *
 * SYNC: the Inbox delta query (receivedDateTime newest first, the last 30
 * days), kept as a local store; the view is the newest 200. 60 s in working
 * hours, 5 minutes otherwise; a 429 or 503 waits at least its Retry-After.
 *
 * ACTIONS: PATCH isRead and flag; move to the well-known folders `archive` and
 * `deleteditems` (never DELETE, never a permanent delete); undo moves the
 * message back to `inbox` by the id the move returned. Every write is read
 * back. Bodies are fetched on open and converted to plain text in main with
 * mail-text.ts: no HTML reaches any renderer.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { app, safeStorage } from 'electron';

import type { MailAccountView, MailBody, MailEvent, MailRow } from '../../shared/mail-view';
import { MailError, type MailErrorKind } from './mail-accounts';
import { BODY_LIMIT, cleanMailText, mailToText } from './mail-text';

export const CLIENT_ID = '5f0949e0-ce25-41ec-961b-384cd318e57e';
export const TENANT_ID = 'ed2d1adf-3f5a-48e9-a200-7ae285517d7c';
export const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;
/**
 * What the wall asks for. Mail.Send is consented in Entra but not asked for
 * until phase 4 (reply and send) needs it: a token that cannot send cannot be
 * misused to send.
 */
export const SCOPES = 'offline_access User.Read Mail.ReadWrite';
export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const M365_ADDRESS = 'gustav@muchbetter.world';
/** How long the browser sign-in may take before the listener gives up. */
export const SIGN_IN_MS = 180_000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const GRAPH_UNDO_MS = 5000;
/** How far back the Inbox delta reaches. The view keeps the newest 200 of it. */
export const DELTA_DAYS = 30;
const PAGE_SIZE = 100;
/** Pages read per tick; a longer first round carries on at the next tick. */
const PAGES_PER_TICK = 10;
/** The local store's cap. The view is the newest MAIL_ROWS of it. */
const STORE_MAX = 500;
const VIEW_MAX = 200;

/** The part of a fetch Response this file reads. */
export type GraphFetch = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

// ── PKCE, state and the loopback listener ────────────────────────────────

/** RFC 7636: a 43 character verifier from 32 random bytes, and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') };
}

export const newState = (): string => randomBytes(24).toString('base64url');

export type SignInReason = 'state' | 'denied' | 'timeout' | 'invalid' | 'account' | 'offline' | 'refused' | 'rate' | 'storage' | 'cancelled';

/** A sign-in that did not finish, as a fixed reason. Never the URL, a code or a token. */
export class SignInError extends Error {
  constructor(readonly reason: SignInReason) {
    super('Microsoft sign-in did not finish.');
    this.name = 'SignInError';
  }
}

export function authorizeUrl(o: { challenge: string; state: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: o.redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    login_hint: M365_ADDRESS,
    prompt: 'select_account',
  });
  return `${AUTHORITY}/oauth2/v2.0/authorize?${q.toString()}`;
}

const PAGE_OK = '<!doctype html><meta charset="utf-8"><title>MuchBetter Client Wall</title><body style="font:16px system-ui;background:#16181d;color:#e8eaee;padding:40px">Signed in. You can close this tab and go back to the wall.</body>';
const PAGE_BAD = '<!doctype html><meta charset="utf-8"><title>MuchBetter Client Wall</title><body style="font:16px system-ui;background:#16181d;color:#e8eaee;padding:40px">The sign-in did not finish. Close this tab and try again from the wall.</body>';
const CODE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

export interface Loopback {
  port: number;
  /** http://127.0.0.1:<port>, exactly as sent to Microsoft and back in the token request. */
  redirectUri: string;
  /** The authorization code, once, or a SignInError. */
  code: Promise<string>;
  /** Stop waiting (Cancel in the dialog). */
  cancel(): void;
  /** True once the listener has stopped accepting connections. */
  closed(): boolean;
}

/**
 * Listen on 127.0.0.1, on a port the OS picks, for exactly one request. The
 * first request settles the sign-in whatever it holds (a wrong `state` is a
 * failure, not something to wait past) and the listener closes at once.
 */
export function startLoopback(state: string, timeoutMs = SIGN_IN_MS): Promise<Loopback> {
  return new Promise((resolveStart, rejectStart) => {
    let settled = false;
    let isClosed = false;
    let finish!: (outcome: string | SignInError) => void;
    const code = new Promise<string>((resolve, reject) => {
      finish = (outcome) => (typeof outcome === 'string' ? resolve(outcome) : reject(outcome));
    });
    code.catch(() => undefined);

    const server = http.createServer((req, res) => {
      if (settled) {
        // A second request on a connection that was already open: refused, never read.
        res.writeHead(404, { Connection: 'close' });
        res.end();
        return;
      }
      settled = true;
      stop();
      let outcome: string | SignInError;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const p = url.searchParams;
        if (req.method !== 'GET' || url.pathname !== '/') outcome = new SignInError('invalid');
        else if (p.get('state') !== state) outcome = new SignInError('state');
        else if (p.has('error')) outcome = new SignInError('denied');
        else {
          const value = p.get('code') ?? '';
          outcome = CODE.test(value) ? value : new SignInError('invalid');
        }
      } catch {
        outcome = new SignInError('invalid');
      }
      res.writeHead(typeof outcome === 'string' ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'Referrer-Policy': 'no-referrer',
        Connection: 'close',
      });
      res.end(typeof outcome === 'string' ? PAGE_OK : PAGE_BAD, () => server.closeAllConnections());
      finish(outcome);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      server.closeAllConnections();
      finish(new SignInError('timeout'));
    }, timeoutMs);
    timer.unref?.();

    function stop(): void {
      clearTimeout(timer);
      if (isClosed) return;
      isClosed = true;
      server.close();
    }

    server.on('error', () => {
      stop();
      if (!settled) {
        settled = true;
        finish(new SignInError('offline'));
      }
      rejectStart(new SignInError('offline'));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolveStart({
        port,
        redirectUri: `http://127.0.0.1:${port}`,
        code,
        cancel: () => {
          if (settled) return;
          settled = true;
          stop();
          server.closeAllConnections();
          finish(new SignInError('cancelled'));
        },
        closed: () => isClosed,
      });
    });
  });
}

// ── Token endpoint ───────────────────────────────────────────────────────

interface Tokens { access: string; refresh: string | null; expiresAt: number }

const TOKEN_TEXT = /^[\x21-\x7e]{1,16384}$/;

function deadline<T>(work: Promise<T>, ms: number, kind: MailErrorKind = 'offline'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new MailError(kind)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The token endpoint, for a code or a refresh. Errors are read for their `error` CODE only. */
async function tokenRequest(fetch: GraphFetch, form: Record<string, string>, now: number, timeoutMs: number): Promise<Tokens> {
  const send = async (): Promise<Tokens> => {
    let response: Awaited<ReturnType<GraphFetch>>;
    try {
      response = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES, ...form }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new MailError('offline');
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      /* an unreadable body is judged by its status alone */
    }
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : '';
      if (response.status === 429) throw new MailError('rate');
      if (/^(invalid_grant|interaction_required|invalid_client|unauthorized_client|consent_required|invalid_scope)$/.test(code) || response.status === 401) throw new MailError('auth');
      throw new MailError('server');
    }
    const access = body.access_token;
    const refresh = body.refresh_token;
    const expires = body.expires_in;
    if (typeof access !== 'string' || !TOKEN_TEXT.test(access)) throw new MailError('server');
    if (refresh !== undefined && (typeof refresh !== 'string' || !TOKEN_TEXT.test(refresh))) throw new MailError('server');
    const seconds = typeof expires === 'number' ? expires : typeof expires === 'string' ? Number(expires) : 3600;
    return { access, refresh: typeof refresh === 'string' ? refresh : null, expiresAt: now + Math.max(60, Math.min(86_400, seconds || 3600)) * 1000 };
  };
  return deadline(send(), timeoutMs);
}

// ── The stored refresh token ──────────────────────────────────────────────

function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
}

const tokenFile = (): string => path.join(app.getPath('userData'), 'graph-token.bin');

async function writeRefresh(token: string, file = tokenFile()): Promise<void> {
  if (!TOKEN_TEXT.test(token) || !encryptionAvailable()) throw new MailError('storage');
  try {
    const bytes = safeStorage.encryptString(JSON.stringify({ v: 1, account: M365_ADDRESS, refresh: token }));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, bytes, { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  } catch {
    throw new MailError('storage');
  }
}

async function readRefresh(file = tokenFile()): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new MailError('storage');
  }
  try {
    if (!encryptionAvailable() || bytes.length > 100_000) throw new Error();
    const saved = JSON.parse(safeStorage.decryptString(bytes)) as { refresh?: unknown; account?: unknown };
    if (saved.account !== M365_ADDRESS || typeof saved.refresh !== 'string' || !TOKEN_TEXT.test(saved.refresh)) throw new Error();
    return saved.refresh;
  } catch {
    throw new MailError('storage');
  }
}

export async function deleteGraphToken(file = tokenFile()): Promise<void> {
  for (const name of [file, `${file}.tmp`]) {
    try {
      await fs.unlink(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new MailError('storage');
    }
  }
}

export const hasGraphToken = async (file = tokenFile()): Promise<boolean> => {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
};

// ── The session: the only thing that holds a token ────────────────────────

export interface GraphReply { status: number; body: Record<string, unknown> }

/** An opaque session. Its tokens cannot be read; it can only make Graph requests, or be closed. */
export interface GraphSession {
  request(method: 'GET' | 'PATCH' | 'POST', url: string, body?: unknown, prefer?: string): Promise<GraphReply>;
  /** No more requests, and no more token rotation (Disconnect, or the account stopped). */
  close(): void;
}

/** A Graph failure with the wait Graph asked for, when it said. */
export class GraphError extends MailError {
  constructor(kind: MailErrorKind, readonly retryAfterMs: number | null = null, readonly gone = false) {
    super(kind);
  }
}

const GRAPH_URL = /^https:\/\/graph\.microsoft\.com\/v1\.0\/[\x21-\x7e]{1,8000}$/;

function retryAfter(value: string | null): number | null {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(1000, Math.min(600_000, s * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(1000, Math.min(600_000, at - Date.now())) : null;
}

export function createGraphSession(o: {
  fetch: GraphFetch;
  refresh: string;
  /** Called with each rotated refresh token; it is written encrypted. */
  rotate: (token: string) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  first?: Tokens;
}): GraphSession {
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let refresh = o.refresh;
  let tokens: Tokens | null = o.first ?? null;
  let renewing: Promise<Tokens> | null = null;
  let closed = false;

  async function renew(): Promise<Tokens> {
    if (renewing) return renewing;
    renewing = (async () => {
      const next = await tokenRequest(o.fetch, { grant_type: 'refresh_token', refresh_token: refresh }, now(), timeoutMs);
      // A refresh that was in flight when the session closed rotates nothing and is not used.
      if (closed) throw new GraphError('offline');
      if (next.refresh && next.refresh !== refresh) {
        refresh = next.refresh;
        // A rotated token that cannot be stored is still used this session; the old one on disk may then be refused later.
        await o.rotate(next.refresh).catch(() => undefined);
      }
      tokens = next;
      return next;
    })();
    try {
      return await renewing;
    } finally {
      renewing = null;
    }
  }

  async function access(): Promise<string> {
    if (tokens && tokens.expiresAt - now() > 120_000) return tokens.access;
    return (await renew()).access;
  }

  async function once(method: string, url: string, body: unknown, prefer: string | undefined, token: string): Promise<GraphReply & { retry: number | null }> {
    let response: Awaited<ReturnType<GraphFetch>>;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    try {
      response = await o.fetch(url, {
        method,
        redirect: 'error',
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GraphError('offline');
    }
    let parsed: Record<string, unknown> = {};
    try {
      const value = await response.json();
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      /* empty bodies (204) and unreadable ones: the status decides */
    }
    return { status: response.status, body: parsed, retry: retryAfter(response.headers.get('Retry-After')) };
  }

  return Object.freeze({
    async request(method: 'GET' | 'PATCH' | 'POST', url: string, body?: unknown, prefer?: string): Promise<GraphReply> {
      if (closed) throw new GraphError('offline');
      const full = url.startsWith('https://') ? url : `${GRAPH}${url}`;
      if (!GRAPH_URL.test(full)) throw new GraphError('invalid');
      const run = async (): Promise<GraphReply> => {
        let reply = await once(method, full, body, prefer, await access());
        if (reply.status === 401) {
          // The access token may have been revoked early: one refresh, one retry.
          tokens = null;
          reply = await once(method, full, body, prefer, await access());
        }
        const s = reply.status;
        if (s >= 200 && s < 300) return { status: s, body: reply.body };
        if (s === 401 || s === 403) throw new GraphError('auth');
        if (s === 404) throw new GraphError('invalid');
        if (s === 410) throw new GraphError('server', null, true);
        if (s === 429 || s === 503 || s === 504) throw new GraphError('rate', reply.retry ?? 60_000);
        throw new GraphError('server', reply.retry);
      };
      return deadline(run(), timeoutMs * 3);
    },
    close(): void {
      closed = true;
      tokens = null;
    },
  });
}

// ── Sign-in and the stored account ────────────────────────────────────────

export interface GraphAccountDeps {
  fetch: GraphFetch;
  openExternal: (url: string) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  signInMs?: number;
  /** For tests: where the encrypted refresh token lives. */
  file?: string;
}

export function createGraphAccount(deps: GraphAccountDeps) {
  const now = deps.now ?? Date.now;
  const file = deps.file ?? tokenFile();
  let pending: Loopback | null = null;
  /**
   * Disconnect bumps the generation. Every write and the delete go through one
   * queue, and a rotation checks its session's gate and generation when its
   * turn comes: a refresh that was in flight at Disconnect can never write the
   * file back after it was deleted.
   */
  let generation = 0;
  let files: Promise<unknown> = Promise.resolve();
  const live = new Set<GraphSession>();
  const queued = <T>(work: () => Promise<T>): Promise<T> => {
    const result = files.then(work);
    files = result.catch(() => undefined);
    return result;
  };
  /**
   * `gate.open` stays false until the sign-in's mailbox check passes: no
   * rotation before that. `gate.born` is the generation the session was made
   * in: after a Disconnect nothing it holds is written, the sign-in's own first
   * write included. A closed session leaves `live` (a failed check, a
   * reconnect, a screen suspend), so the set holds only sessions in use.
   */
  const session = (refresh: string, first?: Tokens, gate = { open: true, born: generation }): GraphSession => {
    const inner = createGraphSession({
      fetch: deps.fetch, refresh, now, timeoutMs: deps.timeoutMs, first,
      rotate: (token) => queued(async () => {
        if (!gate.open || gate.born !== generation) return;
        await writeRefresh(token, file);
      }),
    });
    const s: GraphSession = Object.freeze({
      request: inner.request,
      close(): void {
        inner.close();
        live.delete(s);
      },
    });
    live.add(s);
    return s;
  };

  return {
    /** The stored session, or null when none is stored. */
    async load(): Promise<GraphSession | null> {
      const refresh = await readRefresh(file);
      return refresh ? session(refresh) : null;
    },

    /**
     * The whole browser sign-in. Resolves with a session once Microsoft has
     * issued tokens for gustav@muchbetter.world and the refresh token is
     * stored; rejects with a SignInError or MailError kind otherwise.
     */
    async signIn(): Promise<GraphSession> {
      pending?.cancel();
      const { verifier, challenge } = pkce();
      const state = newState();
      const loop = await startLoopback(state, deps.signInMs ?? SIGN_IN_MS);
      pending = loop;
      try {
        const url = authorizeUrl({ challenge, state, redirectUri: loop.redirectUri });
        if (!url.startsWith(`${AUTHORITY}/oauth2/v2.0/authorize?`)) throw new SignInError('invalid');
        try {
          await deps.openExternal(url);
        } catch {
          loop.cancel();
          throw new SignInError('offline');
        }
        const code = await loop.code;
        let first: Tokens;
        try {
          first = await tokenRequest(deps.fetch, {
            grant_type: 'authorization_code', code, redirect_uri: loop.redirectUri, code_verifier: verifier,
          }, now(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
        } catch (error) {
          const kind = error instanceof MailError ? error.kind : 'server';
          throw new SignInError(kind === 'auth' ? 'refused' : kind === 'offline' ? 'offline' : kind === 'rate' ? 'rate' : 'refused');
        }
        if (!first.refresh) throw new SignInError('refused');
        const gate = { open: false, born: generation };
        const s = session(first.refresh, first, gate);
        // The mailbox must be Gustav's, as a monday token must be.
        let who: GraphReply;
        try {
          who = await s.request('GET', '/me?$select=mail,userPrincipalName');
        } catch {
          throw new SignInError('offline');
        }
        const names = [who.body.mail, who.body.userPrincipalName].filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase());
        if (!names.includes(M365_ADDRESS)) {
          s.close();
          throw new SignInError('account');
        }
        gate.open = true;
        const token = first.refresh;
        // Checked inside the queue, at the moment of writing: a Disconnect during the
        // sign-in means nothing is stored and the sign-in does not count.
        const stored = await queued(async () => {
          if (gate.born !== generation) return 'cancelled' as const;
          await writeRefresh(token, file);
          return 'stored' as const;
        }).catch(() => 'failed' as const);
        if (stored !== 'stored') {
          s.close();
          throw new SignInError(stored === 'cancelled' ? 'cancelled' : 'storage');
        }
        return s;
      } finally {
        if (pending === loop) pending = null;
      }
    },

    /** Cancel a sign-in that is waiting for the browser. */
    cancel(): void {
      pending?.cancel();
    },

    /** How many sessions are open (for tests and diagnostics; never a token). */
    openSessions: (): number => live.size,

    /** Disconnect: close every session, stop every pending rotation, delete the file. */
    remove(): Promise<void> {
      generation++;
      for (const s of [...live]) s.close();
      live.clear();
      return queued(() => deleteGraphToken(file));
    },
  };
}

export type GraphAccount = ReturnType<typeof createGraphAccount>;

// ── Mail through Graph ────────────────────────────────────────────────────

const SELECT = 'id,receivedDateTime,isRead,flag,subject,from,bodyPreview,inferenceClassification,internetMessageId,webLink';
const NO_REPLY = /(?:^|[._+-])no-?reply(?:[._+-]|@)/i;
const ADDRESS = /^[^\s<>@\u0000-\u001f]+@[^\s<>@]+\.[^\s<>@]+$/;
const WEB_LINK = /^https:\/\/outlook\.(?:office365|office)\.com\/[\x21-\x7e]{1,4000}$/;
const MESSAGE_ID = /^[A-Za-z0-9+/=_-]{1,512}$/;

interface Stored {
  id: string;
  received: string;
  isRead: boolean;
  flagged: boolean;
  subject: string;
  fromName: string;
  fromAddress: string;
  preview: string;
  other: boolean;
  internetId: string | null;
  webLink: string | null;
  /** Set when a header check found List-Unsubscribe. */
  listed: boolean;
}

export interface GraphSnapshot { account: MailAccountView; rows: MailRow[] }

const str = (v: unknown, max: number): string => (typeof v === 'string' ? cleanMailText(mailToText(v, false, max), max) : '');

/** One message object from Graph, merged over what was known. Unknown shapes are dropped, never guessed. */
function mergeMessage(prev: Stored | undefined, raw: Record<string, unknown>): Stored | null {
  const id = raw.id;
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) return null;
  const base: Stored = prev ?? {
    id, received: '', isRead: false, flagged: false, subject: '', fromName: '', fromAddress: '', preview: '',
    other: false, internetId: null, webLink: null, listed: false,
  };
  const next: Stored = { ...base, id };
  if (typeof raw.receivedDateTime === 'string' && Number.isFinite(Date.parse(raw.receivedDateTime))) next.received = new Date(raw.receivedDateTime).toISOString();
  // Graph's own delta samples show isRead as "true" (a string): both are read.
  if ('isRead' in raw) next.isRead = raw.isRead === true || raw.isRead === 'true';
  if (raw.flag && typeof raw.flag === 'object') next.flagged = (raw.flag as Record<string, unknown>).flagStatus === 'flagged';
  if ('subject' in raw) next.subject = str(raw.subject, 500);
  if ('bodyPreview' in raw) next.preview = str(raw.bodyPreview, 255).replace(/\s+/g, ' ').trim();
  if (raw.from && typeof raw.from === 'object') {
    const email = (raw.from as Record<string, unknown>).emailAddress as Record<string, unknown> | undefined;
    const address = typeof email?.address === 'string' ? email.address.trim() : '';
    next.fromAddress = address.length <= 254 && ADDRESS.test(address) ? cleanMailText(address, 254) : '';
    next.fromName = str(email?.name, 200);
  }
  if ('inferenceClassification' in raw) next.other = raw.inferenceClassification === 'other';
  if (typeof raw.internetMessageId === 'string') next.internetId = raw.internetMessageId.slice(0, 1000);
  if (typeof raw.webLink === 'string') next.webLink = WEB_LINK.test(raw.webLink) ? raw.webLink : null;
  return next.received ? next : null;
}

export function createGraphMail(o: {
  session: GraphSession;
  account: { id: string; label: string; colour: string };
  now?: () => number;
  /** The wait between syncs: 60 s in working hours, 5 min otherwise (mail.ts decides). */
  interval?: (now: number) => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}) {
  const now = o.now ?? Date.now;
  const interval = o.interval ?? (() => 60_000);
  const schedule = o.schedule ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const cancel = o.cancel ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
  const account = Object.freeze({ ...o.account });

  const store = new Map<string, Stored>();
  const handles = new Map<string, string>();
  const ids = new Map<string, string>();
  const undoMoves = new Map<string, { id: string; expires: number }>();
  /** Ids this wall moved back into the Inbox: not new mail. */
  const own = new Set<string>();
  const folderIds = new Map<string, string>();
  let deltaLink: string | null = null;
  let nextLink: string | null = null;
  /** The first full round is done: only then is an addition "new mail". */
  let baseline = false;
  /**
   * New mail must not be older than the newest message the first round saw:
   * that is server time (receivedDateTime), so the PC's clock plays no part.
   * The store keeps 500 messages but the delta covers 30 days, so an old
   * message changed in Outlook comes back from the delta as an id the store
   * no longer has: by date, and by `seenIds`, it is not new.
   */
  let baselineFrom = 0;
  let roundNewest = 0;
  const seenIds = new Set<string>();
  const SEEN_IDS_MAX = 50_000;
  /** 410s in a row: a delta that keeps expiring is a failure, not a loop. */
  let goneRun = 0;
  /** New messages whose header check a 429 interrupted: their notices go out next tick. */
  let carried: string[] = [];
  let unread = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let running = false;
  let stopped = false;
  let timer: unknown;
  let listener: ((s: GraphSnapshot, events: MailEvent[]) => void) | undefined;
  let onError: ((e: MailError) => void) | undefined;

  const handleOf = (id: string): string => {
    let h = ids.get(id);
    if (!h) {
      h = Buffer.from(JSON.stringify([account.id, randomUUID()])).toString('base64url');
      ids.set(id, h);
      handles.set(h, id);
    }
    return h;
  };

  function idOf(handle: unknown): string {
    if (typeof handle !== 'string' || handle.length > 256 || !/^[A-Za-z0-9_-]+$/.test(handle)) throw new MailError('invalid');
    const id = handles.get(handle);
    if (!id) throw new MailError('invalid');
    return id;
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      if (stopped) throw new MailError('offline');
      try {
        return await work();
      } catch (error) {
        if (error instanceof GraphError) throw error;
        if (error instanceof MailError) throw new MailError(error.kind);
        throw new MailError('server');
      }
    });
    queue = result.catch(() => undefined);
    return result;
  }

  function row(m: Stored): MailRow {
    return {
      account: account.id, handle: handleOf(m.id), fromName: m.fromName, fromAddress: m.fromAddress,
      subject: m.subject, snippet: m.preview, date: m.received, seen: m.isRead, flagged: m.flagged,
      bulk: m.other || m.listed || NO_REPLY.test(m.fromAddress),
    };
  }

  function newest(): Stored[] {
    return [...store.values()].sort((a, b) => b.received.localeCompare(a.received));
  }

  function snapshot(): GraphSnapshot {
    const list = newest();
    // The store keeps a little more than the view, so a removal does not leave a hole.
    for (const m of list.slice(STORE_MAX)) store.delete(m.id);
    const rows = list.slice(0, VIEW_MAX).map(row);
    const live = new Set(list.slice(0, STORE_MAX).map((m) => m.id));
    for (const [id, h] of ids) {
      if (!live.has(id)) {
        ids.delete(id);
        handles.delete(h);
      }
    }
    return {
      account: { id: account.id, label: account.label, colour: account.colour, unread, status: 'ready', syncedAt: new Date(now()).toISOString(), provider: 'graph' },
      rows,
    };
  }

  function initialUrl(): string {
    const since = new Date(now() - DELTA_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const q = `$select=${SELECT}&$filter=receivedDateTime+ge+${since}&$orderby=receivedDateTime+desc`;
    return `${GRAPH}/me/mailFolders/inbox/messages/delta?${q}`;
  }

  /** List-Unsubscribe is only in the full headers: asked for a few new messages, never the whole list. */
  async function checkHeaders(m: Stored): Promise<void> {
    try {
      const r = await o.session.request('GET', `/me/messages/${encodeURIComponent(m.id)}?$select=internetMessageHeaders`);
      const list = Array.isArray(r.body.internetMessageHeaders) ? r.body.internetMessageHeaders : [];
      m.listed = list.some((h) => h && typeof h === 'object' && typeof (h as Record<string, unknown>).name === 'string' &&
        /^list-unsubscribe$/i.test((h as Record<string, unknown>).name as string));
    } catch (error) {
      if (error instanceof GraphError && (error.kind === 'auth' || error.kind === 'rate')) throw error;
      // Otherwise the message keeps the other bulk signs (Outlook's Other, no-reply).
    }
  }

  function remember(id: string): void {
    seenIds.delete(id);
    seenIds.add(id);
    if (seenIds.size > SEEN_IDS_MAX) seenIds.delete(seenIds.values().next().value as string);
  }

  async function syncInternal(): Promise<{ snapshot: GraphSnapshot; events: MailEvent[] }> {
    const added: Stored[] = carried.map((id) => store.get(id)).filter((m): m is Stored => !!m);
    carried = [];
    let pages = 0;
    if (!nextLink && !deltaLink) roundNewest = 0;
    let url = nextLink ?? deltaLink ?? initialUrl();
    for (;;) {
      if (!GRAPH_URL.test(url)) throw new GraphError('server');
      let reply: GraphReply;
      try {
        reply = await o.session.request('GET', url, undefined, `odata.maxpagesize=${PAGE_SIZE}`);
      } catch (error) {
        if (error instanceof GraphError && error.gone) {
          // The delta token expired (410): start a new baseline, which notifies nothing.
          // Twice in a row is a failure (a server problem), not a loop.
          if (++goneRun >= 2) {
            goneRun = 0;
            throw new GraphError('server');
          }
          deltaLink = null;
          nextLink = null;
          baseline = false;
          store.clear();
          roundNewest = 0;
          url = initialUrl();
          continue;
        }
        throw error;
      }
      goneRun = 0;
      const value = reply.body.value;
      if (!Array.isArray(value)) throw new GraphError('server');
      for (const raw of value) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        if (typeof r.id !== 'string') continue;
        if (r['@removed']) {
          store.delete(r.id);
          continue;
        }
        const known = store.has(r.id) || seenIds.has(r.id);
        const merged = mergeMessage(store.get(r.id), r);
        if (!merged) continue;
        store.set(merged.id, merged);
        remember(merged.id);
        if (!baseline) roundNewest = Math.max(roundNewest, Date.parse(merged.received));
        if (!known && baseline && !own.has(merged.id) && Date.parse(merged.received) >= baselineFrom) added.push(merged);
      }
      const next = reply.body['@odata.nextLink'];
      const delta = reply.body['@odata.deltaLink'];
      if (typeof delta === 'string') {
        deltaLink = delta;
        nextLink = null;
        if (!baseline) baselineFrom = roundNewest;
        baseline = true;
        break;
      }
      if (typeof next !== 'string') throw new GraphError('server');
      nextLink = next;
      url = next;
      if (++pages >= PAGES_PER_TICK) break;
    }
    own.clear();
    try {
      const folder = await o.session.request('GET', '/me/mailFolders/inbox?$select=unreadItemCount');
      const count = folder.body.unreadItemCount;
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) unread = count;
      const fresh = added.filter((m) => !m.other && !NO_REPLY.test(m.fromAddress)).slice(0, 5);
      for (const m of fresh) await checkHeaders(m);
    } catch (error) {
      // The delta has advanced and these messages are in the store now, so they would never be
      // "new" again: whatever failed (the unread count, a rate-limited header check), carry
      // them, and their notices go out on the next tick.
      carried = added.map((m) => m.id);
      throw error;
    }
    const events: MailEvent[] = added.map((m) => {
      const r = row(m);
      return {
        kind: r.bulk ? 'bulk' : 'person', account: account.id, handle: r.handle, fromName: r.fromName,
        fromAddress: r.fromAddress, subject: r.subject, key: `${account.id}:${createHash('sha256').update(m.internetId ?? m.id).digest('hex').slice(0, 32)}`,
      };
    });
    return { snapshot: snapshot(), events };
  }

  function arm(ms: number): void {
    if (!running || stopped) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => {
      timer = undefined;
      tick();
    }, ms);
  }

  function tick(): void {
    if (!running || stopped) return;
    void enqueue(syncInternal).then(({ snapshot: s, events }) => {
      try {
        listener?.(s, events);
      } catch {
        /* a view consumer cannot break sync */
      }
      // A first round longer than one tick carries on soon.
      arm(nextLink ? 2000 : interval(now()));
    }, (error: unknown) => {
      const e = error instanceof MailError ? error : new MailError('server');
      try {
        onError?.(new MailError(e.kind));
      } catch {
        /* isolated */
      }
      if (e.kind === 'auth') {
        running = false;
        return;
      }
      const wait = error instanceof GraphError && error.retryAfterMs ? error.retryAfterMs : 0;
      arm(Math.max(wait, e.kind === 'offline' ? 30_000 : interval(now())));
    });
  }

  async function readBack(id: string): Promise<Stored> {
    const r = await o.session.request('GET', `/me/messages/${encodeURIComponent(id)}?$select=${SELECT},parentFolderId`);
    const merged = mergeMessage(store.get(id), r.body);
    if (!merged || merged.id !== id) throw new MailError('mismatch');
    return merged;
  }

  function change(handle: string, patch: Record<string, unknown>, check: (m: Stored) => boolean): Promise<MailRow> {
    return enqueue(async () => {
      const id = idOf(handle);
      await o.session.request('PATCH', `/me/messages/${encodeURIComponent(id)}`, patch);
      const m = await readBack(id);
      if (!check(m)) throw new MailError('mismatch');
      store.set(id, m);
      return row(m);
    }).finally(() => arm(1000));
  }

  async function folderId(name: 'inbox' | 'archive' | 'deleteditems'): Promise<string> {
    const known = folderIds.get(name);
    if (known) return known;
    const r = await o.session.request('GET', `/me/mailFolders/${name}?$select=id`);
    if (typeof r.body.id !== 'string' || !MESSAGE_ID.test(r.body.id)) throw new MailError('server');
    folderIds.set(name, r.body.id);
    return r.body.id;
  }

  /** POST move, then prove where it landed by the id the move returned. Never a DELETE. */
  async function moveTo(id: string, destination: 'inbox' | 'archive' | 'deleteditems'): Promise<string> {
    const target = await folderId(destination);
    const r = await o.session.request('POST', `/me/messages/${encodeURIComponent(id)}/move`, { destinationId: destination });
    const moved = r.body.id;
    if (typeof moved !== 'string' || !MESSAGE_ID.test(moved)) throw new MailError('mismatch');
    const back = await o.session.request('GET', `/me/messages/${encodeURIComponent(moved)}?$select=id,parentFolderId`);
    if (back.body.id !== moved || back.body.parentFolderId !== target) throw new MailError('mismatch');
    return moved;
  }

  function moveOut(handle: string, destination: 'archive' | 'deleteditems'): Promise<{ undo: string }> {
    return enqueue(async () => {
      const id = idOf(handle);
      const moved = await moveTo(id, destination);
      store.delete(id);
      for (const [token, entry] of undoMoves) if (entry.expires < now()) undoMoves.delete(token);
      const undo = randomUUID();
      undoMoves.set(undo, { id: moved, expires: now() + GRAPH_UNDO_MS });
      return { undo };
    }).finally(() => arm(1000));
  }

  return Object.freeze({
    start(receive: (s: GraphSnapshot, events: MailEvent[]) => void, failed?: (e: MailError) => void): void {
      if (stopped) throw new MailError('offline');
      listener = receive;
      onError = failed;
      if (!running) {
        running = true;
        tick();
      }
    },
    stop(): void {
      stopped = true;
      running = false;
      if (timer !== undefined) cancel(timer);
      o.session.close();
      store.clear();
      handles.clear();
      ids.clear();
      undoMoves.clear();
    },
    /** One sync now, for tests and the first paint. */
    sync: (): Promise<GraphSnapshot> => enqueue(async () => (await syncInternal()).snapshot),
    markRead: (handle: string) => change(handle, { isRead: true }, (m) => m.isRead),
    markUnread: (handle: string) => change(handle, { isRead: false }, (m) => !m.isRead),
    flag: (handle: string) => change(handle, { flag: { flagStatus: 'flagged' } }, (m) => m.flagged),
    unflag: (handle: string) => change(handle, { flag: { flagStatus: 'notFlagged' } }, (m) => !m.flagged),
    archive: (handle: string) => moveOut(handle, 'archive'),
    trash: (handle: string) => moveOut(handle, 'deleteditems'),
    undo: (token: string): Promise<{ handle: string }> => enqueue(async () => {
      const entry = typeof token === 'string' ? undoMoves.get(token) : undefined;
      if (!entry || entry.expires < now()) throw new MailError('invalid');
      undoMoves.delete(token);
      const back = await moveTo(entry.id, 'inbox');
      own.add(back);
      const m = await readBack(back);
      store.set(back, m);
      return { handle: handleOf(back) };
    }).finally(() => arm(1000)),
    open: (handle: string): Promise<MailBody> => enqueue(async () => {
      const id = idOf(handle);
      const r = await o.session.request('GET', `/me/messages/${encodeURIComponent(id)}?$select=body,hasAttachments`);
      const body = r.body.body as Record<string, unknown> | undefined;
      const content = typeof body?.content === 'string' ? body.content : '';
      const html = body?.contentType !== 'text';
      // HTML is reduced to text here, in main. The renderer only ever gets the text.
      const text = cleanMailText(mailToText(content, html, BODY_LIMIT), BODY_LIMIT);
      const attachments: MailBody['attachments'] = [];
      if (r.body.hasAttachments === true) {
        const a = await o.session.request('GET', `/me/messages/${encodeURIComponent(id)}/attachments?$select=name,size,isInline&$top=50`);
        for (const item of Array.isArray(a.body.value) ? a.body.value : []) {
          if (!item || typeof item !== 'object') continue;
          const x = item as Record<string, unknown>;
          if (x.isInline === true) continue;
          attachments.push({ name: str(x.name || 'Attachment', 255), size: typeof x.size === 'number' && Number.isSafeInteger(x.size) && x.size >= 0 ? x.size : 0 });
        }
      }
      const m = store.get(id);
      if (m && !m.preview) m.preview = text.replace(/\s+/g, ' ').slice(0, 200);
      return { handle, text, attachments };
    }),
    /** The message in Outlook on the web: Graph's own webLink when it is an Outlook URL, else the inbox. */
    webUrl(handle: string): string {
      const m = store.get(idOf(handle));
      return m?.webLink ?? 'https://outlook.office.com/mail/inbox';
    },
  });
}

export type GraphMail = ReturnType<typeof createGraphMail>;
