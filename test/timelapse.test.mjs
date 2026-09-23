/**
 * The time-lapse, as pure functions (src/shared/timelapse.ts): the axis a day
 * gets, and what the replay shows at any moment. The overlay is driven by
 * these, so if they are right the replay starts empty, never goes backwards,
 * stops at now on today, and ends on exactly the measured totals.
 *
 * Runs in Europe/London, set before anything reads the clock, so one check can
 * land on a daylight saving day. Every other fixture is built from local Date
 * objects, so it holds in any zone.
 *
 *   node test/timelapse.test.mjs
 */
process.env.TZ = 'Europe/London';
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

// Everything is local time through real Date objects, so the suite is right in
// whatever zone it runs in.
const slot = (h, m) => (h * 60 + m) / 5;
const raw = (day, projects, requests, shaped) => ({
  day, asOf: 0, bucketMinutes: 5, projects, requests,
  shapedRequests: shaped ?? Object.values(projects).reduce((n, p) => n + Object.values(p.cells).reduce((a, c) => a + c[0], 0), 0),
});
const label = (key) => (key ? key.toUpperCase() : null);

// A finished day: work from 09:10 to 16:50 across three projects, one clear peak.
const past = raw('2026-09-10', {
  alpha: { display: 'C:\\x\\alpha', cells: { [slot(9, 10)]: [3, 10_000, 100], [slot(14, 35)]: [9, 900_000, 800], [slot(16, 50)]: [1, 5_000, 50] } },
  bravo: { display: 'C:\\x\\bravo', cells: { [slot(14, 35)]: [20, 40_000, 400], [slot(11, 0)]: [2, 2_000, 20] } },
  '': { display: '', cells: { [slot(12, 0)]: [1, 700, 7] } },
});
const pastSum = { tokens: 10_000 + 900_000 + 5_000 + 40_000 + 2_000 + 700, output: 100 + 800 + 50 + 400 + 20 + 7, requests: 3 + 9 + 1 + 20 + 2 + 1 };
const later = new Date(2026, 8, 23, 12, 0).getTime();

console.log('\nthe axis');
const s = TL.buildDaySeries(past, label, later);
ok('there is a day to draw', !!s);
ok('it starts on the hour before the first record and ends on the hour after the last',
   s.fromMinute === 9 * 60 && s.toMinute === 17 * 60, `${s.fromMinute} to ${s.toMinute}`);
ok('a finished day plays to the end of its axis', s.endMinute === s.toMinute && !s.today);
const short = TL.buildDaySeries(raw('2026-09-10', { a: { display: '', cells: { [slot(10, 20)]: [1, 5, 1] } } }), label, later);
ok('a day of a few minutes still gets two hours of axis', short.toMinute - short.fromMinute === 120 && short.fromMinute === 600);
const late = TL.buildDaySeries(raw('2026-09-10', { a: { display: '', cells: { [slot(23, 55)]: [1, 5, 1] } } }), label, later);
ok('and the two hours never run past midnight', late.toMinute === 1440 && late.fromMinute === 1320, `${late.fromMinute} to ${late.toMinute}`);
ok('a day with no cells is null, not an empty graph', TL.buildDaySeries(raw('2026-07-15', {}, 30, 0), label, later) === null);

console.log('\nthe series');
ok('three series of 288 slots', s.tokens.length === 288 && s.output.length === 288 && s.requests.length === 288);
ok('the day totals are the sum of every cell', JSON.stringify(s.totals) === JSON.stringify(pastSum), JSON.stringify(s.totals));
ok('the peak is the slot with the most tokens, with its time and project',
   s.peak.bucket === slot(14, 35) && s.peak.tokens === 940_000 && s.peak.label === 'ALPHA', JSON.stringify(s.peak));
ok('"on" is the busiest project in each slot', s.onProject[slot(14, 35)] === 'ALPHA' && s.onProject[slot(11, 0)] === 'BRAVO');
ok('a slot of records with no project has a blank label', s.onProject[slot(12, 0)] === null && s.tokens[slot(12, 0)] === 700);
ok('an empty slot has no project', s.onProject[slot(13, 0)] === null);
ok('each lane has its own fixed scale', s.peaks.tokens === 940_000 && s.peaks.output === 1_200 && s.peaks.requests === 29);
const withMissing = TL.buildDaySeries({ ...past, requests: past.shapedRequests + 15 }, label, later);
ok('requests with no minute detail are counted as missing, and kept out of the curve',
   withMissing.missingRequests === 15 && withMissing.totals.requests === pastSum.requests);

console.log('\nthe replay');
const at0 = TL.replayFrame(s, 0);
const atLead = TL.replayFrame(s, TL.LEAD_MS);
ok('during the lead nothing is revealed and the clock sits at the axis start',
   at0.totals.tokens === 0 && atLead.totals.tokens === 0 && atLead.minute === s.fromMinute && at0.t === 0);
ok('and nothing is "on" yet', atLead.onProject === null);
let prev = { tokens: -1, output: -1, requests: -1 }, monotonic = true;
const hardStop = TL.replayLength(false);
// 50 ms is under a minute of this day per step, so several frames land inside
// each five-minute slot and the partial-slot fill is what is being checked.
for (let ms = 0; ms <= hardStop; ms += 50) {
  const f = TL.replayFrame(s, ms);
  for (const k of ['tokens', 'output', 'requests']) if (f.totals[k] + 1e-9 < prev[k]) monotonic = false;
  prev = f.totals;
}
ok('the running totals never go backwards, all the way to the hard stop', monotonic);
const end = TL.replayFrame(s, TL.LEAD_MS + TL.SWEEP_MS);
ok('at the end the totals equal the measured day, to the token',
   JSON.stringify(end.totals) === JSON.stringify(pastSum) && end.done, JSON.stringify(end.totals));
