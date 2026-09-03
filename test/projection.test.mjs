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

const { toWire, fromWire, WIRE_VERSION } = await load('src/shared/projection-wire.ts');
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

console.log(`\n${pass} passed, ${fail} failed\n`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
