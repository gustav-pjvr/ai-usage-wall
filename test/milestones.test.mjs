/**
 * Milestones: the rules that decide what is announced, as pure functions.
 *
 * The failure this guards against is not a wrong number, it is a wrong
 * ANNOUNCEMENT, which cannot be taken back: a badge lit for history that was
 * already there, a record announced on every refresh while a session runs, or
 * a threshold "crossed" by a half-built index.
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
const out = path.join(tmp, 'milestones.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/shared/milestones.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
});
const M = require(out);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
};

const T0 = Date.parse('2026-09-22T10:00:00Z');
const input = (over = {}) => ({
  processed: 39.1e9, generated: 103e6, requests: 110_000,
  models: ['claude-opus-5', 'claude-sonnet-5', '<synthetic>', 'unknown'],
  activeDays: ['2026-09-20', '2026-09-21', '2026-09-22'],
  sessions: [{ id: 'a', requests: 900, output: 5e6 }, { id: 'b', requests: 300, output: 9e6 }],
  ...over,
});

console.log('\nmilestones: the first evaluation seeds silently');
const first = M.evaluate(input(), null, T0);
ok('nothing is announced on the first run', first.fresh.length === 0 && first.ledger.unseen.length === 0);
ok('everything already crossed is written down', !!first.ledger.achieved['processed:25B'] && !!first.ledger.achieved['requests:100K']);
ok('and marked seeded, so the list can say "earlier" instead of inventing a date',
   Object.values(first.ledger.achieved).every((a) => a.seeded));
ok('the first run is a change the caller must save', first.changed);
ok('<synthetic> and unknown are not models', !first.ledger.achieved['model:<synthetic>'] && !first.ledger.achieved['model:unknown']);
ok('thresholds not yet crossed are absent', !first.ledger.achieved['processed:50B']);

console.log('\nmilestones: crossing a threshold');
const again = M.evaluate(input(), first.ledger, T0 + 1000);
ok('the same data announces nothing and changes nothing', again.fresh.length === 0 && !again.changed);

const crossed = M.evaluate(input({ processed: 50.2e9 }), first.ledger, T0 + 2000);
ok('crossing 50B announces exactly one', crossed.fresh.length === 1 && crossed.fresh[0].key === 'processed:50B',
   JSON.stringify(crossed.fresh.map((f) => f.key)));
ok('it goes on the badge', crossed.ledger.unseen.includes('processed:50B'));
ok('it is dated now and not seeded', crossed.ledger.achieved['processed:50B'].at === new Date(T0 + 2000).toISOString() &&
   !crossed.ledger.achieved['processed:50B'].seeded);
ok('the title prints the round figure', crossed.fresh[0].title === '50B tokens processed');
ok('evaluating again does not announce it twice', M.evaluate(input({ processed: 51e9 }), crossed.ledger, T0 + 3000).fresh.length === 0);

const jump = M.evaluate(input({ processed: 120e9 }), first.ledger, T0 + 2000);
ok('a jump across two rungs announces both', jump.fresh.filter((f) => f.key.startsWith('processed:')).length === 2,
   JSON.stringify(jump.fresh.map((f) => f.key)));

const lower = M.evaluate(input({ processed: 1e9 }), crossed.ledger, T0 + 4000);
ok('a smaller total after a rebuild takes nothing back and announces nothing', lower.fresh.length === 0 &&
   !!lower.ledger.achieved['processed:50B']);

console.log('\nmilestones: new models');
const newModel = M.evaluate(input({ models: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1'] }), first.ledger, T0 + 5000);
ok('a model not seen before is announced once', newModel.fresh.length === 1 && newModel.fresh[0].key === 'model:claude-fable-5-1');
ok('and names the model', newModel.fresh[0].title === 'First use of claude-fable-5-1');

console.log('\nmilestones: streaks count local days');
const streakDays = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(2026, 7, 25 + i);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
ok('thirty consecutive days across a month end is a 30 day run', M.longestStreak(streakDays) === 30);
const streak = M.evaluate(input({ activeDays: streakDays }), first.ledger, T0 + 6000);
ok('it announces 7, 14 and 30', ['streak:7', 'streak:14', 'streak:30'].every((k) => streak.fresh.some((f) => f.key === k)),
   JSON.stringify(streak.fresh.map((f) => f.key)));
ok('a gap breaks the run', M.longestStreak(['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05']) === 2);

console.log('\nmilestones: session records');
ok('seeding records the holder without announcing', first.ledger.achieved['record:sessionRequests']?.holder === 'a' &&
   first.fresh.length === 0);
const grows = M.evaluate(input({ sessions: [{ id: 'a', requests: 1500, output: 5e6 }, { id: 'b', requests: 300, output: 9e6 }] }),
  first.ledger, T0 + 7000);
ok('the SAME session growing its record updates quietly', grows.fresh.length === 0 &&
   grows.ledger.achieved['record:sessionRequests'].value === 1500);
ok('and keeps the original date', grows.ledger.achieved['record:sessionRequests'].at === first.ledger.achieved['record:sessionRequests'].at);
const taken = M.evaluate(input({ sessions: [{ id: 'a', requests: 900, output: 5e6 }, { id: 'c', requests: 2000, output: 1e6 }] }),
  first.ledger, T0 + 8000);
ok('a DIFFERENT session taking it is announced', taken.fresh.length === 1 && taken.fresh[0].key === 'record:sessionRequests' &&
   taken.ledger.achieved['record:sessionRequests'].holder === 'c');
ok('and the title reads the new figure', taken.fresh[0].title === 'Biggest session: 2,000 requests', taken.fresh[0].title);

console.log('\nmilestones: next up');
const next = M.nextUps(input());
const byTitle = Object.fromEntries(next.map((n) => [n.title, n]));
ok('the next processed rung is 50B', !!byTitle['50B tokens processed'], JSON.stringify(next.map((n) => n.title)));
ok('with how far along and how far to go', byTitle['50B tokens processed'].remaining === '10.9B to go' &&
   Math.abs(byTitle['50B tokens processed'].progress - (39.1 - 25) / 25) < 1e-9, JSON.stringify(byTitle['50B tokens processed']));
ok('a finished ladder offers nothing', !M.nextUps(input({ requests: 5e6 })).some((n) => n.title.endsWith('requests')));
ok('the round-figure formatter', M.short(1e12) === '1T' && M.short(250e6) === '250M' && M.short(10e3) === '10K');

console.log('\nmilestones: the list');
const listed = M.listAchieved(crossed.ledger);
ok('newest first', listed[0].key === 'processed:50B');
ok('an absent ledger lists nothing', M.listAchieved(null).length === 0);
ok('nothing about money anywhere', !JSON.stringify(crossed.ledger).match(/\$|cost|usd/i));

console.log('\nmilestones: the ledger on disk');
{
  /*
   * The main-process half: loading, gating and what the renderer is given.
   * Each process import gets a fresh copy of the module so the ledger state
   * inside one check cannot leak into the next.
   */
  let n = 0;
  const fresh = async () => {
    const o = path.join(tmp, `ledger${n++}.cjs`);
    await esbuild.build({
      entryPoints: [path.join(root, 'src/main/data/milestones.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: o, logLevel: 'silent',
    });
    return require(o);
  };
  const usage = (over = {}) => ({
    totals: { input: 0, output: 103e6, cacheCreate: 0, cacheRead: 39e9, requests: 110_000 },
    models: { 'claude-opus-5': {} }, sessions: {}, activeDays: { '2026-09-22': 5 },
    unavailable: false, ...over,
  });
  const dir = await fs.mkdtemp(path.join(tmp, 'ud-'));
  const real = { v: 1, seededAt: '2026-01-01T00:00:00.000Z', unseen: ['processed:25B'],
    achieved: { 'processed:25B': { key: 'processed:25B', title: '25B tokens processed', sub: '', at: '2026-03-01T00:00:00.000Z', seeded: false } } };

  // A ledger that exists but cannot be read (a directory stands in for a file
  // held by a scanner: any non-ENOENT error) must not be treated as missing.
  await fs.mkdir(path.join(dir, 'milestones.json'));
  let L = await fresh();
  await L.loadMilestones(dir);
  const announced = await L.evaluateMilestones(usage(), true);
  const stillDir = (await fs.stat(path.join(dir, 'milestones.json'))).isDirectory();
  ok('an unreadable ledger is not reseeded over: nothing evaluated, nothing written', announced === 0 && stillDir);
  ok('and the renderer is given nothing rather than a fresh empty ledger', L.milestonesForRenderer(usage(), false) === null);

  // The read is retried on the next scan, and a readable file is then used as is.
  await fs.rmdir(path.join(dir, 'milestones.json'));
  await fs.writeFile(path.join(dir, 'milestones.json'), JSON.stringify(real), 'utf8');
  await L.evaluateMilestones(usage(), true);
  const view = L.milestonesForRenderer(usage(), false);
  ok('the next scan retries the read and keeps the real dates and badge',
     view && view.unseen.includes('processed:25B') && view.achieved.some((a) => a.at === '2026-03-01T00:00:00.000Z'),
     JSON.stringify(view));
  ok('the session id holding a record never reaches the renderer', !JSON.stringify(view).includes('holder'));

  // "Next up" is withheld while the index is partial, not computed from it.
  L = await fresh();
  await L.loadMilestones(dir);
  const reading = L.milestonesForRenderer(usage({ totals: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, requests: 0 } }), true);
  ok('while indexing, next up is empty and the list says it is still reading',
     reading && reading.next.length === 0 && reading.reading === true, JSON.stringify(reading && { next: reading.next, reading: reading.reading }));
  ok('once complete, next up is back', L.milestonesForRenderer(usage(), false).next.length > 0);
  ok('and a scan while indexing announces nothing', (await L.evaluateMilestones(usage({ totals: { input: 0, output: 900e6, cacheCreate: 0, cacheRead: 90e9, requests: 110_000 } }), false)) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
