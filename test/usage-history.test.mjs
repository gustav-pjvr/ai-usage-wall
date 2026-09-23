/**
 * Totals must never drop: the history archive.
 *
 * 0.9.13 bumped INDEX_VERSION, the cache was discarded, and the rebuild could
 * only see the transcripts Claude Code had not yet deleted. The wall fell from
 * 39.35B tokens to 19.79B in one launch. These tests pin the fix: a transcript
 * that disappears has its numbers MOVED to the history store, and every
 * consumer reads the live index merged with that store.
 *
 * The first block is the regression and must fail on 0.9.13's behaviour.
 * Design: docs/design/history-archive.md.
 *
 *   node test/usage-history.test.mjs
 */

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-history-'));
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
const PROJECTS = path.join(HOME, 'projects');
process.env.MBW_CLAUDE_HOME = HOME;

const bundle = async (entry, name) => {
  const outfile = path.join(tmp, name);
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true, platform: 'node', format: 'cjs', outfile,
    external: ['electron'], logLevel: 'error',
  });
  return require(outfile);
};
const U = await bundle('src/main/data/usage.ts', 'usage.cjs');
const { mergeHistory } = await bundle('src/shared/usage-merge.ts', 'merge.cjs');
const W = await bundle('src/shared/projection-wire.ts', 'wire.cjs');
const MS = await bundle('src/shared/milestones.ts', 'milestones.cjs');
// Two copies of the store module: a second launch is a fresh module state.
const H1 = await bundle('src/main/data/history.ts', 'history1.cjs');
const H2 = await bundle('src/main/data/history.ts', 'history2.cjs');

const DAY = 86_400_000;
/** One assistant record, shaped like the real thing. */
const rec = (ms, sid, cwd, model, input, output, cacheRead) => JSON.stringify({
  type: 'assistant', timestamp: new Date(ms).toISOString(), sessionId: sid, cwd, version: '2.1.259',
  message: { model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead } },
}) + '\n';

const cwdA = path.join(tmp, 'Alpha');
const cwdB = path.join(tmp, 'Bravo');
const T0 = Date.now() - 40 * DAY;
const transcripts = {
  a: [path.join(PROJECTS, 'a', 'a.jsonl'), rec(T0, 'sa', cwdA, 'claude-opus-5', 10, 5, 1000) + rec(T0 + 60_000, 'sa', cwdA, 'claude-opus-5', 20, 7, 2000)],
  b: [path.join(PROJECTS, 'b', 'b.jsonl'), rec(T0 + 3 * DAY, 'sb', cwdB, 'claude-fable-5', 30, 9, 3000)],
  c: [path.join(PROJECTS, 'a', 'c.jsonl'), rec(Date.now() - DAY, 'sc', cwdA, 'claude-sonnet-5', 40, 11, 4000)],
};
const writeAll = async () => {
  for (const [f, body] of Object.values(transcripts)) {
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body, 'utf8');
  }
};

/**
 * Every map the wall shows, as a string to compare. Keys sorted and float sums
 * rounded, so neither insertion order nor summation order can matter.
 */
const shape = (m) => {
  const round = (v) => JSON.parse(JSON.stringify(v, (_k, x) => {
    if (typeof x === 'number') return Math.round(x * 1e6) / 1e6;
    if (x && typeof x === 'object' && !Array.isArray(x)) return Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)));
    return x;
  }));
  const sessions = Object.fromEntries(Object.entries(m.sessions).map(([id, s]) => [id, [s.requests, s.output, s.total]]));
  return JSON.stringify(round({ totals: m.totals, daily: m.daily, models: m.models, projects: m.projects, activeDays: m.activeDays, sessions }));
};

/** An in-memory port, for the cases the real store cannot be pushed into. */
function memPort({ ready = true, archiveOk = true } = {}) {
  const store = { entries: {}, seed: null, prompts: { total: 0, daily: {} } };
  const calls = { archive: 0 };
  return {
    store, calls,
    port: {
      get ready() { return ready; },
      has: (p) => ready && p in store.entries,
      async archive(list) {
        calls.archive++;
        if (!archiveOk) return false;
        for (const e of list) store.entries[e.path] = { archivedAt: '', reason: e.reason, contrib: e.contrib };
        return true;
      },
      async release(paths) { for (const p of paths) delete store.entries[p]; return true; },
      async archivePrompts(lost) {
        for (const [d, n] of Object.entries(lost)) {
          store.prompts.daily[d] = (store.prompts.daily[d] || 0) + n;
          store.prompts.total += n;
        }
        return true;
      },
    },
  };
}

