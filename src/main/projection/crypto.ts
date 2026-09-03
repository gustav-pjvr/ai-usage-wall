/**
 * Projection cryptography. Everything here runs in the MAIN process only.
 *
 * The guarantee this file exists to provide: the relay forwards bytes it cannot
 * read. It sees two public keys, a lookup digest and ciphertext, and it never
 * sees the pairing code, so it cannot compute the key.
 *
 * The scheme, and what each part is for:
 *
 *   X25519 exchange     defeats a PASSIVE relay completely. Logging every byte
 *                       that crosses gives it nothing: it cannot compute the
 *                       shared secret from two public keys.
 *
 *   the code, stretched authenticates the exchange. An ACTIVE relay could
 *                       substitute its own public keys, but then its key
 *                       differs from the source's and the first message fails
 *                       to open. To succeed it must guess the code, and scrypt
 *                       at N=2^15 makes each guess cost 32 MB and ~100 ms.
 *                       See src/shared/pairing-code.ts for the arithmetic.
 *
 *   the lookup          is derived from that SAME stretched code, never from
 *                       the raw one. Version 1 gave the relay a plain SHA-256
 *                       of the code, and the relay holds every lookup in its
 *                       own storage: it could test candidates against SHA-256
 *                       at GPU speed and pay scrypt only for the one that
 *                       matched, which made the stretch decorative. Now every
 *                       way of checking a candidate costs one scrypt.
 *
 *   per-screen keys     revoking a screen is deleting one key. No rekeying, and
 *                       no screen ever holds anything that opens another's
 *                       traffic.
 *
 *   AES-256-GCM         authenticated, so a relay that flips a bit is detected
 *                       rather than silently believed.
 *
 *   monotonic seq       in the AAD, so the relay cannot replay yesterday's
 *                       numbers as if they were current. See rule 29.
 *
 * All of it is Node's standard library. No dependency was added for this.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Bump when the frame layout or the key schedule changes. Version 2 moved the
 * lookup onto the stretched code and changed the key schedule with it, so a
 * version 1 pairing cannot open version 2 frames and is refused by this byte
 * rather than by a garbled tag.
 */
export const CRYPTO_VERSION = 2;

/*
 * scrypt parameters. N=2^15 with r=8 needs about 32 MB per guess, which is what
 * makes a GPU array unattractive: memory, not arithmetic, is the wall. maxmem
 * has to be raised explicitly or Node refuses its own defaults.
 */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
/* The scrypt salt is unchanged from version 1: the stretch itself was right,
 * only what was derived from it was wrong. */
const PAIR_SALT = 'csw-pair-v1';
const LOOKUP_INFO = 'csw-lookup-v2';
const KEY_INFO = 'csw-screen-key-v2';

/** X25519 public keys travel as the 32 raw bytes, base64. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface KeyPair {
  privateKey: KeyObject;
  /** Base64 of the raw 32-byte public key, which is what crosses the wire. */
  publicKey: string;
}

export function newKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  return { privateKey, publicKey: raw.toString('base64') };
}

function publicFromRaw(b64: string): KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error('bad public key length');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/**
 * The code, stretched: about 100 ms and 32 MB, and the ONLY place scrypt runs.
 *
 * Call it once per pairing and hand the result to both lookupFromStretched and
 * deriveScreenKey. Stretching twice pays twice for the same bytes; stretching
 * per message would stall the main process on every frame. The callers keep
 * the result alongside the pending offer for exactly that reason.
 */
export function stretchCode(code: string): Buffer {
  return scryptSync(code, PAIR_SALT, 32, SCRYPT);
}

/**
 * What the relay is told, so it can match a screen to a pending offer.
 *
 * One-way and truncated, and derived from the STRETCHED code: the relay can
 * compare it to what a redeeming screen presents, and testing a candidate code
 * against it costs the same scrypt as testing that candidate against the key.
 * Twenty-two base64url characters is 132 bits, more than the code carries, so
 * the truncation loses nothing that matters.
 */
export function lookupFromStretched(stretched: Buffer): string {
  return Buffer.from(hkdfSync('sha256', stretched, Buffer.alloc(0), LOOKUP_INFO, 32))
    .toString('base64url')
    .slice(0, 22);
}

/**
 * The shared frame key, derived identically on both machines.
 *
 * Both inputs are required: the X25519 secret (which the relay cannot compute)
 * and the stretched code (which the relay does not have). Missing either gives
 * a different key and every frame fails to open, which is exactly the intended
 * behaviour for a screen that guessed its way onto the socket.
 */
export function deriveScreenKey(
  myPrivate: KeyObject,
  theirPublicB64: string,
  stretched: Buffer,
  lookup: string,
): Buffer {
  const shared = diffieHellman({ privateKey: myPrivate, publicKey: publicFromRaw(theirPublicB64) });
  const ikm = Buffer.concat([shared, stretched]);
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.from(lookup), KEY_INFO, 32));
}

/*
 * Frame layout:
 *   version(1) | seq(8, big endian) | nonce(12) | ciphertext | tag(16)
 *
 * The version and seq are the AAD, so neither can be edited without failing the
 * tag. The payload is deflated before encryption: it is all our own JSON with
 * no attacker-chosen content mixed in, so the usual compression-oracle worry
 * does not apply, and numeric JSON compresses about four to one.
 */
const HEADER = 9;
const NONCE = 12;
const TAG = 16;

export function seal(key: Buffer, seq: number, payload: unknown): string {
  const header = Buffer.alloc(HEADER);
  header[0] = CRYPTO_VERSION;
  header.writeBigUInt64BE(BigInt(Math.floor(seq)), 1);

  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const body = deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([header, nonce, ct, cipher.getAuthTag()]).toString('base64');
}

export interface Opened {
  seq: number;
  payload: unknown;
}

/** Throws on any tampering, any wrong key, and any malformed input. */
export function open(key: Buffer, b64: string): Opened {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < HEADER + NONCE + TAG) throw new Error('frame too short');
  const header = buf.subarray(0, HEADER);
  if (header[0] !== CRYPTO_VERSION) throw new Error(`unsupported frame version ${header[0]}`);

  const nonce = buf.subarray(HEADER, HEADER + NONCE);
  const tag = buf.subarray(buf.length - TAG);
  const ct = buf.subarray(HEADER + NONCE, buf.length - TAG);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const body = Buffer.concat([decipher.update(ct), decipher.final()]);
  return {
    seq: Number(header.readBigUInt64BE(1)),
    payload: JSON.parse(inflateRawSync(body).toString('utf8')),
  };
}

/** Base64url random, for the source secret and any other bearer token. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 26 characters of Crockford base32, lowercase: the space id the relay routes on. */
export function newSpaceId(): string {
  const lower = '0123456789abcdefghjkmnpqrstvwxyz';
  let out = '';
  for (const b of randomBytes(26)) out += lower[b & 31];
  return out;
}

export function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export { randomBytes };
