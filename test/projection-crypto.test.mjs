/**
 * Pairing code and projection crypto.
 *
 * These assertions are the security argument, written down as things that fail
 * loudly. The two that matter most:
 *
 *   "a different code derives a different key" is what makes a guessed pairing
 *   code useless even to someone who got onto the socket.
 *
 *   "a substituted key pair does not agree with the source" is what stops a
 *   malicious relay standing in the middle of the exchange.
 *
 *   node test/projection-crypto.test.mjs
 */

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-crypto-'));
const require = createRequire(import.meta.url);

async function load(entry) {
  const out = path.join(tmp, path.basename(entry, '.ts') + '.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'error',
    external: ['electron'],
  });
  return require(out);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`);
  }
};
const threw = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const codes = await load('src/shared/pairing-code.ts');
const cx = await load('src/main/projection/crypto.ts');

console.log('\npairing codes');
{
  const code = codes.generateCode(cx.randomBytes);
  ok('a code is 12 symbols', code.length === codes.CODE_LENGTH && code.length === 12);
  ok('every symbol is in the alphabet', [...code].every((c) => codes.ALPHABET.includes(c)));
  ok('the confusable letters are absent from the alphabet', !/[ILOU]/.test(codes.ALPHABET));
  ok('two codes differ', codes.generateCode(cx.randomBytes) !== codes.generateCode(cx.randomBytes));
  ok('formatting groups in fours', codes.formatCode('ABCDEFGHJKMN') === 'ABCD-EFGH-JKMN');

  ok('lowercase is accepted', codes.normaliseCode(code.toLowerCase()) === code);
  ok('the formatted form round trips', codes.normaliseCode(codes.formatCode(code) + '  ') === code);
  ok('the letter I is read as a one', codes.normaliseCode('I23456789ABC') === '123456789ABC');
  ok('the letter O is read as a zero', codes.normaliseCode('O23456789ABC') === '023456789ABC');
  ok('a short code is rejected, never padded', codes.normaliseCode('ABC') === null);
  ok('U is not in the alphabet and is rejected', codes.normaliseCode('U23456789ABC') === null);
  ok('junk is rejected', codes.normaliseCode('') === null && codes.normaliseCode(null) === null);
}

console.log('\nprojection crypto');
{
  const code = codes.generateCode(cx.randomBytes);
  const lookup = cx.lookupOf(code);

  ok('the relay only ever sees a short one-way digest', lookup.length === 22 && !lookup.includes(code.slice(0, 5)));
  ok('the digest is stable', cx.lookupOf(code) === lookup);
  ok('a different code gives a different digest', cx.lookupOf(codes.generateCode(cx.randomBytes)) !== lookup);

  const src = cx.newKeyPair();
  const scr = cx.newKeyPair();
  const kSrc = cx.deriveScreenKey(src.privateKey, scr.publicKey, code, lookup);
  const kScr = cx.deriveScreenKey(scr.privateKey, src.publicKey, code, lookup);
  ok('both machines derive the same 256-bit key', kSrc.equals(kScr) && kSrc.length === 32);

  // The property that makes a guessed code useless even after connecting.
  const wrongCode = cx.deriveScreenKey(scr.privateKey, src.publicKey, codes.generateCode(cx.randomBytes), lookup);
  ok('a different code derives a different key', !wrongCode.equals(kScr));

  // The property that stops a relay standing in the middle: substituting its
  // own key gives it a key the source is not using.
  const mitm = cx.newKeyPair();
  const kMitm = cx.deriveScreenKey(mitm.privateKey, src.publicKey, code, lookup);
  ok('a substituted key pair does not agree with the source', !kMitm.equals(kSrc));

  const payload = { totals: { requests: 42 }, note: 'from the source' };
  const sealed = cx.seal(kSrc, 1000, payload);
  const opened = cx.open(kScr, sealed);
  ok('a sealed frame opens to the same payload', JSON.stringify(opened.payload) === JSON.stringify(payload));
  ok('the sequence number survives', opened.seq === 1000);

  ok('the wrong key cannot open it', threw(() => cx.open(cx.randomBytes(32), sealed)));

  const bytes = Buffer.from(sealed, 'base64');
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 20] ^= 0xff;
  ok('a flipped ciphertext byte fails the tag', threw(() => cx.open(kScr, flipped.toString('base64'))));

  const reseq = Buffer.from(bytes);
  reseq.writeBigUInt64BE(9999n, 1);
  ok('editing the sequence number fails the tag, because it is in the AAD',
     threw(() => cx.open(kScr, reseq.toString('base64'))));

  const badver = Buffer.from(bytes);
  badver[0] = 9;
  ok('an unknown frame version is refused, not guessed at', threw(() => cx.open(kScr, badver.toString('base64'))));
  ok('a truncated frame is rejected, not misread', threw(() => cx.open(kScr, 'AAAA')));

  // Compression is what makes a snapshot affordable every ten seconds.
  const big = {
    daily: Object.fromEntries(
      [...Array(400)].map((_, i) => [String(i), { input: i, output: i * 2, requests: i, cacheRead: i * 7 }]),
    ),
  };
  const sealedBig = cx.seal(kSrc, 2, big);
  const rawSize = JSON.stringify(big).length;
  ok('deflate makes a real dent before encryption', sealedBig.length < rawSize * 0.5,
     `json ${rawSize}B -> frame ${sealedBig.length}B`);
  console.log(`        (${rawSize} B of JSON became a ${sealedBig.length} B frame)`);

  ok('space ids are 26 Crockford characters', /^[0-9a-hjkmnp-tv-z]{26}$/.test(cx.newSpaceId()));
  ok('space ids differ', cx.newSpaceId() !== cx.newSpaceId());
  ok('secrets differ every time', cx.newSecret() !== cx.newSecret());
  ok('secret comparison is exact', cx.sameSecret('abc', 'abc') && !cx.sameSecret('abc', 'abd'));
  ok('secret comparison handles different lengths', !cx.sameSecret('abc', 'abcd'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