console.log('\n1. the regression: a deleted transcript and an index version bump');
{
  await writeAll();
  const userData = path.join(tmp, 'userData');
  await H1.loadHistory(userData);
  const port = H1.historyPort();
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: port });
  const before = shape(mergeHistory(index, H1.currentHistory()));

  await fs.rm(transcripts.b[0]);
  ({ index } = await U.refreshIndex(index, undefined, { history: port }));
  const merged = mergeHistory(index, H1.currentHistory());
  ok('after a deletion, every merged map equals the original', shape(merged) === before, `${shape(merged)}\n  vs ${before}`);
  ok('the deleted transcript is archived, once', merged.history.archivedFiles === 1);
  ok('and the live index only counts what is on disk', Object.keys(index.files).length === 2 && !index.files[transcripts.b[0]]);

  // The 0.9.13 event: the cache is from another version.
  const cache = path.join(tmp, 'cache.json');
  await U.saveIndex(cache, { ...index, version: U.INDEX_VERSION - 1 });
  // A fresh launch: the store is read again from disk by a new module.
  await H2.loadHistory(userData);
  const loaded = await U.loadIndex(cache);
  ok('an old-version cache is discarded but hands back its contributions',
    loaded.index.totals.requests === 0 && Object.keys(loaded.staleFiles).length === 2);
  const again = await U.refreshIndex(loaded.index, undefined, { history: H2.historyPort(), staleFiles: loaded.staleFiles });
  const relaunched = mergeHistory(again.index, H2.currentHistory());
  ok('after a version bump, every merged map still equals the original', shape(relaunched) === before);
  ok('the store survived the relaunch on disk', relaunched.history.archivedFiles === 1);
  ok('the session count did not fall', Object.keys(relaunched.sessions).length === 3);

  // Without the store (0.9.13's behaviour) the same sequence loses b.
  const bare = await U.refreshIndex((await U.loadIndex(cache)).index);
  ok('control: without history the rebuild loses the deleted transcript', shape(bare.index) !== before);
}

console.log('\n2. delete, then restore from a backup');
{
  await fs.rm(PROJECTS, { recursive: true, force: true });
  await writeAll();
  const m = memPort();
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port });
  const before = shape(mergeHistory(index, m.store));
  await fs.rm(transcripts.c[0]);
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  await fs.writeFile(transcripts.c[0], transcripts.c[1], 'utf8');
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  ok('restored: merged totals equal the originals, never counted twice', shape(mergeHistory(index, m.store)) === before);
  ok('and history no longer holds it', Object.keys(m.store.entries).length === 0);
}

console.log('\n3. a shrunk transcript and a deleted one in the same pass');
{
  await fs.rm(PROJECTS, { recursive: true, force: true });
  await writeAll();
  const m = memPort();
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port });
  const reqBefore = index.totals.requests;
  await fs.rm(transcripts.b[0]);
  // a loses its second record: a genuine rewrite, which the index must honour.
  await fs.writeFile(transcripts.a[0], transcripts.a[1].split('\n')[0] + '\n', 'utf8');
  const r = await U.refreshIndex(index, undefined, { history: m.port });
  const merged = mergeHistory(r.index, m.store);
  ok('the deleted transcript is kept through the rebuild', Object.keys(m.store.entries).length === 1 && r.rebuilt);
  ok('only the rewritten record is gone', merged.totals.requests === reqBefore - 1, `${merged.totals.requests} vs ${reqBefore - 1}`);
}

console.log('\n4. not on the listing is not the same as gone');
{
  await fs.rm(PROJECTS, { recursive: true, force: true });
  await writeAll();
  const m = memPort();
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port });
  // A path the listing does not return but that still exists (a folder the
  // listing could not read looks exactly like this).
  const hidden = path.join(PROJECTS, 'a', 'still-here.txt');
  await fs.writeFile(hidden, 'x', 'utf8');
  index.files[hidden] = { size: 1, offset: 1, contrib: U.emptyContrib() };
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  ok('an existing file is never archived', m.calls.archive === 0 && Object.keys(m.store.entries).length === 0);
}

