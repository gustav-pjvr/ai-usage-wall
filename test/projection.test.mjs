/**
 * Projection tests.
 *
 * Separate from run.mjs because the leak test is the single most important
 * assertion in this feature and it deserves to be findable. If this file fails,
 * something that identifies the user is on its way to a network socket.
 *
 *   node test/projection.test.mjs
 */

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-projection-'));
const require = createRequire(import.meta.url);

async function load(entry) {
  const out = path.join(tmp, path.basename(entry, '.ts') + '.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'error',
  });
  return require(out);
}

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

const { toWire, fromWire, frameKey, WIRE_VERSION } = await load('src/shared/projection-wire.ts');
const { labelProjects } = await load('src/shared/project-label.ts');

/*
 * An index shaped like a real one, salted with every kind of thing that must
 * never travel: absolute paths on both platforms, the Windows username, session
 * UUIDs, and an OS error string that names the transcript folder.
 *
 * The string literals are built rather than written inline so the test file
 * itself is readable, and so a backslash cannot be lost to an editor.
 */
const WINPATH = ['C:', 'Users', 'HP 865 G10', 'Desktop', 'Claude WorkSpace', 'muchbetter-client-wall'].join('\\');
const SECRET = ['C:', 'Users', 'HP 865 G10', 'Desktop', 'secret-client-work'].join('\\');
const CLAUDE_DIR = ['C:', 'Users', 'HP 865 G10', '.claude', 'projects'].join('\\');
const SESSION_UUID = '9f1c2b7e-1111-4aaa-9bbb-0123456789ab';

const T = (r) => ({
  input: r,
  output: r,
  cacheCreate: 0,
  cacheRead: 0,
  thinking: 0,
  requests: r,
  webSearch: 0,
  webFetch: 0,
  // Added when the cost stat shipped. The "totals survive exactly" assertion
  // below is an exact JSON comparison, so it failed the moment the wire gained
  // these two, which is the assertion doing its job.
  costUsd: r * 0.001,
  unpricedTokens: 0,
});

const index = {
  version: 2,
  builtAt: '2026-09-03T08:00:00.000Z',
  files: { [CLAUDE_DIR + '\\a.jsonl']: { size: 10, offset: 10 }, [CLAUDE_DIR + '\\b.jsonl']: { size: 20, offset: 20 } },
  totals: T(6),
  daily: { '2026-09-01': T(1) },
  hourly: { '2026-09-01T08': T(1) },
  models: { 'claude-opus-5': T(1) },
  projects: {
    [WINPATH.toLowerCase()]: { ...T(5), lastSeen: '2026-09-03T07:00:00.000Z', display: WINPATH },
    '/home/gustav/work/atlas': { ...T(3), lastSeen: '2026-09-02T07:00:00.000Z', display: '/home/gustav/work/atlas' },
  },
  sessions: {
    [SESSION_UUID]: {
      id: SESSION_UUID,
      start: '2026-09-03T07:00:00.000Z',
      end: '2026-09-03T08:00:00.000Z',
      requests: 4,
      output: 9,
      total: 90,
      cwd: SECRET,
      models: ['claude-opus-5'],
    },
  },
  recent: [
    [Date.now() - 1000, 20, 5],
    [Date.now() - 60 * 60 * 1000, 30, 6],
  ],
  prompts: { total: 12, daily: { '2026-09-01': 3 }, lastAt: '2026-09-03T07:59:00.000Z', offset: 999, size: 1000 },
  latest: {
    ts: '2026-09-03T07:59:00.000Z',
    model: 'claude-opus-5',
    sessionId: SESSION_UUID,
    version: '2.1.258',
    cwd: WINPATH,
  },
  lastScanMs: 42,
  unavailable: true,
  unavailableReason: 'ENOENT: cannot read ' + CLAUDE_DIR,
};

