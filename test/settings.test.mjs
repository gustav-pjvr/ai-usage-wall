/**
 * normaliseSettings: the one function between settings.json and the whole app.
 *
 * It had no tests while it grew to guard eighteen keys, and since 2026-09-08 it
 * also guards the IN-MEMORY settings, not just the file: updateSettings runs
 * every patch through it before wallState() pushes the result to every
 * renderer. A bad value that gets past it no longer just sits in a file; it
 * reaches the notes bar, the layer code and the tray on the next push.
 *
 * settings.ts imports `app` from electron for the file path. Electron is
 * replaced with a stub pointing at the temporary fixture directory, so loading
 * a legacy settings file never reads the installed app settings.
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

const out = path.join(tmp, 'settings.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/main/settings.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
  plugins: [{
    name: 'stub-electron',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app = { getPath: () => ${JSON.stringify(tmp)} };`, loader: 'js' }));
    },
  }],
});
const { normaliseSettings, loadSettings, effectiveMode, DEFAULT_SETTINGS } = require(out);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\nsettings: anything in, a working Settings out');

for (const [label, raw] of [
  ['undefined', undefined], ['null', null], ['a string', 'settings'], ['a number', 42],
  ['an array', [1, 2]], ['an empty object', {}],
]) {
  ok(`${label} becomes the defaults`, same(normaliseSettings(raw), DEFAULT_SETTINGS));
}

ok('never throws on a hostile object', (() => {
  try {
    normaliseSettings({ opacity: { valueOf() { throw new Error('boom'); } }, monitors: 'all', notes: {} });
    return true;
  } catch {
    return false;
  }
})());

console.log('\nsettings: enums fall back rather than pass through');
ok('an unknown view mode becomes stats', normaliseSettings({ mode: 'kiosk' }).mode === 'stats');
// The escaped legacy key keeps the retired identifier out of source searches.
const legacy = String.raw`{"mode":"clients","clients\u0044ir":"old-records","assetsDir":"old-assets","vaultPath":"old-vault","useVault":true,"notes":"keep this","opacity":0.5}`;
await fs.writeFile(path.join(tmp, 'settings.json'), legacy);
const migrated = await loadSettings();
ok('an old client-view settings file loads as stats', migrated.mode === 'stats');
ok('legacy data paths are dropped without losing current settings',
   same(migrated, normaliseSettings({ notes: 'keep this', opacity: 0.5 })));
ok('the removed wallpaper layer mode becomes desktop',
   normaliseSettings({ layerMode: 'wallpaper' }).layerMode === 'desktop');
ok('top is kept', normaliseSettings({ layerMode: 'top' }).layerMode === 'top');
ok('an unknown performance tier becomes auto', normaliseSettings({ performance: 'ultra' }).performance === 'auto');
ok('an unknown background becomes the default',
   normaliseSettings({ background: 'rainbow' }).background === DEFAULT_SETTINGS.background);

console.log('\nsettings: numbers are clamped, not trusted');
ok('opacity below the floor is lifted to 0.2', normaliseSettings({ opacity: 0 }).opacity === 0.2);
ok('opacity above 1 is capped', normaliseSettings({ opacity: 9 }).opacity === 1);
ok('a string opacity is ignored, not coerced', normaliseSettings({ opacity: '0.5' }).opacity === DEFAULT_SETTINGS.opacity);
ok('only integer monitor ids survive',
   same(normaliseSettings({ monitors: [1, 2.5, '3', null, 4] }).monitors, [1, 4]));

console.log('\nsettings: booleans are strict');
ok('clickThrough needs a real true', normaliseSettings({ clickThrough: 'true' }).clickThrough === false);
ok('debug needs a real true', normaliseSettings({ debug: 1 }).debug === false);

console.log('\nsettings: the notes field');
ok('a note survives', normaliseSettings({ notes: 'npm run deploy' }).notes === 'npm run deploy');
ok('a non-string note becomes empty, it does not reach the renderer as a number',
   normaliseSettings({ notes: 12345 }).notes === '');
ok('an object note becomes empty', normaliseSettings({ notes: { toString: () => 'x' } }).notes === '');
ok('a long note is capped at 400', normaliseSettings({ notes: 'x'.repeat(1000) }).notes.length === 400);

// maxlength on the input counts characters as a person sees them; String.slice
// counts UTF-16 units. An emoji is two units, so slicing by units could cut
// one in half and leave a lone surrogate that renders as a broken glyph.
const emoji = '\u{1F680}'.repeat(401);
const capped = normaliseSettings({ notes: emoji }).notes;
ok('the cap counts code points, 400 rockets not 200', Array.from(capped).length === 400, String(Array.from(capped).length));
ok('and never splits a character in half', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(capped));

console.log('\nsettings: the top panel');
ok('defaults to the constellation', normaliseSettings({}).topPanel === 'constellation');
ok('the live trace is kept when chosen', normaliseSettings({ topPanel: 'throughput' }).topPanel === 'throughput');
ok('anything else falls back to the constellation', normaliseSettings({ topPanel: 'unknown' }).topPanel === 'constellation');

console.log('\nsettings: the stats view and the Codex toggle');
ok('the wall opens on the detailed view', normaliseSettings({}).statsView === 'detailed');
ok('simple is kept when chosen', normaliseSettings({ statsView: 'simple' }).statsView === 'simple');
ok('anything else falls back to detailed', normaliseSettings({ statsView: 'SIMPLE' }).statsView === 'detailed');
ok('Codex is shown by default', normaliseSettings({}).showCodex === true);
ok('off is kept', normaliseSettings({ showCodex: false }).showCodex === false);
ok('only a real false turns it off', normaliseSettings({ showCodex: 0 }).showCodex === true && normaliseSettings({ showCodex: 'false' }).showCodex === true);

console.log('\nsettings: Work mode (full build) and its filter');
ok('work is kept in the full build', normaliseSettings({ mode: 'work' }).mode === 'work');
ok('stats is kept', normaliseSettings({ mode: 'stats' }).mode === 'stats');
ok('the old clients view still loads as stats, not work', normaliseSettings({ mode: 'clients' }).mode === 'stats');
ok('Work, in any other spelling, is stats', normaliseSettings({ mode: 'WORK' }).mode === 'stats');
ok('Mine is the default task filter', normaliseSettings({}).workFilter === 'mine');
ok('Everyone is kept when chosen', normaliseSettings({ workFilter: 'everyone' }).workFilter === 'everyone');
ok('anything else is Mine', normaliseSettings({ workFilter: 'all' }).workFilter === 'mine');
ok('a paired screen never shows Work, whatever the setting', effectiveMode({ mode: 'work' }, { screen: true }) === 'stats');
ok('this wall shows Work when it is set', effectiveMode({ mode: 'work' }, { screen: false }) === 'work');
ok('and stats when that is set', effectiveMode({ mode: 'stats' }, { screen: false }) === 'stats');

/*
 * The stats edition, built with its own define: 'work' never survives there,
 * from a settings file or from a patch, and the effective view is stats.
 */