console.log('\n5. history unreadable at launch');
{
  await fs.rm(PROJECTS, { recursive: true, force: true });
  await writeAll();
  const m = memPort({ ready: false });
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port });
  const before = shape(index);
  await fs.rm(transcripts.b[0]);
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  ok('nothing is archived or removed: the index keeps counting it', shape(index) === before && m.calls.archive === 0);
  ok('the deleted path stays in the index until the store can take it', !!index.files[transcripts.b[0]]);
}

console.log('\n6. write order: history first');
{
  await fs.rm(PROJECTS, { recursive: true, force: true });
  await writeAll();
  const m = memPort({ archiveOk: false });
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port });
  const before = shape(index);
  await fs.rm(transcripts.b[0]);
  const r = await U.refreshIndex(index, undefined, { history: m.port });
  ok('a failed history save leaves the contribution in the index', !!r.index.files[transcripts.b[0]]?.contrib && !r.rebuilt);
  ok('and the totals unchanged', shape(r.index) === before);
}

console.log('\n7. the seed');
{
  const z = () => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0, thinking: 0, requests: 0, webSearch: 0, webFetch: 0, costUsd: 0, unpricedTokens: 0 });
  const live = { ...U.emptyIndex(), totals: { ...z(), cacheRead: 100, requests: 1 } };
  const liveCopy = JSON.stringify(live);
  const seed = {
    source: 'a snapshot of 22 Sep 2026', totals: { ...z(), cacheRead: 1000, requests: 10, costUsd: 5 },
    daily: { '2026-07-01': { ...z(), cacheRead: 1000, requests: 10 } }, models: { 'claude-opus-5': { ...z(), cacheRead: 700 } },
    projects: { 'c:\\x\\travel game': { ...z(), cacheRead: 600, lastSeen: '2026-08-12', display: 'C:\\x\\Travel Game' } },
    activeDays: { '2026-07-01': 1 }, sessionCount: 52, transcriptCount: 349, prompts: { total: 0, daily: {} },
  };
  const m = mergeHistory(live, { entries: {}, seed, prompts: { total: 0, daily: {} } });
  ok('totals add', m.totals.cacheRead === 1100 && m.totals.requests === 11 && m.totals.costUsd === 5);
  ok('the unattributed remainder is counted and named', m.history.unattributedTokens === 400 &&
    Object.values(m.projects).reduce((n, p) => n + p.cacheRead, 0) === 600);
  ok('sessions are a count, never placeholders', m.history.reconstructedSessions === 52 && Object.keys(m.sessions).length === 0);
  ok('the live index is not mutated', JSON.stringify(live) === liveCopy);
}

console.log('\n8. the wire');
{
  const merged = mergeHistory(U.emptyIndex(), { entries: {}, seed: {
    source: 'a snapshot of 22 Sep 2026', totals: { input: 0, output: 1, cacheCreate: 0, cacheRead: 9, thinking: 0, requests: 2, webSearch: 0, webFetch: 0, costUsd: 1, unpricedTokens: 0 },
    daily: {}, models: {}, projects: {}, activeDays: {}, sessionCount: 3, transcriptCount: 4, prompts: { total: 0, daily: {} } }, prompts: { total: 0, daily: {} } });
  const w = W.toWire(merged, { shareProjectNames: true, homeDirName: 'someone' });
  const back = W.fromWire(JSON.parse(JSON.stringify(w)));
  ok('history crosses, named field by field', w.history?.reconstructedSessions === 3 && w.history?.reconstructed.cacheRead === 9);
  ok('and round-trips', JSON.stringify(back.history) === JSON.stringify(w.history));
  const leaky = W.toWire({ ...merged, history: { ...merged.history, reconstructedFrom: 'C:\\Users\\someone\\snap.png' } }, { shareProjectNames: true });
  ok('a source phrase that looks like a path is dropped', leaky.history.reconstructedFrom === null);
  ok('an index without history sends no history field', !('history' in W.toWire(U.emptyIndex(), { shareProjectNames: true })));
}

console.log('\n9. milestones');
{
  const input = (processed) => ({ processed, generated: 0, requests: 0, models: [], activeDays: [], sessions: [] });
  let r = MS.evaluate(input(2e9), null);
  const seeded = MS.evaluate(input(30e9), r.ledger, Date.now(), true);
  ok('rungs crossed only by the seed are recorded as earlier, never announced',
    seeded.fresh.length === 0 && seeded.ledger.achieved['processed:25B']?.seeded === true && seeded.ledger.unseen.length === 0,
    JSON.stringify(Object.keys(seeded.ledger.achieved)));
  const live = MS.evaluate(input(51e9), seeded.ledger);
  ok('a rung crossed live afterwards announces once', live.fresh.length === 1 && live.fresh[0].key === 'processed:50B');
}

