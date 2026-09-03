/**
 * The pairing code: the only secret a human ever handles in this feature.
 *
 * Twelve characters of Crockford base32, shown as XXXX-XXXX-XXXX. Sixty bits.
 *
 * Why twelve and not six, and why not twenty. The code is the ONLY thing
 * preventing a malicious relay from standing in the middle of the key exchange:
 * the relay can substitute its own public keys and then try to brute-force the
 * code offline against the first authenticated message. So the code's strength
 * is a real security parameter, not a formality.
 *
 * Sixty bits alone would be uncomfortable against a determined offline attack.
 * It is not used alone: it is stretched with scrypt at N=2^15, r=8, which needs
 * 32 MB and about 100 ms per guess and resists GPUs precisely because of the
 * memory. That puts a full search at roughly 2^60 x 100 ms, which is not a
 * thing that happens. Twelve characters is where the typing stays tolerable and
 * the margin stops mattering.
 *
 * Crockford's alphabet omits I, L, O and U, so the letters people confuse with
 * digits are simply absent, and the reader maps the confusable ones back rather
 * than rejecting them. U is excluded from the alphabet to avoid accidental
 * words.
 */

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 12;
/** Ten minutes. Long enough to walk to the other machine, short enough to matter. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * `randomBytes` must be supplied by the caller so this module stays pure and
 * loadable in the test harness without Node's crypto being bundled into the
 * renderer.
 */
export function generateCode(randomBytes: (n: number) => Uint8Array): string {
  const buf = randomBytes(CODE_LENGTH);
  let out = '';
  // 256 is exactly divisible by 32, so masking is uniform. Rejection sampling
  // would be equivalent here and harder to read.
  for (const b of buf) out += ALPHABET[b & 31];
  return out;
}

/** Group into threes for reading aloud: XXXX-XXXX-XXXX. */
export function formatCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Accept what a person actually types: lowercase, spaces, the wrong dashes, and
 * the letters Crockford exists to forgive. Returns null when the result is not
 * a plausible code, so the caller can say so before troubling the network.
 */
export function normaliseCode(input: string): string | null {
  const cleaned = String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');

  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null;
  return cleaned;
}