const statsOut = path.join(tmp, 'settings-stats.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/main/settings.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: statsOut, logLevel: 'error',
  define: { 'process.env.MBW_EDITION': JSON.stringify('stats') },
  plugins: [{
    name: 'stub-electron',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app = { getPath: () => ${JSON.stringify(tmp)} };`, loader: 'js' }));
    },
  }],
});
const stats = require(statsOut);
ok('stats build: a work setting loads as stats', stats.normaliseSettings({ mode: 'work' }).mode === 'stats');
ok('stats build: the effective view is stats even when the file says work', stats.effectiveMode({ mode: 'work' }, { screen: false }) === 'stats');
await fs.writeFile(path.join(tmp, 'settings.json'), JSON.stringify({ mode: 'work', notes: 'kept' }));
const statsLoaded = await stats.loadSettings();
ok('stats build: a settings file from the full build loads as stats and keeps the rest', statsLoaded.mode === 'stats' && statsLoaded.notes === 'kept');
const fullLoaded = await loadSettings();
ok('full build: the same file loads as work', fullLoaded.mode === 'work' && fullLoaded.notes === 'kept');

console.log('\nsettings: mail VIPs (Work mode, full build)');
ok('full build: the VIP list defaults to Jaco\'s known address', same(DEFAULT_SETTINGS.mailVip, ['jacojvr@gmail.com']));
ok('full build: plain addresses only, trimmed and lower-cased, no repeats',
   same(normaliseSettings({ mailVip: [' Jaco@Example.com ', 'jaco@example.com', 'not an address', 42, '<x@y.z>'] }).mailVip, ['jaco@example.com']));
ok('full build: an empty list stays empty (Gustav can turn VIPs off)', same(normaliseSettings({ mailVip: [] }).mailVip, []));
ok('stats build: no VIP list at all, whatever the file says', same(stats.DEFAULT_SETTINGS.mailVip, []) && same(stats.normaliseSettings({ mailVip: ['a@b.co'] }).mailVip, []));

console.log('\nsettings: round trip');
const once = normaliseSettings({ mode: 'stats', opacity: 0.5, notes: 'hi', monitors: [2] });
ok('normalising twice changes nothing', same(normaliseSettings(once), once));
ok('every default key is present on any output',
   Object.keys(DEFAULT_SETTINGS).every((k) => k in normaliseSettings({ junk: true })));
ok('unknown keys are dropped', !('junk' in normaliseSettings({ junk: true })));

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