console.log('\n10. a cv 1 contribution from an older cache archives');
{
  await fs.rm(PROJECTS, { recursive: true, force: true });
  await writeAll();
  const fixture = {
    cv: 1, totals: { input: 1, output: 2, cacheCreate: 0, cacheRead: 3, thinking: 0, requests: 1, webSearch: 0, webFetch: 0, costUsd: 0.5, unpricedTokens: 0 },
    daily: {}, models: {}, projects: {}, sessions: {}, activeDays: {},
  };
  const gonePath = path.join(PROJECTS, 'old', 'deleted-long-ago.jsonl');
  const m = memPort();
  await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port, staleFiles: { [gonePath]: fixture } });
  ok('archived as stale-cache', m.store.entries[gonePath]?.reason === 'stale-cache' && m.store.entries[gonePath].contrib.totals.requests === 1);
}

console.log('\n11. history.jsonl rewritten shorter');
{
  const HF = path.join(HOME, 'history.jsonl');
  const p = (ms) => JSON.stringify({ display: 'x', timestamp: ms }) + '\n';
  const d1 = Date.UTC(2026, 6, 1, 12), d2 = Date.UTC(2026, 8, 20, 12);
  await fs.writeFile(HF, p(d1) + p(d1) + p(d2), 'utf8');
  const m = memPort();
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port });
  const before = mergeHistory(index, m.store).prompts;
  await fs.writeFile(HF, p(d2), 'utf8');
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  ok('a shrink seen once is not acted on yet', index.prompts.total === 3 && m.store.prompts.total === 0);
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  const after = mergeHistory(index, m.store).prompts;
  ok('the prompt total does not fall', after.total === before.total && before.total === 3, `${after.total} vs ${before.total}`);
  ok('nor any day', after.daily['2026-07-01'] === 2 && after.daily['2026-09-20'] === 1, JSON.stringify(after.daily));
}

console.log('\n12. a failed archive, then a shrink rebuild in the same pass (review defect 1)');
{
  await fs.rm(PROJECTS, { recursive: true, force: true });
  await writeAll();
  const m = memPort({ archiveOk: false });
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port });
  const reqBefore = index.totals.requests;
  await fs.rm(transcripts.b[0]);
  await fs.writeFile(transcripts.a[0], transcripts.a[1].split('\n')[0] + '\n', 'utf8');
  const r = await U.refreshIndex(index, undefined, { history: m.port });
  ok('the unarchived file is carried through the rebuild with its numbers',
    r.rebuilt && !!r.index.files[transcripts.b[0]] && r.index.totals.requests === reqBefore - 1,
    `${r.index.totals.requests} vs ${reqBefore - 1}`);
  ok('and its session survives', !!r.index.sessions.sb);
}

console.log('\n13. history.jsonl caught mid-rewrite (review defects 2 and 3)');
{
  const HF = path.join(HOME, 'history.jsonl');
  const p = (ms) => JSON.stringify({ display: 'x', timestamp: ms }) + '\n';
  const d1 = Date.UTC(2026, 6, 1, 12), d2 = Date.UTC(2026, 8, 20, 12);
  await fs.writeFile(HF, p(d1) + p(d1) + p(d2), 'utf8');
  const m = memPort();
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port });
  await fs.writeFile(HF, '', 'utf8'); // truncated, not yet rewritten
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  ok('seen at 0 bytes: nothing dropped, nothing archived', index.prompts.total === 3 && m.store.prompts.total === 0);
  await fs.writeFile(HF, p(d2) + p(d2), 'utf8'); // the writer finishes: one day kept, one new prompt
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  const merged = mergeHistory(index, m.store).prompts;
  ok('once it holds still: the trimmed day archived once, the new prompt counted once',
    merged.total === 4 && merged.daily['2026-07-01'] === 2 && merged.daily['2026-09-20'] === 2 && m.store.prompts.total === 2,
    JSON.stringify({ merged, stored: m.store.prompts }));
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  ok('and a further pass adds nothing', mergeHistory(index, m.store).prompts.total === 4);
}

