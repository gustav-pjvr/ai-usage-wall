/**
 * Where projection credentials live.
 *
 * NOT in settings.json. That file is hand-edited, backed up, pasted into chat
 * windows when something goes wrong, and synced by whatever the user syncs. It
 * is the wrong place for a key that decrypts a live feed of someone's machine.
 *
 * So: a separate `projection.json` in userData, encrypted with Electron's
 * safeStorage, which on Windows is DPAPI scoped to the logged-in user. Copying
 * the file to another machine yields nothing.
 *
 * The file's PRESENCE is also the on switch. No file means projection is off
 * and no network object is ever constructed, which is what makes "off means no
 * network" a structural fact rather than a promise (rule 25).
 */

import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type ProjectionRole = 'source' | 'screen';

/** One screen the source is willing to encrypt for. */
export interface ScreenRecord {
  screenId: string;
  /** Base64 of the 32-byte AES key. Deleting this revokes the screen locally. */
  key: string;
  label: string;
  pairedAt: string;
  /** False until the screen has proved it holds the same key. */
  confirmed: boolean;
  /**
   * Highest sequence accepted from this screen on the `up` channel.
   *
   * The down direction has always had a replay boundary; this is the same idea
   * for the other direction, added when chat made `up` frames frequent enough
   * to be worth replaying. Persisted so it survives a restart, which is the
   * whole point: an in-memory boundary resets to zero and lets a relay replay
   * everything it kept.
   */
  lastUpSeq?: number;
}

export interface SourceState {
  role: 'source';
  relayUrl: string;
  spaceId: string;
  sourceSecret: string;
  screens: ScreenRecord[];
  /** Screens revoked while offline, to be told to the relay on next connect. */
  pendingRevocations: string[];
  label: string;
  shareProjectNames: boolean;
}

export interface ScreenState {
  role: 'screen';
  relayUrl: string;
  spaceId: string;
  screenId: string;
  screenToken: string;
  key: string;
  sourceLabel: string;
  pairedAt: string;
}

export type ProjectionState = SourceState | ScreenState;

const FILE = 'projection.json';
const CHAT = 'projection-chat.json';
const CACHE = 'projection-last.json';

const filePath = (name: string): string => path.join(app.getPath('userData'), name);

/**
 * Coerce anything into a valid state, or null.
 *
 * Never throws, for the same reason the settings loader never throws: a
 * corrupted file must degrade to "projection is off", which is a safe and
 * obvious state, rather than taking the whole app down on startup.
 */
export function normalise(raw: unknown): ProjectionState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const url = str(r.relayUrl);
  // https only. A downgrade to ws:// would put frames on the wire in the clear
  // for anyone on the same network to collect.
  if (!url.startsWith('https://')) return null;

  if (r.role === 'source') {
    if (!str(r.spaceId) || !str(r.sourceSecret)) return null;
    const screens = Array.isArray(r.screens)
      ? (r.screens as Record<string, unknown>[])
          .filter((s) => s && typeof s === 'object' && str(s.screenId) && str(s.key))
          .map((s) => ({
            screenId: str(s.screenId),
            key: str(s.key),
            label: str(s.label) || 'Screen',
            pairedAt: str(s.pairedAt) || new Date().toISOString(),
            confirmed: s.confirmed === true,
            lastUpSeq: Number.isFinite(Number(s.lastUpSeq)) ? Number(s.lastUpSeq) : 0,
          }))
      : [];
    return {
      role: 'source',
      relayUrl: url,
      spaceId: str(r.spaceId),
      sourceSecret: str(r.sourceSecret),
      screens,
      pendingRevocations: Array.isArray(r.pendingRevocations)
        ? r.pendingRevocations.filter((v): v is string => typeof v === 'string')
        : [],
      label: str(r.label),
      // Default ON: the normal case is one person and two of their own
      // machines. The tray can turn it off and the opt-in dialog says so.
      shareProjectNames: r.shareProjectNames !== false,
    };
  }

  if (r.role === 'screen') {
    if (!str(r.spaceId) || !str(r.screenId) || !str(r.screenToken) || !str(r.key)) return null;
    return {
      role: 'screen',
      relayUrl: url,
      spaceId: str(r.spaceId),
      screenId: str(r.screenId),
      screenToken: str(r.screenToken),
      key: str(r.key),
      sourceLabel: str(r.sourceLabel),
      pairedAt: str(r.pairedAt) || new Date().toISOString(),
    };
  }

  return null;
}

