/**
 * The projection status pill: the one line on a SCREEN that says whose numbers
 * these are and how old they are. Every phase must produce wording that states
 * the truth of that phase, and the ages must be read off the clock rather than
 * off a snapshot, so the mapping is tested here as a pure function.
 */
import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mbw-test-'));
const require = createRequire(import.meta.url);

async function load(entry) {
  const out = path.join(tmp, path.basename(entry, '.ts') + '.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
  });
  return require(out);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
};

const { projectionPill, cleanLabel } = await load('src/renderer/stats.ts');

const now = Date.now();
const screen = (phase, extra = {}) => ({
  role: 'screen', phase, sourceLabel: 'Gustav-PC', ageMs: null, lastAt: null, ...extra,
});

console.log('\nprojection pill');

ok('off produces no pill', projectionPill({ role: 'off' }, null, now) === null);

// Source role.
const src = (phase, screens, extra = {}) => ({
  role: 'source', phase, screens, pairing: null, lastSentAt: null, lastFrameBytes: null, ...extra,
});
let p = projectionPill(src('open', []), null, now);
ok('source with no screens says so', p.text === 'PROJECTING · no screens paired' && p.tone === 'live', p.text);
p = projectionPill(src('open', [{ online: true }, { online: false }, { online: true }]), null, now);
ok('source counts online of paired', p.text === 'PROJECTING · 2 of 3 screens' && p.tone === 'live', p.text);
p = projectionPill(src('open', [{ online: true }]), null, now);
ok('source singular screen', p.text === 'PROJECTING · 1 of 1 screen', p.text);
p = projectionPill(src('closed', [], { retryIn: 12 }), now + 12_000, now);
ok('source relay down is amber with a countdown', p.text === 'PROJECTING · relay unreachable, retrying in 12s' && p.tone === 'warn', p.text);
p = projectionPill(src('closed', [], { retryIn: 12 }), now + 12_000, now + 7_000);
ok('countdown is read off the clock, not the snapshot', p.text.endsWith('retrying in 5s'), p.text);
p = projectionPill(src('closed', []), now + 12_000, now + 20_000);
ok('a countdown that has elapsed says now, not a negative', p.text.endsWith('retrying now'), p.text);
p = projectionPill(src('connecting', []), null, now);
ok('source still connecting is muted, not an outage', p.tone === 'muted', p.text);

// Screen role.
p = projectionPill(screen('live', { lastAt: now - 5_000, ageMs: 5_000 }), null, now);
ok('live names the source in the signal tone', p.text === 'LIVE from Gustav-PC' && p.tone === 'live', p.text);
p = projectionPill(screen('link-lost', { lastAt: now - 2 * 60_000, ageMs: 2 * 60_000 }), null, now);
ok('link lost carries the age', p.text === 'LINK LOST · last heard 2m ago' && p.tone === 'warn', p.text);
const at = new Date(now - 10 * 60_000);
const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
p = projectionPill(screen('offline', { lastAt: at.getTime(), ageMs: 10 * 60_000 }), null, now);
ok('offline carries a local wall-clock', p.text === `Gustav-PC OFFLINE · data as of ${hhmm}` && p.tone === 'warn', p.text);
p = projectionPill(screen('relay-unreachable', { lastAt: now - 60_000, retryIn: 20 }), now + 20_000, now);
ok('relay unreachable is amber with a countdown', p.text === 'RELAY UNREACHABLE · retrying in 20s' && p.tone === 'warn', p.text);
p = projectionPill(screen('connecting'), null, now);
ok('connecting is muted', p.text === 'CONNECTING...' && p.tone === 'muted', p.text);
p = projectionPill(screen('revoked'), null, now);
ok('revoked is the failure tone', p.text === 'REMOVED BY THE SOURCE' && p.tone === 'bad', p.text);
p = projectionPill(screen('space-closed'), null, now);
ok('space closed is the failure tone', p.text === 'SOURCE STOPPED PROJECTING' && p.tone === 'bad', p.text);
p = projectionPill(screen('key-mismatch'), null, now);
ok('key mismatch says to pair again', p.text === 'CANNOT DECRYPT · pair again' && p.tone === 'bad', p.text);

// The strip uppercases everything else; the pill must not, or the source name
// and the lower-case explanations would be shouted. Check the wording carries
// the case it intends.
p = projectionPill(screen('live', { lastAt: now }), null, now);
ok('mixed case survives in the wording', /LIVE from/.test(p.text), p.text);

// The label is typed on another machine. Markup is already inert through
// textContent; what is filtered here is the text-direction and invisible
// characters that let a hostile label rewrite the sentence around it.
console.log('\nsource label cleaning');
ok('a plain label passes through', cleanLabel('Gustav-PC') === 'Gustav-PC');
ok('a bidi override is dropped', cleanLabel('\u202ECP-vatsuG') === 'CP-vatsuG', JSON.stringify(cleanLabel('\u202ECP-vatsuG')));
ok('zero-width characters are dropped', cleanLabel('Gus\u200Btav\u2060-PC\uFEFF') === 'Gustav-PC');
ok('control characters are dropped', cleanLabel('Gustav\u0000-PC\n') === 'Gustav-PC');
ok('an all-invisible label falls back to a name', cleanLabel('\u202E\u200B') === 'the source machine');
ok('ordinary unicode survives', cleanLabel('B\u00FCro-Rechner \u00E9') === 'B\u00FCro-Rechner \u00E9');

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
