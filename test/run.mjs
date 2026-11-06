/**
 * Verification for shared stats algorithms.
 *
 * Plain node, no test framework: src/shared/ imports nothing from Electron
 * precisely so it can be checked this cheaply. Run with `npm test`.
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

const { velocityOf, VELOCITY_WINDOW_MS } = await load('src/shared/velocity.ts');

await fs.rm(tmp, { recursive: true, force: true });
console.log('');
console.log('velocity: an average over the window, not since the oldest record');
{
  const MIN = 60_000;
  const now = 1_000_000_000_000;
  // One burst of 3M tokens, all of it four minutes before `now`.
  const burst = [[now - 4 * MIN, 1_000_000, 0], [now - 4 * MIN + 1000, 2_000_000, 0]];

  ok('a burst is averaged over the full ten minutes, not its own span',
     velocityOf(burst, now) === 300_000, String(velocityOf(burst, now)));

  /*
   * The bug this replaced: with the same records and no new work, the old
   * formula fell steadily because its divisor grew. The reading must not move
   * unless the facts do.
   */
  const atFive = velocityOf(burst, now + 1 * MIN);
  const atNine = velocityOf(burst, now + 5 * MIN);
  ok('the same records read the SAME five minutes later', atFive === atNine && atFive === 300_000,
     `${atFive} then ${atNine}`);

  ok('it falls only when a record ages out of the window',
     velocityOf(burst, now + 6 * MIN + 1) === 200_000,
     String(velocityOf(burst, now + 6 * MIN + 1)));
  ok('and reaches zero once the window is empty',
     velocityOf(burst, now + 11 * MIN) === 0);

  ok('no records at all is zero, not a division by zero', velocityOf([], now) === 0);
  ok('a record exactly on the boundary is still counted',
     velocityOf([[now - VELOCITY_WINDOW_MS, 600_000, 0]], now) === 60_000);
  ok('a record one millisecond past it is not',
     velocityOf([[now - VELOCITY_WINDOW_MS - 1, 600_000, 0]], now) === 0);
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
