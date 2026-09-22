/**
 * The indexer must not count a record twice when a transcript grows mid-scan.
 *
 * Claude Code appends to these files continuously, so this is not an edge case,
 * it is the normal condition on any machine that is actually being used. The
 * indexer used to open the read stream with a `start` and no `end`, so it
 * drained to whatever EOF happened to be at read time, while recording the size
 * it had stat'd BEFORE the read as the new offset. Everything written in that
 * window was folded into the totals and then read again on the next pass.
 *
 * WHAT EACH HALF OF THIS FILE ACTUALLY GUARDS, because a test that claims more
 * than it does is worse than no test.
 *
 * The SECOND block fails on the unfixed code and is the real guard. It covers
 * the same root cause from the other side: a record half written when the size
 * was taken. The old code read the fragment, discarded it as unparseable, and
 * still advanced the offset past it, so when the writer finished the record its
 * remaining bytes were never read and the record was lost outright. Measured:
 * 6052 where 6053 was correct. The fix walks the offset back to the last
 * complete line, so the tail is read again when it is whole.
 *
 * The FIRST block does NOT reliably reproduce the double count. That needs the
 * append to land while the read is still draining, and on a fast machine with a
 * file small enough for a quick test the scan simply finishes first. It was
 * reproduced by hand at about 26 MB with 1,000 records appended 60 ms into a
 * 350 ms scan: pass one ingested 121,000 records and left the offset at the
 * pre-read size, pass two reached 122,000 where 121,000 was correct. The block
 * is kept as a same-shape sanity check, not as proof.
 *
 * Both failure modes have one cause: reading to EOF while recording the size
 * stat'd before the read. Fixing that fixes both, and the second block proves
 * the fix holds.
 *
 *   node test/usage-append.test.mjs
 */

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-append-'));
const require = createRequire(import.meta.url);

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

const HOME = path.join(tmp, 'claude');
const PROJ = path.join(HOME, 'projects', 'proj');
await fs.mkdir(PROJ, { recursive: true });
const FILE = path.join(PROJ, 'session.jsonl');

/** One assistant record, shaped like the real thing. */
const rec = (i) => JSON.stringify({
  type: 'assistant',
  timestamp: new Date(Date.now() - (5000 - i) * 1000).toISOString(),
  sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  cwd: path.join(tmp, 'work'),
  version: '2.1.259',
  message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
}) + '\n';

process.env.MBW_CLAUDE_HOME = HOME;
const out = path.join(tmp, 'usage.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/main/data/usage.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out,
  external: ['electron'], logLevel: 'error',
});
const { refreshIndex, emptyIndex } = require(out);

console.log('\na transcript that grows while it is being read');
{
  /*
   * Padded records and a 6,000 line file, sized to widen the window the append
   * has to land in. It still usually does not: see the header. Treated as a
   * sanity check that a growing file ends up counted once, not as a regression
   * test for the race.
   */
  await fs.writeFile(FILE, Array.from({ length: 6000 }, (_, i) => rec(i)).join(''), 'utf8');

  const first = refreshIndex(emptyIndex());
  // One turn of the event loop puts us inside the first yield.
  await new Promise((r) => setImmediate(r));
  await fs.appendFile(FILE, Array.from({ length: 50 }, (_, i) => rec(6000 + i)).join(''), 'utf8');
  const a = await first;

  // Second pass picks up whatever the first one did not account for.
  const b = await refreshIndex(a.index);
  const total = b.index.totals.requests;

  ok('every record is counted exactly once', total === 6050,
     `expected 6050, got ${total}`);
  ok('the recorded offset matches the bytes actually folded in',
     b.index.files[FILE]?.offset === (await fs.stat(FILE)).size,
     `offset ${b.index.files[FILE]?.offset} vs size ${(await fs.stat(FILE)).size}`);
}