console.log('\nprojection wire: nothing identifying may reach the network');
{
  const wire = toWire(index, { shareProjectNames: true, sourceLabel: 'Main machine', indexing: false });
  const json = JSON.stringify(wire);

  ok('no backslash path separator survives', !json.includes('\\'));
  ok('no POSIX home path survives', !json.includes('/home/') && !json.includes('/Users/'));
  ok('the Windows username does not survive', !json.includes('HP 865'));
  ok('the .claude folder is never named', !json.includes('.claude'));
  ok('no session UUID survives', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(json));
  ok('no drive letter survives', !/[a-z]:/i.test(json));
  ok('the folder of unrelated client work does not survive', !json.includes('secret-client-work'));
  ok('the OS error reason is replaced, not forwarded', wire.unavailableReason === 'the source cannot read its transcripts');
  ok('prompt file bookkeeping is dropped', wire.prompts.offset === undefined && wire.prompts.size === undefined);
  ok('latest keeps no session id and no cwd', wire.latest.sessionId === undefined && wire.latest.cwd === undefined);
  ok('the transcript file list is dropped', wire.files === undefined && wire.fileCount === 2);

  console.log('\n  and the numbers still have to be right');
  ok('projects are keyed by label', Object.keys(wire.projects).sort().join(',') === 'atlas,muchbetter-client-wall');
  ok('project totals survive relabelling', wire.projects.atlas.requests === 3 && wire.projects['muchbetter-client-wall'].requests === 5);
  ok('latest project becomes a label', wire.latest.project === 'muchbetter-client-wall');
  ok('sessions are re-keyed by index', Object.keys(wire.sessions).join(',') === '0');
  ok('session shape survives', wire.sessions['0'].requests === 4 && wire.sessions['0'].total === 90);
  ok('totals survive exactly', JSON.stringify(wire.totals) === JSON.stringify(index.totals));
  ok('the wire version is stamped', wire.v === WIRE_VERSION);

  console.log('\n  opting out of project names');
  const shy = toWire(index, { shareProjectNames: false, sourceLabel: '', indexing: false });
  ok('no projects are sent at all', Object.keys(shy.projects).length === 0 && shy.projectsShared === false);
  ok('the totals still arrive', shy.totals.requests === 6);
  ok('and nothing leaks by another route', !JSON.stringify(shy).includes('HP 865'));
  ok('latest.project is null when sharing is off, whatever folder is open now', shy.latest.project === null);

  console.log('\n  the safe direction to fail in');
  const sneaky = toWire(
    { ...index, someFutureField: WINPATH },
    { shareProjectNames: true, sourceLabel: '', indexing: false },
  );
  ok('a field added to the index later is NOT forwarded', !JSON.stringify(sneaky).includes('HP 865'));

  console.log('\n  round trip');
  const back = fromWire(wire);
  ok('fromWire restores the shape the renderer expects', back.totals.requests === 6 && Object.keys(back.projects).length === 2);
  ok('the indexing flag crosses the wire (rule 15)',
     fromWire(toWire(index, { shareProjectNames: true, sourceLabel: '', indexing: true })).indexing === true);
  ok('fromWire reintroduces no path', !JSON.stringify(back).includes('HP 865'));
}

console.log('\nthe home directory is never a label');
{
  const HOME = ['C:', 'Users', 'HP 865 G10'].join('\\');
  const homeIndex = {
    ...index,
    projects: {
      [HOME.toLowerCase()]: { ...T(2), lastSeen: '2026-09-03T07:00:00.000Z', display: HOME },
      [(HOME + '\\notes').toLowerCase()]: { ...T(1), lastSeen: '2026-09-02T07:00:00.000Z', display: HOME + '\\notes' },
      'd:\\other\\notes': { ...T(1), lastSeen: '2026-09-01T07:00:00.000Z', display: 'D:\\other\\notes' },
    },
    latest: { ...index.latest, cwd: HOME },
  };
  // Passed in a different case from the path on purpose: index keys are
  // lowercased and display strings are not, so the comparison must not care.
  const w = toWire(homeIndex, { shareProjectNames: true, sourceLabel: '', indexing: false, homeDirName: 'hp 865 g10' });
  const labels = Object.keys(w.projects).sort().join(',');
  ok('a project run from the home folder is labelled home, not the username', w.projects.home?.requests === 2, labels);
  ok('a username parent prefix is masked too',
     w.projects['home / notes']?.requests === 1 && w.projects['other / notes']?.requests === 1, labels);
  ok('latest.project is masked the same way', w.latest.project === 'home', String(w.latest.project));
  ok('the username survives nowhere in the frame', !JSON.stringify(w).toLowerCase().includes('hp 865'));
}

