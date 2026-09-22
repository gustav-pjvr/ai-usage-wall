/**
 * The constellation layout, as pure functions.
 *
 * The render suite checks what gets drawn at eight screen sizes. This checks
 * the rules underneath it: the same data always gives the same sky, sizes come
 * from fixed thresholds, links count shared local days, nothing is invented to
 * fill the cap, and labels never collide or leave the box.
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
const out = path.join(tmp, 'constellation.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/shared/constellation.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
});
const C = require(out);
const D = await (async () => {
  const o = path.join(tmp, 'day.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'src/shared/day.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: o, logLevel: 'error' });
  return require(o);
})();

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ->  ' + detail : ''}`); }
};

const now = Date.parse('2026-09-22T12:00:00Z');
const star = (label, total, daysAgo = 0) => ({
  key: label.toLowerCase(), label, total, output: total / 100, requests: 10,
  lastSeen: new Date(now - daysAgo * 86_400_000).toISOString(),
});
const sky = [
  star('alpha', 20e9), star('bravo', 3e9, 2), star('charlie', 400e6, 10),
  star('delta', 50e6, 30), star('echo', 5e6, 90), star('foxtrot', 0),
];

console.log('\nconstellation: sizes and brightness');
ok('sizes use fixed log thresholds', [C.bucketOf(5e6), C.bucketOf(50e6), C.bucketOf(500e6), C.bucketOf(5e9), C.bucketOf(50e9)].join() === '0,1,2,3,4');
ok('zero and junk land in the smallest bucket', C.bucketOf(0) === 0 && C.bucketOf(NaN) === 0 && C.bucketOf(-5) === 0);
ok('used just now is full brightness', Math.abs(C.brightnessOf(new Date(now).toISOString(), now) - 1) < 1e-9);
ok('seven days halves it', Math.abs(C.brightnessOf(new Date(now - 7 * 86_400_000).toISOString(), now) - 0.5) < 1e-9);
ok('a dormant project is dim, never gone', C.brightnessOf(new Date(now - 400 * 86_400_000).toISOString(), now) === 0.12);
ok('an unreadable date is the floor, not an error', C.brightnessOf('never', now) === 0.12);

console.log('\nconstellation: layout');
const base = { stars: sky, links: [['alpha', 'bravo', 3]], activeLabel: 'bravo', now, width: 600, height: 240 };
const a = C.layoutConstellation(base);
const b = C.layoutConstellation({ ...base, stars: [...sky].reverse() });
ok('same data, same sky, whatever the input order', JSON.stringify(a) === JSON.stringify(b));
ok('a project with no tokens is not drawn', !a.stars.some((s) => s.label === 'foxtrot'));
ok('every star is inside the box',
   a.stars.every((s) => s.x - s.size / 2 >= 0 && s.y - s.size / 2 >= 0 && s.x + s.size / 2 <= 600 && s.y + s.size / 2 <= 240));
ok('the active star is the one named, and only it', a.stars.filter((s) => s.active).map((s) => s.label).join() === 'bravo');
ok('nobody is active without an active label', !C.layoutConstellation({ ...base, activeLabel: null }).stars.some((s) => s.active));
ok('a link to a star that is not shown is dropped, not dangling',
   C.layoutConstellation({ ...base, links: [['alpha', 'nobody', 2]] }).links.length === 0);
ok('link weight is capped at 5', C.layoutConstellation({ ...base, links: [['alpha', 'bravo', 40]] }).links[0].w === 5);

const capped = C.layoutConstellation({ ...base, maxStars: 3 });
ok('the cap keeps the biggest projects', capped.stars.map((s) => s.label).sort().join() === 'alpha,bravo,charlie');
ok('and counts the rest honestly in "more"', capped.more === 2, String(capped.more));
ok('one project sits in the middle', (() => {
  const one = C.layoutConstellation({ ...base, stars: [star('solo', 1e9)], links: [] });
  return one.stars.length === 1 && one.stars[0].x === 300 && one.stars[0].y === 120;
})());
ok('an empty sky is empty, not an error', C.layoutConstellation({ ...base, stars: [] }).stars.length === 0);
ok('the panel size scales the cap: small panel, fewer stars', C.maxStarsFor(300, 150) < C.maxStarsFor(900, 400));
ok('the cap never drops below 6 or passes 40', C.maxStarsFor(10, 10) === 6 && C.maxStarsFor(9000, 9000) === 40);

console.log('\nconstellation: hit test and labels');
const target = a.stars.find((s) => s.label === 'alpha');
ok('a point on a star finds it', C.hitTest(a, target.x, target.y)?.label === 'alpha');
ok('empty space finds nothing', C.hitTest(a, -50, -50) === null);

const measure = (t) => t.length * 7;
const labels = C.placeLabels(a, measure, 11, 16);
ok('labels stay inside the box', labels.every((l) => l.x >= 0 && l.y >= 0 && l.x + l.w <= 600 && l.y + l.h <= 240));
let overlap = 0;
for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
  const p = labels[i], q = labels[j];
  if (p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y) overlap++;
}
ok('no two labels overlap', overlap === 0);
ok('a label near the edge is slid inside, not dropped', (() => {
  const edge = { stars: [{ ...star('a-very-long-project-name', 1e9), x: 4, y: 20, size: 10, bucket: 3, brightness: 1, hue: 0, active: false }],
                 links: [], more: 0, width: 400, height: 100 };
  const l = C.placeLabels(edge, measure, 11, 16);
  return l.length === 1 && l[0].x === 0;
})());
ok('a label wider than the whole box is skipped', (() => {
  const tiny = { stars: [{ ...star('much-too-long-for-this-box', 1e9), x: 20, y: 20, size: 10, bucket: 3, brightness: 1, hue: 0, active: false }],
                 links: [], more: 0, width: 40, height: 100 };
  return C.placeLabels(tiny, measure, 11, 16).length === 0;
})());

console.log('\nconstellation: links from sessions');
const at = (y, mo, d, h) => new Date(y, mo - 1, d, h).toISOString();
const sessions = [
  { cwd: 'C:\\w\\alpha', start: at(2026, 9, 20, 10), end: at(2026, 9, 20, 11) },
  { cwd: 'C:\\w\\bravo', start: at(2026, 9, 20, 15), end: at(2026, 9, 20, 16) },
  { cwd: 'C:\\w\\alpha', start: at(2026, 9, 21, 9), end: at(2026, 9, 21, 10) },
  { cwd: 'C:\\w\\bravo', start: at(2026, 9, 21, 23), end: at(2026, 9, 22, 1) }, // crosses local midnight
  { cwd: 'C:\\w\\charlie', start: at(2026, 9, 22, 8), end: at(2026, 9, 22, 9) },
  { cwd: null, start: at(2026, 9, 22, 8), end: at(2026, 9, 22, 9) },
];
const label = (cwd) => cwd.split('\\').pop();
const links = C.buildLinks(sessions, label);
const find = (x, y) => links.find((l) => (l[0] === x && l[1] === y) || (l[0] === y && l[1] === x));
ok('two projects on two shared days link with weight 2', find('alpha', 'bravo')?.[2] === 2, JSON.stringify(links));
ok('a session that crosses local midnight links on BOTH days', find('bravo', 'charlie')?.[2] === 1, JSON.stringify(links));
ok('projects never on the same day are not linked', !find('alpha', 'charlie'));
ok('a session with no working directory is ignored', links.every((l) => l[0] && l[1]));
ok('each link is written with its labels in order', links.every((l) => l[0] < l[1]));
ok('a label function returning null leaves the project out',
   C.buildLinks(sessions, (cwd) => (cwd.endsWith('alpha') ? null : label(cwd))).every((l) => l[0] !== 'alpha' && l[1] !== 'alpha'));

console.log('\nlocal days');
ok('local day of a moment', D.localDayKey(new Date(2026, 8, 22, 1, 30)) === '2026-09-22');
ok('runs across a month end', D.dayRuns(['2026-08-30', '2026-08-31', '2026-09-01']).longest === 3);
ok('a gap resets the current run', (() => { const r = D.dayRuns(['2026-09-01', '2026-09-02', '2026-09-05']); return r.longest === 2 && r.current === 1; })());
ok('duplicates and junk do not count', D.dayRuns(['2026-09-01', '2026-09-01', 'junk']).longest === 1);
ok('no days, no run', D.dayRuns([]).longest === 0);
ok('an hour key converts to the local hour', D.localHourOf('2026-09-22T10') === new Date(Date.UTC(2026, 8, 22, 10)).getHours());
ok('a malformed hour key is -1', D.localHourOf('nope') === -1);

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
