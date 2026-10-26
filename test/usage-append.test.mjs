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
// Two hours ahead of UTC, like this machine, so a local day and a UTC date
// disagree every night and the slots must follow the local one.
process.env.TZ = 'Africa/Johannesburg';
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
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

console.log('\na COMPLETE record whose newline is not written yet (2026-10-26)');
{
  /*
   * Unlike the fragment above, this record already parses. It used to be
   * counted when first seen AND again when re-read after its newline arrived.
   */
  const f3 = path.join(PROJ, 'no-newline.jsonl');
  const before = (await refreshIndex(emptyIndex())).index.totals.requests;
  await fs.writeFile(f3, rec(1) + rec(2).trimEnd(), 'utf8');
  const one = await refreshIndex(emptyIndex());
  ok('the record without its newline is not counted yet', one.index.totals.requests === before + 1,
     `got ${one.index.totals.requests - before}`);
  await fs.appendFile(f3, '\n', 'utf8');
  const two = await refreshIndex(one.index);
  ok('and once its newline arrives it is counted exactly once', two.index.totals.requests === before + 2,
     `got ${two.index.totals.requests - before}`);
}

console.log('\nindex version 6: five-minute slots per file, and local active days');
{
  const { loadIndex, saveIndex, INDEX_VERSION } = require(out);
  /*
   * Two projects in one five-minute slot, a record with no cwd, one at 00:30
   * local (the previous UTC date, since this file runs at UTC+2), and one three
   * weeks old. The slots live in each file's own contribution, never in an
   * index-wide field, and are kept forever like `activeDays`.
   */
  const DIR = path.join(HOME, 'projects', 'slots');
  await fs.mkdir(DIR, { recursive: true });
  const base = new Date();
  base.setHours(10, 0, 0, 0);
  if (base.getTime() > Date.now()) base.setDate(base.getDate() - 1);
  const t = base.getTime();
  const midnight = new Date(t);
  midnight.setHours(0, 30, 0, 0);
  const old = t - 21 * 86_400_000;
  const cwdA = path.join(tmp, 'Alpha');
  const cwdB = path.join(tmp, 'bravo');
  const line = (ms, cwd, input, output) => JSON.stringify({
    type: 'assistant', timestamp: new Date(ms).toISOString(), sessionId: '11111111-2222-4333-8444-555555555555',
    ...(cwd === null ? {} : { cwd }),
    message: { model: 'claude-opus-5', usage: { input_tokens: input, output_tokens: output } },
  }) + '\n';
  const file = path.join(DIR, 's.jsonl');
  await fs.writeFile(file,
    line(t + 1 * 60_000, cwdA, 100, 10) +
    line(t + 4 * 60_000, cwdA, 200, 20) +
    line(t + 3 * 60_000, cwdB, 50, 5) +
    line(t + 7 * 60_000, null, 9, 1) +
    line(midnight.getTime(), cwdB, 3, 3) +
    line(old, cwdB, 1, 1), 'utf8');

  const { index } = await refreshIndex(emptyIndex());
  const c = index.files[file].contrib;
  const day = localDay(t);
  const slots = c.intraday?.[day] ?? {};
  ok('the index itself has no per-project hours any more', !('projectHourly' in index));
  ok('the slot holds each project under the same lowercased key as `projects`',
     !!slots[cwdA.toLowerCase()]?.['120'] && !!slots[cwdB.toLowerCase()]?.['120'] && !!index.projects[cwdA.toLowerCase()],
     JSON.stringify(Object.keys(slots)));
  ok('and folds requests, total and output per project per slot',
     JSON.stringify(slots[cwdA.toLowerCase()]['120']) === '[2,330,30]' && JSON.stringify(slots[cwdB.toLowerCase()]['120']) === '[1,55,5]',
     JSON.stringify(slots));
  ok('a record with no cwd is in the curve, under ""', JSON.stringify(slots['']?.['121']) === '[1,10,1]', JSON.stringify(slots['']));
  ok('00:30 local lands in slot 6 of the LOCAL day, not the UTC date',
     JSON.stringify(c.intraday[localDay(midnight.getTime())]?.[cwdB.toLowerCase()]?.['6']) === '[1,6,3]' &&
     new Date(midnight.getTime()).toISOString().slice(0, 10) !== localDay(midnight.getTime()),
     JSON.stringify(c.intraday[localDay(midnight.getTime())]));
  ok('a record three weeks old keeps its slot: detail is kept forever', !!c.intraday[localDay(old)]);
  const perDay = Object.fromEntries(Object.entries(c.intraday).map(([d, byProject]) =>
    [d, Object.values(byProject).reduce((n, s) => n + Object.values(s).reduce((a, cell) => a + cell[0], 0), 0)]));
  ok('for the file, every day\'s slot counts add up to its activeDays exactly',
     JSON.stringify(Object.entries(perDay).sort()) === JSON.stringify(Object.entries(c.activeDays).sort()),
     `${JSON.stringify(perDay)} vs ${JSON.stringify(c.activeDays)}`);
  ok('active days are LOCAL days, and the old one is kept', index.activeDays[localDay(old)] === 1 && (index.activeDays[day] ?? 0) >= 4,
     JSON.stringify(index.activeDays));

  const cache = path.join(tmp, 'v5-cache.json');
  await saveIndex(cache, { ...index, version: 5 });
  const { index: loaded, staleFiles } = await loadIndex(cache);
  ok('a version 5 cache is discarded, so the slots are built from scratch',
     INDEX_VERSION >= 6 && loaded.version === INDEX_VERSION && loaded.totals.requests === 0);
  ok('and its per-file contributions are handed back, not lost', !!staleFiles[file] && staleFiles[file].totals.requests === 6);
}

console.log('\nindex version 9: the stretches Claude was working, per file');
{
  const DIR = path.join(HOME, 'projects', 'hours');
  await fs.mkdir(DIR, { recursive: true });
  const t = Date.now() - 3 * 3_600_000;
  const line = (ms) => JSON.stringify({
    type: 'assistant', timestamp: new Date(ms).toISOString(), sessionId: '99999999-2222-4333-8444-555555555555',
    message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
  }) + '\n';
  const file = path.join(DIR, 'w.jsonl');
  // Two minutes of work, a 20 minute pause, then one more minute.
  await fs.writeFile(file, line(t) + line(t + 60_000) + line(t + 120_000) + line(t + 20 * 60_000) + line(t + 21 * 60_000), 'utf8');
  const { index } = await refreshIndex(emptyIndex());
  const a = index.files[file].contrib.active;
  ok('each file keeps its own stretches, split at the pause', a.spans.length === 2 &&
     a.spans[0][1] - a.spans[0][0] === 120 && a.spans[1][1] - a.spans[1][0] === 60, JSON.stringify(a));
  // Claude Code appends to the same transcript: the stretch carries on.
  await fs.appendFile(file, line(t + 23 * 60_000), 'utf8');
  const { index: next } = await refreshIndex(index);
  const b = next.files[file].contrib.active;
  ok('a stretch continues into the bytes the next refresh reads', b.spans.length === 2 && b.spans[1][1] - b.spans[1][0] === 180,
     JSON.stringify(b));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
