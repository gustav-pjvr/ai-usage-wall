/**
 * Five-minute detail for any day (src/shared/intraday.ts): which slot and which
 * day a record lands in, how a day is summed across live and archived
 * transcripts, and which days the picker offers.
 *
 * Runs in a UTC+2 zone on purpose, set before anything reads the clock, so the
 * local day and the UTC day disagree for two hours every night. A record at
 * 00:30 local is the previous UTC date; slicing the timestamp would file it
 * under the wrong day, and the first check here fails if anyone does.
 *
 *   node test/intraday.test.mjs
 */
process.env.TZ = 'Africa/Johannesburg';

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mbw-intraday-'));
const require = createRequire(import.meta.url);
const out = path.join(tmp, 'intraday.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/shared/intraday.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
});
const I = require(out);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
};

console.log('\nslots and days');
const at = (h, m) => new Date(2026, 8, 22, h, m).getTime();
ok('the suite really is two hours ahead of UTC', new Date(at(12, 0)).getTimezoneOffset() === -120,
   String(new Date(at(12, 0)).getTimezoneOffset()));
ok('00:00 local is slot 0', I.bucketOf(at(0, 0)) === 0);
ok('23:59 local is slot 287, the last', I.bucketOf(at(23, 59)) === 287 && I.BUCKETS_PER_DAY === 288);
ok('09:04 is slot 108 and 09:05 is 109', I.bucketOf(at(9, 4)) === 108 && I.bucketOf(at(9, 5)) === 109);
ok('00:30 local on a UTC+2 machine belongs to the LOCAL day',
   I.offeredDays({}, {}, {}, at(0, 30)).today === '2026-09-22' && new Date(at(0, 30)).toISOString().slice(0, 10) === '2026-09-21');

console.log('\nfolding');
{
  const into = {};
  I.foldIntraday(into, '2026-09-22', 'c:\\a', 108, [1, 100, 10]);
  I.foldIntraday(into, '2026-09-22', 'c:\\a', 108, [1, 50, 5]);
  I.foldIntraday(into, '2026-09-22', 'c:\\b', 108, [1, 7, 1]);
  ok('two records in one slot of one project add up', JSON.stringify(into['2026-09-22']['c:\\a']['108']) === '[2,150,15]');
  ok('another project in the same slot is kept apart', JSON.stringify(into['2026-09-22']['c:\\b']['108']) === '[1,7,1]');
}

console.log('\nsumming a day across live and archived transcripts');
const contrib = (cells, display = 'C:\\Work\\Alpha', key = 'c:\\work\\alpha') => ({
  contrib: { intraday: { '2026-09-22': { [key]: cells } }, projects: { [key]: { display } } },
});
{
  const live = { 'a.jsonl': contrib({ 100: [2, 1000, 50] }) };
  const archived = { 'gone.jsonl': contrib({ 100: [1, 500, 20], 200: [3, 30, 3] }) };
  const raw = I.collectDay('2026-09-22', live, archived, 6, 123);
  const cells = raw.projects['c:\\work\\alpha'].cells;
  ok('a live and an archived transcript sum into one slot', JSON.stringify(cells['100']) === '[3,1500,70]', JSON.stringify(cells));
  ok('and the archived-only slot is there', JSON.stringify(cells['200']) === '[3,30,3]');
  ok('the display path comes with it, for the label', raw.projects['c:\\work\\alpha'].display === 'C:\\Work\\Alpha');
  ok('shaped requests count every cell', raw.shapedRequests === 6 && raw.requests === 6);
  let threw = false;
  try { I.collectDay('2026-09-22', live, { 'a.jsonl': contrib({}) }, 0, 0); } catch { threw = true; }
  ok('a path that is both live and archived throws: that would count it twice', threw);
  const old = { 'old.jsonl': { contrib: { projects: {} } } };
  const partial = I.collectDay('2026-09-22', live, old, 5, 0);
  ok('a contribution without intraday counts in requests but not in shaped',
     partial.requests === 5 && partial.shapedRequests === 2, JSON.stringify([partial.requests, partial.shapedRequests]));
  const junk = I.collectDay('2026-09-22', { j: contrib({ 999: [1, 1, 1], x: [1, 1, 1], 5: 'no', 6: [1, -1, 0] }) }, {}, 1, 0);
  ok('slots out of range and malformed cells are ignored, not counted', junk.shapedRequests === 0);
  ok('another day is not read', I.collectDay('2026-09-21', live, archived, 0, 0).shapedRequests === 0);
}

console.log('\nwhich days the picker offers');
{
  const live = { 'a.jsonl': contrib({ 100: [4, 1000, 50] }) };
  const activeDays = { '2026-09-22': 4, '2026-09-20': 5, '2026-07-15': 30, bogus: 3, '2026-07-16': 0 };
  // 09-20: 3 of 5 shaped (2 archived before minute detail existed).
  const archived = { 'b.jsonl': { contrib: { intraday: { '2026-09-20': { '': { 10: [3, 9, 1] } }, '2030-01-01': { '': { 1: [1, 1, 1] } } } } } };
  const offered = I.offeredDays(activeDays, live, archived, at(12, 0));
  ok('every shaped request counted: full', I.dayShape(offered.days['2026-09-22']) === 'full');
  ok('some shaped: partial', I.dayShape(offered.days['2026-09-20']) === 'partial' && offered.days['2026-09-20'].shaped === 3);
  ok('none shaped (the reconstructed seed days): total', I.dayShape(offered.days['2026-07-15']) === 'total');
  ok('never a day absent from activeDays, even with cells', !('2030-01-01' in offered.days));
  ok('and never a malformed or empty day', !('bogus' in offered.days) && !('2026-07-16' in offered.days));
  ok('a day with nothing is none', I.dayShape(undefined) === 'none');
  ok('today is the local day', offered.today === '2026-09-22');
}

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