async function readEncrypted(name: string): Promise<unknown> {
  const buf = await fs.readFile(filePath(name)).catch(() => null);
  if (!buf || buf.length === 0) return null;
  try {
    // Written encrypted when the platform offered it, plain otherwise. Sniffing
    // for '{' rather than storing a flag means a file written on a machine
    // without DPAPI still reads on one with it.
    const text = buf[0] === 0x7b ? buf.toString('utf8') : safeStorage.decryptString(buf);
    // Strip a BOM, as everything else in this project does. See rule 11.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    console.warn(`[projection] ${name} could not be read: ${(err as Error).message}`);
    return null;
  }
}

let warnedPlaintext = false;

async function writeEncrypted(name: string, value: unknown): Promise<void> {
  const target = filePath(name);
  const tmp = `${target}.tmp`;
  const text = JSON.stringify(value, null, 2);
  const encrypted = safeStorage.isEncryptionAvailable();
  if (!encrypted && !warnedPlaintext) {
    // Once per process, not once per write: the point is that it gets seen,
    // and a warning on every cache write would be scrolled past instead.
    warnedPlaintext = true;
    console.warn(
      '[projection] safeStorage is unavailable on this machine, so ' + FILE + ' and ' + CACHE +
        ' are written in PLAINTEXT under userData. Anyone who can read that folder can read the projection key.',
    );
  }
  const body = encrypted ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, body);
  // Atomic: a crash mid-write must not leave a half key on disk.
  await fs.rename(tmp, target);
}

export async function loadProjection(): Promise<ProjectionState | null> {
  return normalise(await readEncrypted(FILE));
}

export async function saveProjection(state: ProjectionState): Promise<void> {
  await writeEncrypted(FILE, state);
}

/** Turning projection off is deleting the file. Nothing lingers. */
export async function clearProjection(): Promise<void> {
  await fs.rm(filePath(FILE), { force: true }).catch(() => {});
  await fs.rm(filePath(CACHE), { force: true }).catch(() => {});
  // The conversation goes with the pairing. Turning projection off and leaving
  // the messages on disk would be the surprising half of "forget".
  await fs.rm(filePath(CHAT), { force: true }).catch(() => {});
}

/**
 * Chat threads. Same writer as the keys, so same DPAPI protection and the same
 * one-per-process warning if safeStorage is unavailable.
 */
export async function readChatFile(): Promise<unknown> {
  return readEncrypted(CHAT);
}

export async function writeChatFile(value: unknown): Promise<void> {
  await writeEncrypted(CHAT, value).catch((err) => {
    // Losing a write costs history on next launch, nothing in the live session.
    console.warn('[chat] could not save threads:', (err as Error).message);
  });
}

export interface LastFrameCache {
  /** The last frame's wire payload, or null when only a sequence has been seen. */
  payload: unknown;
  /** Screen-clock arrival of that payload; 0 when there is none. */
  receivedAt: number;
  /** The highest sequence this screen accepted; 0 when nothing ever was. */
  seq: number;
}

/**
 * The screen's last decrypted frame AND the sequence it accepted, so a restart
 * shows something dated rather than an empty wall and, more importantly,
 * refuses anything older than what it had already seen.
 *
 * The payload is a convenience and is always displayed with its age. The
 * sequence is the replay boundary, which is why the receiver writes this after
 * every accepted message rather than on a throttle.
 */
export async function loadLastFrame(): Promise<LastFrameCache | null> {
  const raw = (await readEncrypted(CACHE)) as { payload?: unknown; receivedAt?: number; seq?: number } | null;
  if (!raw || typeof raw !== 'object') return null;
  const seq = typeof raw.seq === 'number' && Number.isFinite(raw.seq) && raw.seq > 0 ? raw.seq : 0;
  const hasPayload = typeof raw.payload === 'object' && raw.payload !== null && typeof raw.receivedAt === 'number';
  return {
    payload: hasPayload ? raw.payload : null,
    receivedAt: hasPayload ? (raw.receivedAt as number) : 0,
    seq,
  };
}

export async function saveLastFrame(payload: unknown, receivedAt: number, seq: number): Promise<void> {
  await writeEncrypted(CACHE, { payload, receivedAt, seq }).catch((err) =>
    console.warn('[projection] could not cache the last frame:', (err as Error).message),
  );
}
