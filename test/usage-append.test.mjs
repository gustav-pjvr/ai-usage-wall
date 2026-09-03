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

console.log(`\n${pass} passed, ${fail} failed\n`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