console.log('\n14. unsettled stale contributions survive a restart (review defect 4)');
{
  const cache = path.join(tmp, 'pending-cache.json');
  const c = { cv: 1, totals: { input: 1, output: 0, cacheCreate: 0, cacheRead: 0, thinking: 0, requests: 1, webSearch: 0, webFetch: 0, costUsd: 0, unpricedTokens: 0 },
    daily: {}, models: {}, projects: {}, sessions: {}, activeDays: {} };
  await U.saveIndex(cache, { ...U.emptyIndex(), pendingStale: { 'x.jsonl': c } });
  const loaded = await U.loadIndex(cache);
  ok('handed back as staleFiles, not left in the index', loaded.staleFiles['x.jsonl']?.totals.requests === 1 && !('pendingStale' in loaded.index));
}

console.log('\n15. a store that does not parse is left alone (review defect 5)');
{
  const H3 = await bundle('src/main/data/history.ts', 'history3.cjs');
  const dir = path.join(tmp, 'broken');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'usage-history.json'), '{"v":1,"entries":{', 'utf8');
  await H3.loadHistory(dir);
  const port = H3.historyPort();
  ok('the store stays unloaded, so nothing is archived over it', port.ready === false);
  ok('and the file is untouched', (await fs.readFile(path.join(dir, 'usage-history.json'), 'utf8')) === '{"v":1,"entries":{' &&
    (await fs.readdir(dir)).length === 1);
  ok('an archive attempt is refused', (await port.archive([{ path: 'p', contrib: {}, reason: 'deleted' }])) === false);
}

console.log('\n16. a deleted transcript keeps its curve (the any-day time-lapse)');
{
  const ID = await bundle('src/shared/intraday.ts', 'intraday.cjs');
  await fs.rm(PROJECTS, { recursive: true, force: true });
  // Three transcripts on one day, two of them in the same five-minute slot.
  const day0 = new Date(Date.now() - 5 * DAY);
  day0.setHours(14, 2, 0, 0);
  const t = day0.getTime();
  const files = [
    [path.join(PROJECTS, 'a', 'd1.jsonl'), rec(t, 's1', cwdA, 'claude-opus-5', 10, 5, 1000) + rec(t + 20 * 60_000, 's1', cwdA, 'claude-opus-5', 1, 1, 1)],
    [path.join(PROJECTS, 'b', 'd2.jsonl'), rec(t + 60_000, 's2', cwdB, 'claude-opus-5', 30, 9, 3000)],
    [path.join(PROJECTS, 'a', 'd3.jsonl'), rec(t + 3 * 3_600_000, 's3', cwdA, 'claude-opus-5', 40, 11, 4000)],
  ];
  for (const [p, body] of files) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body, 'utf8');
  }
  const m = memPort();
  let { index } = await U.refreshIndex(U.emptyIndex(), undefined, { history: m.port });
  const key = Object.keys(index.activeDays).find((d) => index.activeDays[d] === 4);
  const dayOf = () => {
    const merged = mergeHistory(index, m.store);
    const d = ID.collectDay(key, index.files, m.store.entries, merged.activeDays[key] ?? 0, 0);
    // Keys sorted, so the order transcripts were summed in cannot matter.
    const cells = Object.keys(d.projects).sort().map((k) => [k, Object.entries(d.projects[k].cells).sort()]);
    return JSON.stringify({ requests: d.requests, shaped: d.shapedRequests, cells });
  };
  const before = ID.collectDay(key, index.files, m.store.entries, index.activeDays[key], 0);
  ok('the day is fully detailed while every transcript is on disk', !!key && before.shapedRequests === 4 && before.requests === 4,
     JSON.stringify(before));
  const snapshot = dayOf();
  await fs.rm(files[1][0]);
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  ok('the deleted transcript was archived with its slots', !!m.store.entries[files[1][0]]?.contrib.intraday?.[key]);
  ok('the day sums to exactly the same curve after the deletion', dayOf() === snapshot, `${dayOf()}\n  vs ${snapshot}`);
  const offered = ID.offeredDays(mergeHistory(index, m.store).activeDays, index.files, m.store.entries);
  ok('and the picker still offers it as fully detailed', ID.dayShape(offered.days[key]) === 'full', JSON.stringify(offered.days[key]));
  await fs.writeFile(files[1][0], files[1][1], 'utf8');
  ({ index } = await U.refreshIndex(index, undefined, { history: m.port }));
  ok('restored from a backup: counted once, not twice', dayOf() === snapshot && Object.keys(m.store.entries).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
await fs.rm(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