console.log('\na record that is half written when the size is taken');
{
  const f2 = path.join(PROJ, 'partial.jsonl');
  const whole = rec(1) + rec(2);
  const half = rec(3).slice(0, 40);
  await fs.writeFile(f2, whole + half, 'utf8');

  const one = await refreshIndex(emptyIndex());
  const afterPartial = one.index.totals.requests;

  // The writer finishes the record.
  await fs.writeFile(f2, whole + rec(3), 'utf8');
  const two = await refreshIndex(one.index);

  ok('the fragment is not counted while it is incomplete', afterPartial === 2 + 6050,
     `got ${afterPartial}`);
  ok('and it IS counted once the writer finishes it', two.index.totals.requests === 3 + 6050,
     `got ${two.index.totals.requests}`);
}

console.log('\nindex version 4: per-project hours and local active days');
{
  const { loadIndex } = require(out);
  /*
   * Two projects in the same recent hour, plus one record three weeks old. The
   * old one must count towards the active days (kept forever) and not towards
   * the per-project hours (kept for 14 days, like `hourly`).
   */
  const DIR = path.join(HOME, 'projects', 'hours');
  await fs.mkdir(DIR, { recursive: true });
  const hourStart = new Date(Date.now() - 2 * 3_600_000);
  hourStart.setMinutes(0, 0, 0);
  const at = (ms) => new Date(ms).toISOString();
  const cwdA = path.join(tmp, 'Alpha');
  const cwdB = path.join(tmp, 'bravo');
  const old = Date.now() - 21 * 86_400_000;
  const line = (ts, cwd, input, output) => JSON.stringify({
    type: 'assistant', timestamp: ts, sessionId: '11111111-2222-4333-8444-555555555555', cwd,
    message: { model: 'claude-opus-5', usage: { input_tokens: input, output_tokens: output } },
  }) + '\n';
  await fs.writeFile(path.join(DIR, 'h.jsonl'),
    line(at(hourStart.getTime() + 5 * 60_000), cwdA, 100, 10) +
    line(at(hourStart.getTime() + 9 * 60_000), cwdA, 200, 20) +
    line(at(hourStart.getTime() + 30 * 60_000), cwdB, 50, 5) +
    line(at(old), cwdB, 1, 1), 'utf8');

  const { index } = await refreshIndex(emptyIndex());
  const hourKey = hourStart.toISOString().slice(0, 13);
  const bucket = index.projectHourly[hourKey] ?? {};
  ok('the hour holds each project under the same lowercased key as `projects`',
     !!bucket[cwdA.toLowerCase()] && !!bucket[cwdB.toLowerCase()] && !!index.projects[cwdA.toLowerCase()],
     JSON.stringify(Object.keys(bucket)));
  ok('and folds requests, total and output per project',
     JSON.stringify(bucket[cwdA.toLowerCase()]) === JSON.stringify([2, 330, 30]) &&
     JSON.stringify(bucket[cwdB.toLowerCase()]) === JSON.stringify([1, 55, 5]), JSON.stringify(bucket));
  ok('a record older than 14 days is not read into the per-project hours',
     !Object.keys(index.projectHourly).some((k) => k === new Date(old).toISOString().slice(0, 13)));

  // The check above is the INGEST cutoff. This is the other half: an hour that
  // was recent when it was folded in and has since aged out must be pruned, or
  // the field grows forever. The first version of this suite only tested the
  // cutoff, and deleting the prune line did not fail it.
  const aged = { ...index, projectHourly: { ...index.projectHourly, '2020-01-01T00': { stale: [1, 1, 1] } } };
  const { index: pruned } = await refreshIndex(aged);
  ok('an hour that has aged past 14 days is pruned on the next pass', !pruned.projectHourly['2020-01-01T00']);

  const localDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  ok('active days are LOCAL days, and the old one is kept', index.activeDays[localDay(old)] === 1 &&
     (index.activeDays[localDay(hourStart.getTime() + 5 * 60_000)] ?? 0) >= 3, JSON.stringify(index.activeDays));

  const cache = path.join(tmp, 'v3-cache.json');
  await fs.writeFile(cache, JSON.stringify({ ...index, version: 3 }), 'utf8');
  const loaded = await loadIndex(cache);
  ok('a version 3 cache is discarded, so the new fields are built from scratch',
     loaded.version === 4 && Object.keys(loaded.projectHourly).length === 0 && loaded.totals.requests === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
