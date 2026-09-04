/**
 * Verification for the two pure algorithms that carry the product's guarantees.
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

const { deriveBrandTokens } = await load('src/shared/color.ts');
const { computeLayout } = await load('src/shared/layout.ts');
const { validateClient } = await load('src/shared/schema.ts');
const { velocityOf, VELOCITY_WINDOW_MS } = await load('src/shared/velocity.ts');

// ── Brand derivation: every card must be legible, whatever the brand ────────
console.log('\nbrand token derivation');
for (const [slug, hex] of [
  ['neon-yellow', '#FFFF00'], ['pure-white', '#FFFFFF'], ['pure-black', '#000000'],
  ['mid-grey', '#808080'], ['neon-cyan', '#00FFF0'], ['deep-navy', '#0A1128'],
  ['acid-green', '#76FF03'], ['brand-teal', '#0F766E'], ['hot-pink', '#FF1493'],
  ['invalid', 'not-a-colour'], ['missing', null], ['short', '#F0A'],
]) {
  const t = deriveBrandTokens(slug, { primary: hex });
  ok(`AA contrast for ${slug}`,
     t.meta.bodyContrast >= 4.5 && t.meta.accentContrast >= 4.5,
     `body ${t.meta.bodyContrast} accent ${t.meta.accentContrast}`);
}
ok('derivation is deterministic',
   JSON.stringify(deriveBrandTokens('acme', { primary: '#36f' })) ===
   JSON.stringify(deriveBrandTokens('acme', { primary: '#36f' })));
ok('colourless clients get distinct hues',
   new Set(['a','b','c','d','e'].map(s => Math.round(deriveBrandTokens(s, null).hue))).size === 5);

// ── Layout: no overlaps, deterministic, stable under a single edit ──────────
console.log('\nlayout engine');
const NOW = new Date('2026-09-02T12:00:00Z');
const states = ['active', 'prospect', 'past', 'archived', 'paused'];
const mk = (n) => Array.from({ length: n }, (_, i) => ({
  id: `c-${String(i).padStart(2, '0')}`, state: states[i % states.length],
  revenue: (i * 7919) % 120000, progress: (i * 37) % 100,
  lastInteraction: new Date(NOW - ((i * 13) % 400) * 864e5).toISOString().slice(0, 10),
}));

for (const n of [1, 5, 12, 24, 40]) {
  for (const [label, W, H] of [['1920x1080',1920,1080],['2560x1440',2560,1440],['3840x2160',3840,2160]]) {
    const r = computeLayout(mk(n), { width: W, height: H, now: NOW });
    const byPage = {};
    r.cards.forEach(c => (byPage[c.page] ??= []).push(c));
    let overlaps = 0;
    for (const pg of Object.values(byPage))
      for (let i = 0; i < pg.length; i++)
        for (let j = i + 1; j < pg.length; j++) {
          const a = pg[i], b = pg[j];
          if (a.x < b.x + b.width - 0.5 && a.x + a.width > b.x + 0.5 &&
              a.y < b.y + b.height - 0.5 && a.y + a.height > b.y + 0.5) overlaps++;
        }
    const shortest = Math.min(...r.cards.map(c => c.height));
    ok(`n=${n} ${label}: ${r.cards.length} cards, ${r.pageCount} page(s), no overlap, legible`,
       overlaps === 0 && r.cards.length === n && shortest >= 100,
       `overlaps=${overlaps} shortest=${Math.round(shortest)}px`);
  }
}
ok('layout is deterministic',
   JSON.stringify(computeLayout(mk(20), { width: 1920, height: 1080, now: NOW })) ===
   JSON.stringify(computeLayout(mk(20), { width: 1920, height: 1080, now: NOW })));

const base = mk(20);
const edited = base.map(c => (c.id === 'c-07' ? { ...c, progress: 64 } : c));
const L1 = computeLayout(base, { width: 1920, height: 1080, now: NOW });
const L2 = computeLayout(edited, { width: 1920, height: 1080, now: NOW });
const pos = new Map(L1.cards.map(c => [c.id, `${c.x},${c.y},${c.width}`]));
const moved = L2.cards.filter(c => pos.get(c.id) !== `${c.x},${c.y},${c.width}`);
ok('editing one client moves no other card', moved.length === 0, `${moved.length} moved`);
ok('empty client list does not throw',
   computeLayout([], { width: 1920, height: 1080 }).cards.length === 0);

// The editorial override has to beat the score in BOTH directions, or it is not
// an override. The top-scoring client is pushed down and the bottom one pulled
// up, and the assertion is on the resulting tier, not on the score.
const ranked = mk(12);
const top = ranked[0].id;
const bottom = ranked[ranked.length - 1].id;
const tierOf = (cards, id) => cards.find(c => c.id === id)?.tier;

const plain = computeLayout(ranked, { width: 1920, height: 1080, now: NOW }).cards;
const overridden = computeLayout(
  ranked.map(c => c.id === top ? { ...c, emphasis: 'background' }
            : c.id === bottom ? { ...c, emphasis: 'feature' } : c),
  { width: 1920, height: 1080, now: NOW },
).cards;

ok("emphasis 'background' caps a strong client at small",
   tierOf(overridden, top) === 'small', `was ${tierOf(plain, top)}, now ${tierOf(overridden, top)}`);
ok("emphasis 'feature' floors a weak client at large or hero",
   ['large', 'hero'].includes(tierOf(overridden, bottom)),
   `was ${tierOf(plain, bottom)}, now ${tierOf(overridden, bottom)}`);
ok('legacy featured:true still behaves as feature',
   ['large', 'hero'].includes(tierOf(
     computeLayout(ranked.map(c => c.id === bottom ? { ...c, featured: true } : c),
                   { width: 1920, height: 1080, now: NOW }).cards, bottom)));

// ── Schema: degrade, never drop ────────────────────────────────────────────
console.log('\nschema validation');
ok('minimal record is accepted', validateClient({ id: 'x', name: 'X' }).client !== null);
ok('record with no identity is rejected', validateClient({ revenue: 1 }).client === null);
ok('name alone derives an id', validateClient({ name: 'Acme Ltd' }).client?.id === 'acme-ltd');
ok('messy revenue parses', validateClient({ id: 'a', revenue: 'R45,000' }).client?.revenue === 45000);
ok('out-of-range progress clamps', validateClient({ id: 'a', progress: 340 }).client?.progress === 100);
ok('unknown status still renders a card', validateClient({ id: 'a', state: 'wobbly' }).client?.state === 'active');
ok('bad date warns but keeps the client', validateClient({ id: 'a', startDate: 'soon' }).client !== null);
ok('invalid colour falls back', validateClient({ id: 'a', branding: { primary: 'zzz' } }).client?.branding.primary === null);
ok('unknown fields are preserved', validateClient({ id: 'a', futureField: 42 }).client?.extra.futureField === 42);
ok('completed aliases to past', validateClient({ id: 'a', state: 'completed' }).client?.state === 'past');

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
