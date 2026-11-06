import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { cleanMailText } from './mail-text';

/**
 * Why a mail operation failed, as a fixed kind. Never server text: an IMAP or
 * Graph error can echo the command, and a login command carries the password.
 */
export type MailErrorKind = 'auth' | 'offline' | 'tls' | 'rate' | 'server' | 'invalid' | 'storage' | 'mismatch' | 'unsupported';
export class MailError extends Error {
  constructor(readonly kind: MailErrorKind) {
    super('Mail operation failed.');
    this.name = 'MailError';
  }
}

export interface MailAccount {
  id: string;
  kind: 'imap';
  label: string;
  colour: string;
  host: string;
  port: number;
  user: string;
}
export type MailPreset = 'gmail' | 'godaddy';
export const MAIL_PRESETS = Object.freeze({
  gmail: Object.freeze({ host: 'imap.gmail.com', port: 993 }),
  godaddy: Object.freeze({ host: 'imap.secureserver.net', port: 993 }),
});
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
const validPassword = (password: unknown): password is string =>
  typeof password === 'string' && password.length > 0 && password.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(password);

export function validateMailAccount(value: unknown): MailAccount {
  if (!value || typeof value !== 'object') throw new MailError('invalid');
  const a = value as MailAccount;
  if (!validId(a.id) || a.kind !== 'imap' || a.port !== 993 ||
      !Object.values(MAIL_PRESETS).some((p) => p.host === a.host) ||
      typeof a.label !== 'string' || !a.label.trim() || a.label.length > 100 || cleanMailText(a.label, 100) !== a.label ||
      typeof a.colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(a.colour) ||
      typeof a.user !== 'string' || a.user.length > 254 || !/^[^\s<>@\u0000-\u001f]+@[^\s<>@]+\.[^\s<>@]+$/.test(a.user) ||
      cleanMailText(a.user, 254) !== a.user ||
      (a.host === MAIL_PRESETS.godaddy.host && a.user !== 'gustav@pickleplaysouthafrica.org')) throw new MailError('invalid');
  return { id: a.id, kind: 'imap', label: a.label, colour: a.colour, host: a.host, port: 993, user: a.user };
}

/** Main-only capability. The trusted transport callback is the only recipient of plaintext. */
export interface MailCredential {
  use<T>(transport: (password: string) => Promise<T>): Promise<T>;
  redact(text: string): string;
}
export function createMailCredential(password: string): MailCredential {
  if (!validPassword(password)) throw new MailError('invalid');
  return Object.freeze({
    async use<T>(transport: (password: string) => Promise<T>): Promise<T> {
      try { return await transport(password); }
      catch (error) { throw mailFailure(error); }
    },
    redact: (text: string): string => text.split(password).join('[redacted]'),
  });
}

export function mailFailure(error: unknown): MailError {
  if (error instanceof MailError) return new MailError(error.kind);
  const e = error as { code?: unknown; authenticationFailed?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return new MailError('tls');
  if (e?.authenticationFailed === true || code === 'AUTHENTICATIONFAILED') return new MailError('auth');
  if (code === 'ETHROTTLE') return new MailError('rate');
  // imapflow's own codes (ETIMEOUT, CONNECT_TIMEOUT, GREETING_TIMEOUT, UPGRADE_TIMEOUT, NoConnection) and Node's socket codes.
  if (/^(ECONN|ENET|EHOST|ETIMEDOUT|ETIMEOUT|ENOTFOUND|EAI_AGAIN|EPIPE|NoConnection|ConnectionClosed|CONNECT_TIMEOUT|GREETING_TIMEOUT|UPGRADE_TIMEOUT)/.test(code)) return new MailError('offline');
  return new MailError('server');
}

const encrypted = (): boolean => safeStorage.isEncryptionAvailable() &&
  !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');

export function createMailAccountStore(directory = path.join(app.getPath('userData'), 'mail-accounts')) {
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work).catch(() => { throw new MailError('storage'); });
    queue = result.catch(() => {});
    return result;
  }
  function file(id: string): string {
    if (!validId(id)) throw new MailError('invalid');
    return path.join(directory, `${id}.bin`);
  }
  async function read(id: string): Promise<{ account: MailAccount; credential: MailCredential } | null> {
    const target = file(id);
    if (!encrypted()) throw new MailError('storage');
    let bytes: Buffer;
    try { bytes = await fs.readFile(target); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw error; }
    if (bytes.length > 100_000) throw new MailError('storage');
    const saved = JSON.parse(safeStorage.decryptString(bytes));
    const account = validateMailAccount(saved.account);
    if (account.id !== id) throw new MailError('storage');
    return { account, credential: createMailCredential(saved.password) };
  }
  return Object.freeze({
    save(input: { id: string; preset: MailPreset; label: string; colour: string; user: string }, password: string): Promise<MailAccount> {
      return serial(async () => {
        if (!Object.hasOwn(MAIL_PRESETS, input.preset) || !validPassword(password) || !encrypted()) throw new MailError('storage');
        const account = validateMailAccount({ ...input, ...MAIL_PRESETS[input.preset], kind: 'imap' });
        if (Object.values(account).some((v) => typeof v === 'string' && v.includes(password))) throw new MailError('storage');
        const bytes = safeStorage.encryptString(JSON.stringify({ account, password }));
        const target = file(account.id);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(`${target}.tmp`, bytes, { mode: 0o600 });
        await fs.rename(`${target}.tmp`, target);
        return account;
      });
    },
    load: (id: string) => serial(() => read(id)),
    list: () => serial(async (): Promise<MailAccount[]> => {
      let names: string[];
      try { names = await fs.readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []; throw error; }
      const result: MailAccount[] = [];
      for (const name of names.sort()) {
        if (!/^[a-zA-Z0-9_-]{1,64}\.bin$/.test(name)) continue;
        const saved = await read(name.slice(0, -4));
        if (saved) result.push(saved.account);
      }
      return result;
    }),
    remove: (id: string) => serial(async (): Promise<void> => {
      const target = file(id);
      for (const name of [target, `${target}.tmp`]) {
        try { await fs.unlink(name); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
      }
    }),
  });
}
