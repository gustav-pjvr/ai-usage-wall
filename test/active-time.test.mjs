/**
 * Hours Claude has run (src/shared/active-time.ts): how responses join into
 * stretches of work, how every transcript's stretches merge, and how the
 * number is written. The definition was checked against Claude Code's own
 * turn_duration records on 2026-10-10 (196.9 hours against 199.9 over the
 * period they cover); this pins the arithmetic it relies on.
 *
 *   node test/active-time.test.mjs
 */
import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mbw-active-'));
const require = createRequire(import.meta.url);
const out = path.join(tmp, 'active.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/shared/active-time.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
});
const A = require(out);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
};

const T0 = Date.parse('2026-10-01T09:00:00Z');
const min = (m) => T0 + m * 60_000;
const fold = (...minutes) => {
  const a = { last: 0, spans: [] };
  for (const m of minutes) A.foldActive(a, min(m));
  return a;
};
const secs = (a) => A.activeTime({ f: { contrib: { active: a } } }).seconds;

console.log('\nresponses into stretches');
ok('one response alone is no time at all', secs(fold(0)) === 0);
ok('responses a minute apart join: 0, 1, 2, 3 is three minutes', secs(fold(0, 1, 2, 3)) === 180);
ok('exactly five minutes apart still joins', secs(fold(0, 5)) === 300);
ok('more than five minutes apart does not: a pause counts nothing', secs(fold(0, 5.02)) === 0);
ok('a break splits the day into two stretches', (() => {
  const a = fold(0, 2, 4, 30, 31);
  return a.spans.length === 2 && secs(a) === 240 + 60;
})(), JSON.stringify(fold(0, 2, 4, 30, 31).spans));
ok('a stretch continues across two refreshes (the appended chunk)', (() => {
  const a = fold(0, 2);
  A.foldActive(a, min(4));
  return a.spans.length === 1 && secs(a) === 240;
})());
ok('a response earlier than the last one starts nothing', (() => {
  const a = fold(0, 4);
  A.foldActive(a, min(1));
  return secs(a) === 240 && a.last === Math.floor(min(4) / 1000);
})());
ok('a record with no time is ignored', (() => {
  const a = fold(0, 1);
  A.foldActive(a, NaN);
  return secs(a) === 60;
})());

console.log('\nevery transcript together');
{
  // Two sessions side by side from 0 to 10, one more from 20 to 25, and a
  // subagent inside the first: three transcripts, 15 distinct minutes.
  const s1 = fold(0, 2, 4, 6, 8, 10);
  const s2 = fold(1, 3, 5, 7, 9);
  const sub = fold(3, 4);
  const s3 = fold(20, 25);
  const t = A.activeTime({ a: { contrib: { active: s1 } }, b: { contrib: { active: s2 } }, c: { contrib: { active: sub } } },
    { d: { contrib: { active: s3 } } });
  ok('parallel sessions count an hour once, not twice', t.seconds === 15 * 60, String(t.seconds));
  ok('archived transcripts count too (a deleted transcript keeps its hours)',
     A.activeTime({}, { d: { contrib: { active: s3 } } }).seconds === 300);
  ok('since is the first stretch', t.since === T0);
  ok('nothing at all is zero, since unknown', JSON.stringify(A.activeTime({})) === JSON.stringify({ seconds: 0, since: null }));
  ok('a contribution from before hours were measured adds nothing and breaks nothing',
     A.activeTime({ old: { contrib: { totals: {} } }, nul: { contrib: null } }).seconds === 0);
  ok('malformed spans are skipped', A.activeTime({ x: { contrib: { active: { last: 0, spans: [[5, 1], ['a', 9], [1, 61], null] } } } }).seconds === 60);
}

console.log('\nthe number');
ok('whole hours with separators', A.formatHours(12_840 * 3600 + 3599) === '12,840');
ok('never rounded up', A.formatHours(3599) === '0' && A.formatHours(7199) === '1');
ok('never turned into days: 100,000 hours is still hours', A.formatHours(100_000 * 3600) === '100,000');
ok('nothing is 0', A.formatHours(0) === '0' && A.formatHours(NaN) === '0' && A.formatHours(-5) === '0');

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
