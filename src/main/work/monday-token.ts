import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type MondayFetch = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/** An opaque credential. Only the fixed monday HTTP request can use its secret. */
export interface MondayToken {
  post(fetch: MondayFetch, body: string): Promise<unknown>;
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
    async post(fetch: MondayFetch, body: string): Promise<unknown> {
      try {
        const response = await fetch('https://api.monday.com/v2', {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: token, 'API-Version': '2026-10', 'Content-Type': 'application/json' },
          body,
        });
        if (!response.ok) throw new Error();
        return await response.json();
      } catch {
        // Transport and JSON errors can contain request headers. Never forward them.
        throw new Error('Monday request failed.');
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
