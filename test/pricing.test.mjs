/**
 * The price table, checked against Claude Code's own arithmetic.
 *
 * Cost is not recorded anywhere in a transcript: every record type in a session
 * file was scanned for a key containing "cost" and there is none. Claude Code's
 * `/usage` computes it in process from the token counts that ARE recorded, and
 * this file does the same sum, so the only honest way to trust it is to feed it
 * numbers Claude Code has already priced and check the dollars match.
 *
 * The fixtures below are a real `/usage` breakdown from 2026-09-04, taken from
 * a screenshot: per-model token counts and the dollar figure Claude Code put
 * beside them. Those token counts are displayed rounded (146.5k, 400.8m), so
 * the larger models can only be checked to within that rounding. Sonnet and
 * Haiku are small enough to check to the cent, and they are the assertions that
 * would actually catch a wrong multiplier.
 *
 * What this does NOT validate: the split between five minute and one hour cache
 * writes. Claude Code reports one combined "cache write" figure, so its total
 * cannot pin the mix. The indexer reads the real per-record split, which is
 * strictly better information than this fixture can confirm.
 *
 *   node test/pricing.test.mjs
 */

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-price-'));
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
};

const out = path.join(tmp, 'pricing.cjs');
await esbuild.build({ entryPoints: [path.join(root, 'src/shared/pricing.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
const { costOf, priceFor, formatCost } = require(out);

console.log('');
console.log('against a real /usage breakdown, 2026-09-04');
{
  // Sonnet 5: small enough that the displayed counts are not badly rounded.
  const sonnet = costOf('claude-sonnet-5', {
    input: 6700, output: 22100, cacheRead: 2_600_000,
    cacheWrite5m: 147_400, cacheWrite1h: 0, webSearch: 0,
  });
  ok('claude-sonnet-5 lands on the reported $1.12', Math.abs(sonnet - 1.12) < 0.01,
     '$' + sonnet.toFixed(4));

  // Haiku: the only entry with a web search, so it pins that price too.
  const haikuNoSearch = costOf('claude-haiku-4-5', {
    input: 32500, output: 789, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0,
  });
  const haiku = costOf('claude-haiku-4-5', {
    input: 32500, output: 789, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 1,
  });
  ok('claude-haiku-4-5 without the web search is $0.0364', Math.abs(haikuNoSearch - 0.0364) < 0.0005,
     '$' + haikuNoSearch.toFixed(4));
  ok('one web search is the missing cent, giving the reported $0.0464',
     Math.abs(haiku - 0.0464) < 0.0005, '$' + haiku.toFixed(4));

  // Fable 5.1 reads at 0.025x, not the 0.1x every other model uses. If that
  // were wrong this comes out about $18 high, so it is the load-bearing case.
  const fable = costOf('claude-fable-5-1', {
    input: 574_200, output: 449_900, cacheRead: 21_000_000,
    cacheWrite5m: 2_300_000, cacheWrite1h: 0, webSearch: 0,
  });
  ok('claude-fable-5-1 lands near the reported $61.63', Math.abs(fable - 61.63) < 1.0,
     '$' + fable.toFixed(2));
  const wrongFactor = costOf('claude-opus-5', {
    input: 0, output: 0, cacheRead: 21_000_000, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0,
  });
  ok('and it really is cheaper per cached token than the 0.1x models',
     costOf('claude-fable-5-1', { input: 0, output: 0, cacheRead: 21_000_000, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 })
       < wrongFactor * 1.1);
}

console.log('');
console.log('the multipliers');
{
  const base = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 };
  const M = 1_000_000;
  ok('input is the base rate', costOf('claude-opus-5', { ...base, input: M }) === 5);
  ok('output is the output rate', costOf('claude-opus-5', { ...base, output: M }) === 25);
  ok('a cache read is a tenth of input', Math.abs(costOf('claude-opus-5', { ...base, cacheRead: M }) - 0.5) < 1e-9);
  ok('a five minute cache write is 1.25x input',
     Math.abs(costOf('claude-opus-5', { ...base, cacheWrite5m: M }) - 6.25) < 1e-9);
  ok('a one hour cache write is 2x input, not 1.25x',
     Math.abs(costOf('claude-opus-5', { ...base, cacheWrite1h: M }) - 10) < 1e-9);
  ok('the two TTLs are NOT priced the same',
     costOf('claude-opus-5', { ...base, cacheWrite1h: M }) !== costOf('claude-opus-5', { ...base, cacheWrite5m: M }));
}

console.log('');
console.log('model ids');
{
  ok('a dated id resolves to its model', priceFor('claude-haiku-4-5-20251001') === priceFor('claude-haiku-4-5'));
  ok('fable-5-1 is not swallowed by the fable-5 prefix',
     priceFor('claude-fable-5-1').cacheReadFactor !== priceFor('claude-fable-5').cacheReadFactor);
  ok('an unknown model has no price', priceFor('claude-something-9') === null);
  ok('and costs null rather than zero, so it cannot silently vanish',
     costOf('claude-something-9', { input: 1e9, output: 1e9, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 }) === null);
  ok('the synthetic pseudo-model is unknown too', priceFor('<synthetic>') === null);
  ok('junk is refused', priceFor('') === null && priceFor(null) === null);
}

console.log('');
console.log('formatting');
{
  ok('two decimals, comma separated', formatCost(22523.44) === '$22,523.44', formatCost(22523.44));
  ok('small amounts keep both', formatCost(1.234) === '$1.23', formatCost(1.234));
  ok('NEVER rounds up: .469 stays .46', formatCost(22523.469) === '$22,523.46', formatCost(22523.469));
  ok('nor at .999', formatCost(9.999) === '$9.99', formatCost(9.999));
  ok('exact cents survive', formatCost(5.5) === '$5.50', formatCost(5.5));
  ok('nothing is $0.00', formatCost(0) === '$0.00' && formatCost(NaN) === '$0.00');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