console.log('\nproject labels');
{
  const paths = ['C:\\work\\alpha', 'C:\\work\\beta', 'D:\\other\\beta', '/home/x/gamma'];
  const m = labelProjects(paths);
  ok('a unique folder name is the label', m.get('C:\\work\\alpha') === 'alpha');
  ok('an ambiguous name gains its parent',
     m.get('C:\\work\\beta') === 'work / beta' && m.get('D:\\other\\beta') === 'other / beta');
  ok('POSIX paths label the same way', m.get('/home/x/gamma') === 'gamma');
  ok('labelling depends on the set, not the order',
     JSON.stringify([...labelProjects([...paths].reverse())].sort()) ===
       JSON.stringify([...m].sort()));
}

console.log('\nprojection: constellation links cross as labels only');
{
  const cwdA = 'C:\\Users\\hp 865 g10\\Desktop\\Claude WorkSpace\\alpha';
  const cwdB = 'C:\\Users\\hp 865 g10\\Desktop\\Claude WorkSpace\\bravo';
  const day = '2026-09-20T10:00:00.000Z';
  const linked = {
    ...index,
    projects: {
      [cwdA.toLowerCase()]: { ...index.totals, lastSeen: day, display: cwdA },
      [cwdB.toLowerCase()]: { ...index.totals, lastSeen: day, display: cwdB },
    },
    sessions: {
      '11111111-2222-3333-4444-555555555555': { id: 'x', start: day, end: day, requests: 1, output: 1, total: 1, cwd: cwdA, models: [] },
      '66666666-7777-8888-9999-000000000000': { id: 'y', start: day, end: day, requests: 1, output: 1, total: 1, cwd: cwdB, models: [] },
    },
  };
  const shared = toWire(linked, { shareProjectNames: true, sourceLabel: '', indexing: false, homeDirName: 'hp 865 g10' });
  ok('two projects on the same day produce one link', shared.projectLinks.length === 1 && shared.projectLinks[0][2] === 1,
     JSON.stringify(shared.projectLinks));
  ok('the link names the same labels the projects are keyed by',
     shared.projectLinks[0].slice(0, 2).every((l) => Object.keys(shared.projects).includes(l)));
  const linkJson = JSON.stringify(shared.projectLinks);
  ok('no path, backslash, username or session id in the links',
     !linkJson.includes('\\') && !/hp 865 g10/i.test(linkJson) && !/[0-9a-f]{8}-[0-9a-f]{4}/.test(linkJson), linkJson);

  const unshared = toWire(linked, { shareProjectNames: false, sourceLabel: '', indexing: false });
  ok('project names not shared: no links at all', Array.isArray(unshared.projectLinks) && unshared.projectLinks.length === 0);

  const back = fromWire({ ...shared, projectLinks: [...shared.projectLinks, ['ok', 5, 1], 'junk', ['a', 'b', 'NaN']] });
  ok('a screen drops malformed links rather than drawing them', back.projectLinks.length === 1, JSON.stringify(back.projectLinks));
  ok('a frame from an older source with no links becomes an empty list',
     Array.isArray(fromWire({ ...shared, projectLinks: undefined }).projectLinks));
}

console.log('\nprojection: skipping frames a screen would not see change');
{
  const opts = { shareProjectNames: true, sourceLabel: 'Main machine', indexing: false };
  const a = toWire(index, { ...opts, sentAt: 1_000 });
  const b = toWire({ ...index, lastScanMs: 97, builtAt: '2026-09-22T10:00:00.000Z' }, { ...opts, sentAt: 2_000 });

  // The bug: sentAt sits in the first 40 characters, so the whole-frame
  // comparison never matched and the skip never fired.
  ok('two builds of the same data differ as whole frames (why the old skip never fired)',
     JSON.stringify(a) !== JSON.stringify(b));
  ok('but have the same frame key, so the send is skipped', frameKey(a) === frameKey(b));

  // The trap the fix had to avoid: a change in the middle of the frame that
  // keeps the length. The old length-plus-ends "hash" could not see it.
  const before = structuredClone(a);
  const after = structuredClone(a);
  const day = Object.keys(before.daily)[0];
  before.daily[day].output = 1000;
  after.daily[day].output = 1001;
  ok('(fixture check: the change keeps the frame the same length)',
     JSON.stringify(before).length === JSON.stringify(after).length);
  ok('a same-length change in the middle of the frame changes the key', frameKey(before) !== frameKey(after));

  const liveChange = toWire({ ...index, recent: [...index.recent, [Date.now(), 5, 1]] }, opts);
  ok('new live records change the key', frameKey(a) !== frameKey(liveChange));
  ok('toggling project names changes the key',
     frameKey(a) !== frameKey(toWire(index, { ...opts, shareProjectNames: false })));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
