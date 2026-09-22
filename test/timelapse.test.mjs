/**
 * The work time-lapse, as pure functions: which hours count as today, and what
 * the replay shows at any moment. The overlay is driven by these, so if they
 * are right the replay starts empty, grows monotonically, and ends on exactly
 * the measured totals.
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
const out = path.join(tmp, 'timelapse.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/shared/timelapse.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
});
const TL = require(out);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
};

// Everything is built from LOCAL hours via real Date objects, so the suite is
// right in whatever zone it runs in, not only UTC+2.
const now = new Date(2026, 8, 22, 15, 40).getTime();
const key = (y, mo, d, h) => new Date(y, mo - 1, d, h).toISOString().slice(0, 13);
const ph = {
  [key(2026, 9, 21, 22)]: { alpha: [5, 999_000, 10] },           // yesterday: must be ignored
  [key(2026, 9, 22, 0)]: { alpha: [3, 1_000, 10] },              // local midnight: today
  [key(2026, 9, 22, 9)]: { alpha: [10, 40_000, 100], bravo: [2, 5_000, 20] },
  [key(2026, 9, 22, 11)]: { charlie: [4, 20_000, 50] },
  [key(2026, 9, 22, 15)]: { alpha: [1, 7_000, 5] },
  [key(2026, 9, 22, 18)]: { alpha: [1, 123_456, 5] },            // after now: must be ignored
};
const label = (k) => k.toUpperCase();

console.log('\ntime-lapse: building today');
const day = TL.buildWorkDay(ph, label, now);
ok('there is a day to replay', !!day);
ok("yesterday's hours and hours after now are left out", day.total === 1_000 + 40_000 + 5_000 + 20_000 + 7_000, String(day.total));
ok('local midnight counts as today', day.tokens[0].alpha === 1_000);
ok('it spans from the first active hour to the current hour', day.fromHour === 0 && day.toHour === 15);
ok('projects light up in the order they started today', day.projects.map((p) => p.label).join() === 'ALPHA,BRAVO,CHARLIE',
   day.projects.map((p) => `${p.label}@${p.firstHour}`).join());
ok('ties on the first hour go to the bigger project', (() => {
  const d = TL.buildWorkDay({ [key(2026, 9, 22, 9)]: { small: [1, 10, 1], big: [1, 99, 1] } }, label, now);
  return d.projects[0].key === 'big';
})());
ok('a day with nothing recorded is null, not an empty replay', TL.buildWorkDay({ [key(2026, 9, 21, 9)]: { a: [1, 1, 1] } }, label, now) === null);
ok('no data at all is null', TL.buildWorkDay(undefined, label, now) === null);
ok('malformed cells are ignored, not counted', (() => {
  const d = TL.buildWorkDay({ [key(2026, 9, 22, 9)]: { a: 'junk', b: [1, 50, 1] }, nonsense: { c: [1, 5, 1] } }, label, now);
  return d && d.total === 50;
})());

console.log('\ntime-lapse: the replay');
const start = TL.replayState(day, 0);
ok('at zero nothing is lit', start.total === 0 && Object.keys(start.perProject).length === 0);
const end = TL.replayState(day, TL.REPLAY_MS);
ok('at the end every project equals its measured total, to the token',
   day.projects.every((p) => end.perProject[p.key] === p.total), JSON.stringify(end.perProject));
ok('and the replay says it is done', end.done && end.total === day.total);
ok('past the end it stays at the end', TL.replayState(day, TL.REPLAY_MS * 3).total === day.total);
let prev = -1, monotonic = true;
for (let ms = 0; ms <= TL.REPLAY_MS; ms += 250) {
  const f = TL.replayState(day, ms);
  if (f.total + 1e-9 < prev) monotonic = false;
  prev = f.total;
}
ok('the running total never goes backwards', monotonic);
const half = TL.replayState(day, TL.REPLAY_MS / 2);
ok('half way through, the clock is half way from the first hour to NOW',
   Math.abs(half.clock - (day.fromHour + (day.endAt - day.fromHour) / 2)) < 1e-9, String(half.clock));

// The clock used to run to the end of the current hour: at 15:40 it read 15:59,
// and the 15:00 bucket was shown filling across twenty minutes that had not
// happened. It now stops at the real time.
ok('the replay ends at the real time of day, not the end of the hour',
   Math.abs(end.clock - (15 + 40 / 60)) < 1e-9, String(end.clock));
ok('and the current hour is complete exactly when the clock reaches now', end.byHour[15] === 7_000);
const early = TL.buildWorkDay({ [key(2026, 9, 22, 9)]: { a: [1, 600, 1] } }, label, new Date(2026, 8, 22, 9, 5).getTime());
const earlyEnd = TL.replayState(early, TL.REPLAY_MS);
ok('five minutes into the first hour, the replay spans five minutes, not an hour',
   Math.abs(early.endAt - (9 + 5 / 60)) < 1e-9 && Math.abs(earlyEnd.clock - early.endAt) < 1e-9 && earlyEnd.total === 600,
   JSON.stringify({ endAt: early.endAt, clock: earlyEnd.clock, total: earlyEnd.total }));
ok('hours still ahead show nothing yet', half.byHour[11] === 0 && half.byHour[15] === 0);
ok('hours behind are shown in full', half.byHour[0] === 1_000);

const stepped = TL.replayState(day, TL.REPLAY_MS * 0.6, TL.REPLAY_MS, 4);
ok('reduced motion quantises time into steps', stepped.t === 0.5, String(stepped.t));
ok('and still ends on the full day', TL.replayState(day, TL.REPLAY_MS, TL.REPLAY_MS, 4).total === day.total);
ok('the hour label', TL.hh(9) === '09:00' && TL.hh(15.7) === '15:00');

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