ok('past the end it stays at the end', JSON.stringify(TL.replayFrame(s, hardStop * 3).totals) === JSON.stringify(pastSum));
ok('the hard stop is lead + sweep + hold', hardStop === TL.LEAD_MS + TL.SWEEP_MS + TL.HOLD_MS && hardStop === 23_200);
const half = TL.replayFrame(s, TL.LEAD_MS + TL.SWEEP_MS / 2);
ok('half way through the sweep the playhead is half way across the axis', Math.abs(half.minute - 13 * 60) < 1e-9, String(half.minute));
ok('half way: what is behind is whole, what is ahead is nothing',
   half.totals.tokens === 10_000 + 2_000 + 700 && !half.peakShown, JSON.stringify(half.totals));
const beforePeak = TL.replayFrame(s, TL.LEAD_MS + TL.SWEEP_MS * ((14 * 60 + 36 - 540) / 480));
ok('inside the peak slot, it is counted by the share of it shown', beforePeak.revealed === slot(14, 35) &&
   Math.abs(beforePeak.frac - 0.2) < 1e-9 && Math.abs(beforePeak.totals.tokens - (12_700 + 940_000 * 0.2)) < 1e-6,
   JSON.stringify(beforePeak));
ok('the peak is marked once the playhead has passed it', !beforePeak.peakShown &&
   TL.replayFrame(s, TL.LEAD_MS + TL.SWEEP_MS * ((14 * 60 + 41 - 540) / 480)).peakShown);
ok('"on" follows the playhead', beforePeak.onProject === 'ALPHA');
const reduced = TL.replayFrame(s, 0, true);
ok('reduced motion: the complete day at 0 ms, no sweep, no "on"',
   JSON.stringify(reduced.totals) === JSON.stringify(pastSum) && reduced.peakShown && reduced.onProject === null && reduced.done);
ok('and it is held 10 seconds', TL.replayLength(true) === 10_000);

console.log('\ntoday stops at now');
{
  const now = new Date(2026, 8, 22, 9, 4, 0).getTime();
  const today = raw('2026-09-22', {
    a: { display: '', cells: { [slot(7, 30)]: [2, 400, 4], [slot(9, 0)]: [5, 600, 6] } },
    // A slot that starts after now: a clock skew, not a spike.
    b: { display: '', cells: { [slot(11, 0)]: [1, 999_999, 9] } },
  });
  const t = TL.buildDaySeries(today, label, now);
  ok('today is today', t.today);
  ok('the axis runs to the next hour after now', t.fromMinute === 7 * 60 && t.toMinute === 10 * 60, `${t.fromMinute} to ${t.toMinute}`);
  ok('the playhead stops at now, not at the axis end', Math.abs(t.endMinute - (9 * 60 + 4)) < 1e-9, String(t.endMinute));
  ok('a slot after now is not counted', t.totals.tokens === 1_000 && t.tokens[slot(11, 0)] === 0, String(t.totals.tokens));
  const e = TL.replayFrame(t, TL.LEAD_MS + TL.SWEEP_MS);
  ok('the current slot is complete exactly when the playhead reaches now', e.totals.tokens === 1_000 && e.totals.requests === 7,
     JSON.stringify(e.totals));
  const mid = TL.replayFrame(t, TL.LEAD_MS + TL.SWEEP_MS * ((9 * 60 + 2 - 420) / (t.endMinute - 420)));
  ok('half way through the current slot is half of the part that has passed',
     Math.abs(mid.frac - 0.5) < 1e-9 && Math.abs(mid.totals.tokens - (400 + 300)) < 1e-6, JSON.stringify(mid));
  const first = TL.buildDaySeries(raw('2026-09-22', { a: { display: '', cells: { [slot(9, 0)]: [1, 5, 1] } } }), label, new Date(2026, 8, 22, 9, 0, 0).getTime());
  ok('the first record of the day, at the very minute, is still drawn', !!first && first.endMinute > first.fromMinute);
}

console.log('\ndaylight saving and midnight');
{
  // 2026-03-29: London's clocks jump from 01:00 to 02:00. At 10:30 on the wall
  // clock only 9.5 hours have elapsed since midnight; the playhead must still
  // stop at 10:30, where the slots are filed, not an hour short of them.
  const now = new Date(2026, 2, 29, 10, 30).getTime();
  ok('the suite really is on a daylight saving day', new Date(2026, 2, 29, 0, 30).getTimezoneOffset() !== new Date(now).getTimezoneOffset());
  const t = TL.buildDaySeries(raw('2026-03-29', { a: { display: '', cells: { [slot(9, 0)]: [1, 100, 1], [slot(10, 25)]: [2, 500, 5] } } }), label, now);
  ok('on a daylight saving day today still stops at the wall-clock now', Math.abs(t.endMinute - 630) < 1e-9, String(t.endMinute));
  ok('and keeps the slots of the last hour', t.totals.tokens === 600, String(t.totals.tokens));
  const lateEnd = TL.replayFrame(late, TL.LEAD_MS + TL.SWEEP_MS);
  ok('a day with work in the last slot ends at 24:00 with every token counted',
     late.endMinute === 1440 && lateEnd.revealed === 288 && lateEnd.totals.tokens === 5 && lateEnd.totals.requests === 1, JSON.stringify(lateEnd));
}

ok('clock text', TL.hhmm(545) === '09:05' && TL.hhmm(0) === '00:00' && TL.hhmm(1439) === '23:59' && TL.hhmm(1440) === '24:00');

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
