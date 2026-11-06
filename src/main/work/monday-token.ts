import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type MondayFetch = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  /** HTTP status. Optional so a minimal fake can omit it; absent means "not ok, reason unknown". */
  status?: number;
  json(): Promise<unknown>;
}>;

/**
 * Why a monday request failed, in words the status strip can show. Never server
 * text. 'daily' is the account's daily call cap (DAILY_LIMIT_EXCEEDED), which
 * resets at 00:00 UTC (02:00 SAST); 'rate' is the per-minute budget.
 */
export type MondayErrorKind = 'auth' | 'offline' | 'rate' | 'daily' | 'server';

/** Every monday request ends within this, answered or not (a stalled request is 'offline'). */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A request failure with a fixed message and a kind. The message is the same
 * for every kind on purpose: GraphQL errors, transport errors and JSON parse
 * errors can echo request text, so nothing the server or the network said is
 * ever carried, only which of four buckets it fell into.
 */
export class MondayError extends Error {
  constructor(readonly kind: MondayErrorKind) {
    super('Monday request failed.');
    this.name = 'MondayError';
  }
}

/** An opaque credential. Only the fixed monday HTTP request can use its secret. */
export interface MondayToken {
  post(fetch: MondayFetch, body: string, timeoutMs?: number): Promise<unknown>;
}

type Body = Record<string, unknown>;

/**
 * Sort a failure into a kind by HTTP status and the error CODES in the body
 * only. Message text is never read: it can echo the query, its variables or
 * the credential.
 */
export function classifyFailure(status: number | undefined, body: unknown): MondayErrorKind {
  const codes: unknown[] = [status];
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Body;
    codes.push(b.error_code, b.status_code);
    if (Array.isArray(b.errors)) {
      for (const e of b.errors) {
        const ext = e && typeof e === 'object' ? (e as Body).extensions : null;
        if (ext && typeof ext === 'object') codes.push((ext as Body).code, (ext as Body).status_code);
      }
    }
  }
  const text = codes.filter((c) => typeof c === 'string' || typeof c === 'number').map(String).join(' ');
  if (/daily_?limit/i.test(text)) return 'daily';
  if (/\b(401|403)\b|unauthori[sz]ed|not_?authenticated|invalid_?token/i.test(text)) return 'auth';
  if (/\b429\b|rate_?limit|complexity|concurrency/i.test(text)) return 'rate';
  return 'server';
}

const filePath = (): string => path.join(app.getPath('userData'), 'monday-token.bin');
const validToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/\s/.test(value);

function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');
}

export function createMondayToken(token: string): MondayToken {
  if (!validToken(token)) throw new Error('Invalid monday token.');
  return Object.freeze({
    async post(fetch: MondayFetch, body: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
      const send = async (): Promise<unknown> => {
        let response: Awaited<ReturnType<MondayFetch>>;
        try {
          response = await fetch('https://api.monday.com/v2', {
            method: 'POST',
            redirect: 'error',
            headers: { Authorization: token, 'API-Version': '2026-10', 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          // Transport errors (an abort included) can contain request headers. Never forward them.
          throw new MondayError('offline');
        }
        let parsed: unknown = null;
        try {
          parsed = await response.json();
        } catch {
          if (response.ok) throw new MondayError('server');
        }
        // The body of a refusal is read for its codes only (classifyFailure).
        if (!response.ok) throw new MondayError(classifyFailure(response.status, parsed));
        return parsed;
      };
      /*
       * The signal aborts the request; the race is for a fetch, or a body read,
       * that does not honour it. Either way no request outlives timeoutMs, so
       * no pending state on the wall or the toast can wait for ever.
       */
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        // Not unref'd: a request in flight is a reason to stay alive. It is cleared the moment the request ends.
        timer = setTimeout(() => reject(new MondayError('offline')), timeoutMs);
      });
      try {
        return await Promise.race([send(), deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export async function saveMondayToken(token: string): Promise<void> {
  try {
    if (!validToken(token) || !encryptionAvailable()) throw new Error();
    const encrypted = safeStorage.encryptString(token);
    const target = filePath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(`${target}.tmp`, encrypted);
    await fs.rename(`${target}.tmp`, target);
  } catch {
    throw new Error('Could not securely save the monday token.');
  }
}

export async function loadMondayToken(): Promise<MondayToken | null> {
  try {
    const encrypted = await fs.readFile(filePath());
    if (!encryptionAvailable()) throw new Error();
    return createMondayToken(safeStorage.decryptString(encrypted));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new Error('Could not securely load the monday token.');
  }
}

/**
 * Forget the token: the one fixed file in userData, nothing else. A missing
 * file is already the goal, so it is not an error.
 */
export async function deleteMondayToken(): Promise<void> {
  const target = filePath();
  for (const file of [target, `${target}.tmp`]) {
    try {
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error('Could not delete the monday token.');
    }
  }
}
