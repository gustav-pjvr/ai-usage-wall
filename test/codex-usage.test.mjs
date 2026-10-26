/**
 * Codex usage: the second index (src/main/data/codex-usage.ts), its prices,
 * its history store and its wire block.
 *
 * Fixture rollouts are shaped like the real ones in ~/.codex/sessions
 * (docs/design/codex-side-by-side.md section 1), with no message text: the
 * reader must never need any.
 *
 *   node test/codex-usage.test.mjs
 */

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'csw-codex-'));
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
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
/** Keys sorted and float sums rounded, so neither insertion nor summation order can matter. */
const canon = (v) => JSON.stringify(v, (_k, x) => {
  if (typeof x === 'number') return Math.round(x * 1e9) / 1e9;
  if (x && typeof x === 'object' && !Array.isArray(x)) return Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)));
  return x;
});

// Never the real ~/.codex, even if a test forgets to pass `dir`.
process.env.MBW_CODEX_HOME = path.join(tmp, 'no-codex-here');

const bundle = async (entry, name) => {
  const outfile = path.join(tmp, name);
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true, platform: 'node', format: 'cjs', outfile,
    external: ['electron'], logLevel: 'error',
  });
  return require(outfile);
};
const C = await bundle('src/main/data/codex-usage.ts', 'codex1.cjs');
const C2 = await bundle('src/main/data/codex-usage.ts', 'codex2.cjs');
const P = await bundle('src/shared/pricing.ts', 'pricing.cjs');
const W = await bundle('src/shared/projection-wire.ts', 'wire.cjs');
const I = await bundle('src/shared/intraday.ts', 'intraday.cjs');

// ── Fixture lines ──────────────────────────────────────────────────────────

let ordinal = 0;
/** Real ids share a per-session head and end in random hex; the same name gives the same id. */
const respId = (name) => 'resp_06c30b4d2' + createHash('sha256').update(name).digest('hex').slice(0, 40);
const line = (ms, type, payload) => JSON.stringify({ timestamp: new Date(ms).toISOString(), ordinal: ordinal++, type, payload }) + '\n';
const meta = (ms, id, cwd, originator) => line(ms, 'session_meta', {
  id, session_id: id, cwd, originator, cli_version: '0.164.0', base_instructions: { text: 'SECRET INSTRUCTIONS' },
});
const turn = (ms, model, cwd) => line(ms, 'turn_context', { turn_id: 't', cwd, model, effort: 'high' });
const usage = (ms, sid, rid, input, cached, output, reasoning = 0, write = 0) => line(ms, 'token_usage_record', {
  thread_id: sid, session_id: sid, response_id: respId(rid),
  usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output },
});
const limits = (ms, id, primary, secondary, plan = 'plus') => line(ms, 'event_msg', {
  type: 'token_count', info: null,
  rate_limits: { limit_id: id, limit_name: null, primary, secondary, plan_type: plan },
});
const message = (ms) => line(ms, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE PROMPT "type":"token_usage_record" "rate_limits"' }] });

const tokensOf = (t) => t.input + t.output + t.cacheCreate + t.cacheRead;
const DAY = 86_400_000;

/** A fresh sessions folder. */
let caseNo = 0;
async function sessionsDir() {
  const d = path.join(tmp, `case${++caseNo}`, 'sessions');
  await fs.mkdir(path.join(d, '2026', '10', '26'), { recursive: true });
  return d;
}
const rollout = (dir, name) => path.join(dir, '2026', '10', '26', `rollout-${name}.jsonl`);

/** An in-memory history port, like usage-history.test.mjs's. */
function memPort({ ready = true } = {}) {
  const entries = {};
  return {
    entries,
    port: {
      get ready() { return ready; },
      has: (p) => ready && p in entries,
      async archive(list) { for (const e of list) entries[e.path] = { archivedAt: '', reason: e.reason, contrib: e.contrib }; return true; },
      async release(paths) { for (const p of paths) delete entries[p]; return true; },
      async archivePrompts() { return true; },
    },
  };
}

const T = Date.now() - 2 * 3600_000;

// ── 1. Normalisation ───────────────────────────────────────────────────────

console.log('\nnormalisation: cached tokens are INSIDE OpenAI input_tokens');
{
  const dir = await sessionsDir();
  const f = rollout(dir, 'norm');
  await fs.writeFile(f, meta(T, 's-norm', 'C:\\Work\\Alpha', 'codex_exec') + turn(T + 1, 'gpt-6-astra', 'C:\\Work\\Alpha') +
    message(T + 2) + usage(T + 3, 's-norm', 'resp_norm_000000000000000000000001', 1000, 800, 100, 30, 0));
  const { index } = await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir });
  const t = index.totals;
  ok('fresh input is input minus cached', t.input === 200, String(t.input));
  ok('cache reads are the cached tokens', t.cacheRead === 800);
  ok('output stays output (reasoning already inside)', t.output === 100);
  ok('thinking is the reasoning count, not added to output', t.thinking === 30);
  ok('one request per token_usage_record', t.requests === 1);
  ok('tokens processed count cached input once', tokensOf(t) === 1100, String(tokensOf(t)));
  ok('cost at gpt-6-astra list prices', near(t.costUsd, (200 * 10 + 800 * 1 + 100 * 50) / 1e6), String(t.costUsd));
  ok('the model comes from turn_context', Object.keys(index.models).join() === 'gpt-6-astra');
  ok('the project is the lowercased cwd, display as written', index.projects['c:\\work\\alpha']?.display === 'C:\\Work\\Alpha');
  ok('the whole file was consumed', index.files[f].offset === (await fs.stat(f)).size);
  const cache = JSON.stringify(index);
  ok('no message text or instructions reach the index', !cache.includes('PRIVATE') && !cache.includes('SECRET'));
}

// ── 2. Model and cwd across an incremental read that starts mid-file ──────

console.log('\nincremental: model and cwd survive a read that starts mid-file, and a restart');
{
  const dir = await sessionsDir();
  const f = rollout(dir, 'mid');
  await fs.writeFile(f, meta(T, 's-mid', 'C:\\Work\\Bravo', 'codex-tui') + turn(T + 1, 'gpt-6.1-sol', 'C:\\Work\\Bravo\\sub') +
    usage(T + 2, 's-mid', 'resp_mid_00000000000000000000000001', 100, 0, 10));
  const first = (await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir })).index;
  const cacheFile = path.join(tmp, 'mid-cache.json');
  await C.saveCodexIndex(cacheFile, first);
  // A relaunch: a fresh module, the index from the cache only.
  const loaded = await C2.loadCodexIndex(cacheFile);
  ok('the cache loads at the current version with nothing stale', loaded.index.version === C2.CODEX_INDEX_VERSION && Object.keys(loaded.staleFiles).length === 0);
  await fs.appendFile(f, usage(T + 3, 's-mid', 'resp_mid_00000000000000000000000002', 200, 0, 20));
  const again = (await C2.refreshCodexIndex(loaded.index, undefined, { dir })).index;
  ok('a record appended with no turn_context of its own keeps the file\'s model',
    again.models['gpt-6.1-sol']?.requests === 2 && !again.models.unknown, JSON.stringify(Object.keys(again.models)));
  ok('and its cwd (turn_context beats session_meta)', again.projects['c:\\work\\bravo\\sub']?.requests === 2 && !again.projects['c:\\work\\bravo']);
  await fs.appendFile(f, turn(T + 4, 'gpt-6-luna', 'C:\\Work\\Charlie') + usage(T + 5, 's-mid', 'resp_mid_00000000000000000000000003', 50, 0, 5));
  const third = (await C2.refreshCodexIndex(again, undefined, { dir })).index;
  ok('a new turn_context switches the model for what follows', third.models['gpt-6-luna']?.requests === 1 && third.models['gpt-6.1-sol']?.requests === 2);
  ok('and the project', third.projects['c:\\work\\charlie']?.requests === 1);
}

// ── 3. Partial trailing line ───────────────────────────────────────────────

console.log('\npartial trailing line: never counted early, never counted twice');
{
  const dir = await sessionsDir();
  const f = rollout(dir, 'partial');
  await fs.writeFile(f, meta(T, 's-p', 'C:\\Work\\P', 'codex_exec') + turn(T + 1, 'gpt-6-astra', 'C:\\Work\\P') +
    usage(T + 2, 's-p', 'resp_p_000000000000000000000000001', 100, 0, 10));
  let index = (await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir })).index;
  const whole = usage(T + 3, 's-p', 'resp_p_000000000000000000000000002', 1000, 0, 100);
  // A complete JSON record whose newline has not been written yet.
  await fs.appendFile(f, whole.slice(0, -1));
  const sizeBefore = (await fs.stat(f)).size;
  index = (await C.refreshCodexIndex(index, undefined, { dir })).index;
  ok('a record without its newline is not counted yet', index.totals.requests === 1, String(index.totals.requests));
  ok('and the offset stops before it', index.files[f].offset === sizeBefore - (whole.length - 1));
  // Half a record.
  await fs.appendFile(f, '\n' + usage(T + 4, 's-p', 'resp_p_000000000000000000000000003', 7, 0, 1).slice(0, 40));
  index = (await C.refreshCodexIndex(index, undefined, { dir })).index;
  ok('once the newline lands the record counts exactly once', index.totals.requests === 2 && index.totals.input === 1100, `${index.totals.requests} ${index.totals.input}`);
  await fs.appendFile(f, usage(T + 4, 's-p', 'resp_p_000000000000000000000000003', 7, 0, 1).slice(40));
  index = (await C.refreshCodexIndex(index, undefined, { dir })).index;
  ok('a half-written record counts once it is whole', index.totals.requests === 3 && index.totals.input === 1107, `${index.totals.requests} ${index.totals.input}`);
  const settled = JSON.stringify(index.totals);
  index = (await C.refreshCodexIndex(index, undefined, { dir })).index;
  ok('a pass with nothing new changes nothing', JSON.stringify(index.totals) === settled);
}

// ── 4. Duplicate-free counting ─────────────────────────────────────────────

console.log('\nduplicates: one response_id counts once, across files and archives');
{
  const dir = await sessionsDir();
  const a = rollout(dir, 'dup-a');
  const b = rollout(dir, 'dup-b');
  const shared = usage(T + 2, 's-a', 'resp_shared_00000000000000000000001', 500, 0, 50);
  await fs.writeFile(a, meta(T, 's-a', 'C:\\Work\\D', 'codex-tui') + turn(T + 1, 'gpt-6-astra', 'C:\\Work\\D') + shared);
  // A forked session that copied the earlier record, then did work of its own.
  await fs.writeFile(b, meta(T + 10, 's-b', 'C:\\Work\\D', 'codex-tui') + turn(T + 11, 'gpt-6-astra', 'C:\\Work\\D') + shared +
    usage(T + 12, 's-b', 'resp_own_0000000000000000000000001', 60, 0, 6));
  const h = memPort();
  let index = (await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir, history: h.port, archived: () => h.entries })).index;
  ok('the copied record is counted once', index.totals.requests === 2 && index.totals.input === 560, `${index.totals.requests} ${index.totals.input}`);
  await fs.rm(a);
  index = (await C.refreshCodexIndex(index, undefined, { dir, history: h.port, archived: () => h.entries })).index;
  const view = C.codexView(index, h.entries, { indexing: false });
  ok('after the first file is archived and the index rebuilt, still once',
    view.totals.requests === 2 && view.totals.input === 560, `${view.totals.requests} ${view.totals.input}`);
}

// ── 5. Deletion keeps numbers (history) ────────────────────────────────────

console.log('\ndeletion: a deleted rollout\'s numbers move to Codex\'s own history store');
{
  const dir = await sessionsDir();
  const userData = path.join(tmp, 'userdata-del');
  const files = [rollout(dir, 'del-1'), rollout(dir, 'del-2')];
  await fs.writeFile(files[0], meta(T, 's-d1', 'C:\\Work\\E', 'codex_exec') + turn(T + 1, 'gpt-6-astra', 'C:\\Work\\E') +
    usage(T + 60_000, 's-d1', 'resp_d1_00000000000000000000000001', 900, 400, 90) + usage(T + 120_000, 's-d1', 'resp_d1_00000000000000000000000002', 800, 300, 80));
  await fs.writeFile(files[1], meta(T + DAY / 2, 's-d2', 'C:\\Work\\F', 'T3 Code') + turn(T + DAY / 2, 'gpt-6-luna', 'C:\\Work\\F') +
    usage(T + DAY / 2 + 1000, 's-d2', 'resp_d2_00000000000000000000000001', 70, 0, 7));
  await C.codexHistory.load(userData);
  const port = C.codexHistory.port();
  const opts = { dir, history: port, archived: () => C.codexHistory.current().entries };
  let index = (await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, opts)).index;
  const before = C.codexView(index, C.codexHistory.current().entries, { indexing: false });
  await fs.rm(files[0]);
  const r = await C.refreshCodexIndex(index, undefined, opts);
  index = r.index;
  const after = C.codexView(index, C.codexHistory.current().entries, { indexing: false });
  ok('the deletion rebuilt the index', r.rebuilt === true);
  ok('the deleted file is in history, not the index', !index.files[files[0]] && port.has(files[0]));
  ok('totals do not move', canon(after.totals) === canon(before.totals), `${tokensOf(after.totals)} vs ${tokensOf(before.totals)}`);
  ok('nor daily, models, projects or active days',
    canon([after.daily, after.models, after.activeDays]) === canon([before.daily, before.models, before.activeDays]) &&
    tokensOf(after.projects['c:\\work\\e']) === tokensOf(before.projects['c:\\work\\e']));
  ok('the session and who started it are kept', after.sessions.total === 2 && after.sessions.byClaude === 1 && after.sessions.byT3 === 1, JSON.stringify(after.sessions));
  ok('the hours are kept', after.activeTime.seconds === before.activeTime.seconds && before.activeTime.seconds === 60, String(after.activeTime.seconds));
  const onDisk = JSON.parse(await fs.readFile(path.join(userData, 'codex-usage-history.json'), 'utf8'));
  ok('the store is its own file, codex-usage-history.json', !!onDisk.entries[files[0]]);
  ok('Claude\'s store file is never written', !(await fs.stat(path.join(userData, 'usage-history.json')).catch(() => null)));
  index = (await C.refreshCodexIndex(index, undefined, opts)).index;
  const twice = C.codexView(index, C.codexHistory.current().entries, { indexing: false });
  ok('another pass does not count the archive twice', canon(twice.totals) === canon(before.totals));

  // Unreadable store: nothing is archived, nothing removed, nothing lost.
  const bad = path.join(tmp, 'userdata-bad');
  await fs.mkdir(bad, { recursive: true });
  await fs.writeFile(path.join(bad, 'codex-usage-history.json'), '{ not json', 'utf8');
  const Cb = await bundle('src/main/data/codex-usage.ts', 'codex-bad.cjs');
  await Cb.codexHistory.load(bad);
  const badPort = Cb.codexHistory.port();
  ok('an unreadable store is not ready', badPort.ready === false);
  await fs.writeFile(files[0], meta(T, 's-d1', 'C:\\Work\\E', 'codex_exec') + turn(T + 1, 'gpt-6-astra', 'C:\\Work\\E') +
    usage(T + 60_000, 's-d1', 'resp_d1_00000000000000000000000001', 900, 400, 90));
  const dir2 = path.dirname(path.dirname(path.dirname(path.dirname(files[0]))));
  let bi = (await Cb.refreshCodexIndex(Cb.emptyCodexIndex(), undefined, { dir: dir2, history: badPort })).index;
  const badBefore = JSON.stringify(bi.totals);
  await fs.rm(files[0]);
  bi = (await Cb.refreshCodexIndex(bi, undefined, { dir: dir2, history: badPort })).index;
  ok('with an unreadable store a deleted file keeps counting', JSON.stringify(bi.totals) === badBefore && !!bi.files[files[0]]);
  ok('and the broken store is left exactly as it was', (await fs.readFile(path.join(bad, 'codex-usage-history.json'), 'utf8')) === '{ not json');
}

// ── 6. Version bump hands back contributions ───────────────────────────────

console.log('\nversion bump: contributions, pendingStale included, are handed back');
{
  const dir = await sessionsDir();
  const live = rollout(dir, 'bump-live');
  await fs.writeFile(live, meta(T, 's-bl', 'C:\\Work\\G', 'codex_exec') + turn(T + 1, 'gpt-6.1-sol', 'C:\\Work\\G') +
    usage(T + 2, 's-bl', 'resp_bl_00000000000000000000000001', 300, 100, 30));
  const goneA = path.join(dir, 'gone-a.jsonl');
  const goneB = path.join(dir, 'gone-b.jsonl');
  const contrib = (tokens, sid) => {
    const c = C.emptyCodexContrib();
    c.totals.input = tokens; c.totals.requests = 1;
    c.models['gpt-6-astra'] = { ...c.totals };
    c.origin[sid] = 'codex_exec';
    c.sessions[sid] = { id: sid, start: '2026-10-20T10:00:00.000Z', end: '2026-10-20T10:00:00.000Z', requests: 1, output: 0, total: tokens, cwd: null, models: ['gpt-6-astra'] };
    c.rids.push(sid.padEnd(24, '0'));
    return c;
  };
  const old = { ...C.emptyCodexIndex(), version: C.CODEX_INDEX_VERSION - 1,
    files: { [goneA]: { size: 1, offset: 1, contrib: contrib(1000, 's-ga'), state: { model: null, cwd: null, sid: null } } },
    pendingStale: { [goneB]: contrib(2000, 's-gb') } };
  const cacheFile = path.join(tmp, 'bump-cache.json');
  await fs.writeFile(cacheFile, JSON.stringify(old), 'utf8');
  const loaded = await C.loadCodexIndex(cacheFile);
  ok('the old cache is discarded', loaded.index.version === C.CODEX_INDEX_VERSION && Object.keys(loaded.index.files).length === 0);
  ok('its contributions are handed back', !!loaded.staleFiles[goneA]);
  ok('and so is what it was still holding in pendingStale', !!loaded.staleFiles[goneB], JSON.stringify(Object.keys(loaded.staleFiles)));
  const h = memPort();
  const { index } = await C.refreshCodexIndex(loaded.index, undefined, { dir, history: h.port, staleFiles: loaded.staleFiles, archived: () => h.entries });
  const view = C.codexView(index, h.entries, { indexing: false });
  ok('the first refresh archives both gone files', !!h.entries[goneA] && !!h.entries[goneB]);
  ok('so the total keeps all three', view.totals.input === 1000 + 2000 + 200, String(view.totals.input));
  ok('and their sessions', view.sessions.total === 3 && view.sessions.byClaude === 3, JSON.stringify(view.sessions));
}

// ── 7. Rate limit selection ────────────────────────────────────────────────

console.log('\nplan limits: the latest codex reading wins, premium ignored');
{
  const dir = await sessionsDir();
  const w = (pct, mins, resetSec) => ({ used_percent: pct, window_minutes: mins, resets_at: resetSec });
  const base = Date.parse('2026-10-26T09:00:00Z');
  await fs.writeFile(rollout(dir, 'lim-late'), meta(base, 's-l1', 'C:\\Work\\L', 'codex_exec') +
    limits(base + 10 * 60_000, 'codex', w(40, 300, 1793023200), w(10, 10080, 1793610000)) +
    limits(base + 39 * 60_000, 'codex', w(99, 300, 1793023200), w(16, 10080, 1793610000)) +
    limits(base + 50 * 60_000, 'premium', null, null) +
    limits(base + 51 * 60_000, 'codex', null, null));
  // Read after the other file, but an older reading: must not win.
  await fs.writeFile(rollout(dir, 'lim-old'), meta(base - DAY, 's-l2', 'C:\\Work\\L', 'codex_exec') +
    limits(base - DAY, 'codex', w(5, 300, 1792936800), w(2, 10080, 1793610000)));
  const { index } = await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir });
  const l = index.limits;
  ok('the latest codex reading is kept', l?.at === new Date(base + 39 * 60_000).toISOString(), l?.at);
  ok('five-hour and weekly windows', l?.fiveHour?.usedPercent === 99 && l?.weekly?.usedPercent === 16 && l?.fiveHour?.windowMinutes === 300);
  ok('resets_at seconds become epoch ms', l?.fiveHour?.resetsAt === 1793023200 * 1000);
  ok('the plan is kept', l?.plan === 'plus');
  ok('limitsOf ignores premium', C.limitsOf(JSON.parse(limits(base, 'premium', w(1, 1, 1), null))) === null);
  ok('limitsOf ignores a codex reading with no windows', C.limitsOf(JSON.parse(limits(base, 'codex', null, null))) === null);
  const view = C.codexView(index, {}, { indexing: false });
  ok('a folder with readings but no responses shows no Codex at all', view === null);
}

// ── 8. Originator counts ───────────────────────────────────────────────────

console.log('\nwho started each session');
{
  const dir = await sessionsDir();
  const mk = async (name, orig, i) => fs.writeFile(rollout(dir, name), meta(T + i, `s-o${i}`, 'C:\\Work\\O', orig) +
    turn(T + i, 'gpt-6-luna', 'C:\\Work\\O') + usage(T + i + 1, `s-o${i}`, `resp_o${i}`.padEnd(30, '0'), 10, 0, 1));
  await mk('o1', 'codex_exec', 1);
  await mk('o2', 'codex_exec', 2);
  await mk('o3', 'codex-tui', 3);
  await mk('o4', 'T3 Code', 4);
  await mk('o5', 'vscode', 5);
  // A session with no response at all still counts as a session.
  await fs.writeFile(rollout(dir, 'o6'), meta(T + 6, 's-o6', 'C:\\Work\\O', 'codex-tui'));
  const { index } = await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir });
  const s = C.codexView(index, {}, { indexing: false }).sessions;
  ok('codex_exec is Claude, codex-tui is you, T3 Code is T3, anything else other',
    s.total === 6 && s.byClaude === 2 && s.byYou === 2 && s.byT3 === 1 && s.other === 1, JSON.stringify(s));
}

// ── 9. Pricing ─────────────────────────────────────────────────────────────

console.log('\nprices: OpenAI list prices from the design doc, Claude unchanged');
{
  const M = 1e6;
  const all = { input: M, output: M, cacheRead: M, cacheWrite5m: M, cacheWrite1h: 0, webSearch: 0 };
  ok('gpt-6-astra 10 / 1 / 50, cache write 12.50', near(P.costOf('gpt-6-astra', all), 10 + 1 + 50 + 12.5));
  ok('gpt-6.1-sol 2 / 0.10 / 10, cache write 2.50', near(P.costOf('gpt-6.1-sol', all), 2 + 0.1 + 10 + 2.5));
  ok('gpt-6-luna 0.10 / 0.01 / 0.50, cache write 0.125', near(P.costOf('gpt-6-luna', all), 0.1 + 0.01 + 0.5 + 0.125));
  ok('a dated snapshot is the same model', near(P.costOf('gpt-6-astra-2026-10-01', all), 73.5));
  ok('gpt-6-sol is a different model and unpriced here', P.costOf('gpt-6-sol', all) === null);
  ok('gpt-reserve and codex-auto-review are unpriced', P.costOf('gpt-reserve', all) === null && P.costOf('codex-auto-review', all) === null);
  ok('a prefix is not a price', P.costOf('gpt-6-astra-mini', all) === null && P.costOf('gpt-6', all) === null);
  ok('the time of the record does not move an OpenAI price', near(P.costOf('gpt-6-astra', all, 0), 73.5) && near(P.costOf('gpt-6-astra', all, NaN), 73.5));
  ok('Claude Opus 5.5 keeps both its prices around REPRICED_AT',
    near(P.costOf('claude-opus-5-5', { ...all, cacheWrite5m: 0 }, P.REPRICED_AT - 1), 5 + 25 + 0.5) &&
    near(P.costOf('claude-opus-5-5', { ...all, cacheWrite5m: 0 }, P.REPRICED_AT + 1), 4 + 20 + 0.2));

  const dir = await sessionsDir();
  await fs.writeFile(rollout(dir, 'price'), meta(T, 's-pr', 'C:\\Work\\Q', 'codex_exec') +
    turn(T, 'gpt-6-astra', 'C:\\Work\\Q') + usage(T + 1, 's-pr', 'resp_pr_00000000000000000000000001', 243048, 240000, 2000, 500) +
    turn(T + 2, 'gpt-6.1-sol', 'C:\\Work\\Q') + usage(T + 3, 's-pr', 'resp_pr_00000000000000000000000002', 50000, 45000, 800) +
    turn(T + 4, 'gpt-6-luna', 'C:\\Work\\Q') + usage(T + 5, 's-pr', 'resp_pr_00000000000000000000000003', 90000, 89000, 300) +
    turn(T + 6, 'gpt-reserve', 'C:\\Work\\Q') + usage(T + 7, 's-pr', 'resp_pr_00000000000000000000000004', 1000, 500, 100));
  const { index } = await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir });
  const m = index.models;
  ok('astra record priced', near(m['gpt-6-astra'].costUsd, (3048 * 10 + 240000 * 1 + 2000 * 50) / M), String(m['gpt-6-astra'].costUsd));
  ok('sol record priced', near(m['gpt-6.1-sol'].costUsd, (5000 * 2 + 45000 * 0.1 + 800 * 10) / M), String(m['gpt-6.1-sol'].costUsd));
  ok('luna record priced', near(m['gpt-6-luna'].costUsd, (1000 * 0.1 + 89000 * 0.01 + 300 * 0.5) / M), String(m['gpt-6-luna'].costUsd));
  ok('an unknown model costs nothing and its tokens are unpriced, never zero',
    m['gpt-reserve'].costUsd === 0 && m['gpt-reserve'].unpricedTokens === 1100 && index.totals.unpricedTokens === 1100);
}

// ── 10. Hours ──────────────────────────────────────────────────────────────

console.log('\nhours: the same five-minute-stretch method as Claude');
{
  const dir = await sessionsDir();
  const t0 = Math.floor(T / 1000) * 1000;
  await fs.writeFile(rollout(dir, 'hours-a'), meta(t0, 's-h1', 'C:\\Work\\H', 'codex_exec') + turn(t0, 'gpt-6-luna', 'C:\\Work\\H') +
    usage(t0, 's-h1', 'resp_h1_00000000000000000000000001', 1, 0, 1) +
    usage(t0 + 120_000, 's-h1', 'resp_h1_00000000000000000000000002', 1, 0, 1) +
    usage(t0 + 240_000, 's-h1', 'resp_h1_00000000000000000000000003', 1, 0, 1) +
    // Ten minutes later: a new stretch, the gap counts nothing.
    usage(t0 + 840_000, 's-h1', 'resp_h1_00000000000000000000000004', 1, 0, 1) +
    usage(t0 + 900_000, 's-h1', 'resp_h1_00000000000000000000000005', 1, 0, 1));
  // A second session overlapping the first stretch: counted once.
  await fs.writeFile(rollout(dir, 'hours-b'), meta(t0, 's-h2', 'C:\\Work\\H', 'codex_exec') + turn(t0, 'gpt-6-luna', 'C:\\Work\\H') +
    usage(t0 + 60_000, 's-h2', 'resp_h2_00000000000000000000000001', 1, 0, 1) +
    usage(t0 + 180_000, 's-h2', 'resp_h2_00000000000000000000000002', 1, 0, 1));
  const { index } = await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir });
  const v = C.codexView(index, {}, { indexing: false });
  ok('240 s + 60 s of distinct working time', v.activeTime.seconds === 300, String(v.activeTime.seconds));
  ok('since the first response', v.activeTime.since === t0);
  ok('hourly buckets are UTC hours', Object.keys(v.hourly).every((k) => /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(k)) && Object.values(v.hourly).reduce((n, x) => n + x.requests, 0) === 7);
  ok('recent carries every response', v.recent.length === 7 && v.recent.every((r) => r.length === 3));
  ok('first and latest response times', v.firstAt === new Date(t0).toISOString() && v.latestAt === new Date(t0 + 900_000).toISOString());
}

// ── 11. Today slots ────────────────────────────────────────────────────────

console.log('\ntoday: 288 local five-minute slots, live and archived');
{
  const dir = await sessionsDir();
  const d = new Date();
  const ten = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0).getTime();
  const now = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).getTime();
  const fa = rollout(dir, 'today-a');
  const fb = rollout(dir, 'today-b');
  await fs.writeFile(fa, meta(ten, 's-t1', 'C:\\Work\\T', 'codex_exec') + turn(ten, 'gpt-6-luna', 'C:\\Work\\T') +
    usage(ten + 60_000, 's-t1', 'resp_t1_00000000000000000000000001', 1000, 600, 10) +
    usage(ten + 3 * 60_000, 's-t1', 'resp_t1_00000000000000000000000002', 500, 0, 5) +
    usage(ten - DAY, 's-t1', 'resp_t1_00000000000000000000000003', 99999, 0, 1));
  await fs.writeFile(fb, meta(ten, 's-t2', 'C:\\Work\\U', 'codex-tui') + turn(ten, 'gpt-6-luna', 'C:\\Work\\U') +
    usage(ten + 7 * 60_000, 's-t2', 'resp_t2_00000000000000000000000001', 200, 0, 2));
  const h = memPort();
  let index = (await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir, history: h.port, archived: () => h.entries })).index;
  let v = C.codexView(index, h.entries, { indexing: false, now });
  const slot10 = 10 * 12;
  ok('length 288', v.todaySlots.length === 288);
  ok('10:01 and 10:03 land in the 10:00 slot', v.todaySlots[slot10] === 1010 + 505, String(v.todaySlots[slot10]));
  ok('10:07 lands in the 10:05 slot', v.todaySlots[slot10 + 1] === 202);
  ok('yesterday is not today', v.todaySlots.reduce((a, b) => a + b, 0) === 1010 + 505 + 202);
  await fs.rm(fb);
  index = (await C.refreshCodexIndex(index, undefined, { dir, history: h.port, archived: () => h.entries })).index;
  v = C.codexView(index, h.entries, { indexing: false, now });
  ok('an archived rollout keeps its slots', v.todaySlots[slot10 + 1] === 202);
  ok('the shared helper is what Claude\'s lane uses too', I.todaySlotsOf(index.files, h.entries, now).join() === v.todaySlots.join());
  ok('a path in both live and archived gives no lane rather than a double one',
    I.todaySlotsOf({ x: index.files[fa] }, { x: index.files[fa] }, now) === null);
  // End to end: the same hazard through codexView must leave the lane OUT, never a row of zeros.
  const both = C.codexView(index, { [fa]: { archivedAt: '', reason: 'deleted', contrib: index.files[fa].contrib } }, { indexing: false, now });
  ok('through codexView a path in both gives no lane at all (absent, not 288 zeros)', both !== null && !('todaySlots' in both), JSON.stringify(both?.todaySlots?.slice?.(0, 3)));
}

// ── 11b. A rebuild never shows a deleted rollout twice ─────────────────────

console.log('\nrebuild after an archive: the view holds its last good state, never a higher count, never zeros');
{
  const dir = await sessionsDir();
  const d = new Date();
  const ten = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0).getTime();
  const now = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0).getTime();
  const fa = rollout(dir, 'rb-a');
  const fb = rollout(dir, 'rb-b');
  await fs.writeFile(fa, meta(ten, 's-r1', 'C:\\Work\\R', 'codex_exec') + turn(ten, 'gpt-6-luna', 'C:\\Work\\R') +
    usage(ten + 60_000, 's-r1', 'resp_r1_00000000000000000000000001', 1000, 0, 10) +
    usage(ten + 120_000, 's-r1', 'resp_r1_00000000000000000000000002', 500, 0, 5));
  await fs.writeFile(fb, meta(ten, 's-r2', 'C:\\Work\\S', 'codex-tui') + turn(ten, 'gpt-6-luna', 'C:\\Work\\S') +
    usage(ten + 7 * 60_000, 's-r2', 'resp_r2_00000000000000000000000001', 200, 0, 2) +
    usage(ten + 8 * 60_000, 's-r2', 'resp_r2_00000000000000000000000002', 300, 0, 3));
  const h = memPort();
  const keeper = C.createCodexViewKeeper();
  let index = (await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir, history: h.port, archived: () => h.entries })).index;
  // Before any refresh has finished, nothing is final (re-check of the fixes, 2026-10-26).
  const early = keeper.view(C.emptyCodexIndex(), { 'x.jsonl': { contrib: index.files[Object.keys(index.files)[0]].contrib } }, now);
  ok('before the first refresh settles, a view is flagged as indexing', early.indexing === true);
  keeper.progress({ done: 0, total: 0, bytesDone: 0, bytesTotal: 0, cold: true });
  const notKept = keeper.view(index, h.entries, now);
  ok('and is never kept as "last good": a cold scan then shows its own view, flagged', notKept.indexing === true && notKept.totals.requests === 4,
     JSON.stringify({ i: notKept.indexing, r: notKept.totals.requests }));
  keeper.settle();
  const before = keeper.view(index, h.entries, now);
  ok('a settled view is fresh and not indexing', before.totals.requests === 4 && before.indexing === false && before.todaySlots.some((x) => x > 0));

  const old = index;
  const seen = [];
  const snap = (where) => seen.push({ where, v: keeper.view(old, h.entries, now) });
  // Like the real store: the entry is set, THEN the save is awaited, and anything may be pushed meanwhile.
  const port = {
    ...h.port,
    async archive(list) {
      for (const e of list) h.entries[e.path] = { archivedAt: '', reason: e.reason, contrib: e.contrib };
      snap('archive, entry set');
      await new Promise((r) => setTimeout(r, 5));
      snap('archive, saved');
      return true;
    },
  };
  await fs.rm(fb);
  const r = await C.refreshCodexIndex(old, (p) => { keeper.progress(p); snap(`progress bytesTotal=${p.bytesTotal}`); }, { dir, history: port, archived: () => h.entries });
  index = r.index;
  keeper.settle();
  ok('the deletion rebuilt the index', r.rebuilt === true && seen.length >= 3, String(seen.length));
  const high = seen.filter((s) => s.v.totals.requests > before.totals.requests);
  ok('no view during the rebuild counts more than before', high.length === 0, high.map((s) => `${s.where}: ${s.v.totals.requests}`).join('; '));
  const bad = seen.filter((s) => !s.v.todaySlots || s.v.todaySlots.every((x) => x === 0));
  ok('and none has its lane missing or all zeros', bad.length === 0, bad.map((s) => s.where).join('; '));
  ok('the held view still reads as settled, so the renderer keeps Codex on screen', seen.every((s) => s.v.indexing === false));
  const after = keeper.view(index, h.entries, now);
  ok('after the rebuild the fresh view has the same totals', after.totals.requests === 4 && after.indexing === false && canon(after.totals) === canon(before.totals));
  ok('and the lane is back, with the deleted file\'s slots', after.todaySlots.join() === before.todaySlots.join());

  // The very first index has no good view: partial numbers, flagged so the renderer hides them.
  const first = C.createCodexViewKeeper();
  const partial = (await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir })).index;
  first.progress({ done: 0, total: 0, bytesDone: 0, bytesTotal: 0, cold: true });
  ok('the very first index shows its partial view flagged as indexing', first.view(partial, {}, now)?.indexing === true && first.rebuilding === true);
  first.settle();
  ok('and settles to a normal view', first.view(partial, {}, now)?.indexing === false && first.rebuilding === false);
  first.progress({ done: 1, total: 2, bytesDone: 1, bytesTotal: 2, cold: false });
  ok('an incremental (not cold) report is not a rebuild', first.rebuilding === false);
}

// ── 11c. Response ids keep the timestamp ───────────────────────────────────

console.log('\nresponse ids: the last 34 characters, timestamp included');
{
  // resp_ + 16 hex session head + 01 + 8 hex epoch seconds + 4 hex + 8191 + 16 hex
  const mk = (secs, tail) => 'resp_' + '06c30b4d2a1f9e77' + '01' + secs + 'ab12' + '8191' + tail;
  const sameTail = '00112233445566ff';
  const a = mk('69e5a001', sameTail);
  const b = mk('69e5a002', sameTail);
  ok('fixture: ids differ only before their last 24 characters', a !== b && a.slice(-24) === b.slice(-24));
  const dir = await sessionsDir();
  const rec = (ms, id) => line(ms, 'token_usage_record', { session_id: 's-id', response_id: id, usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
  await fs.writeFile(rollout(dir, 'ids'), meta(T, 's-id', 'C:\\Work\\I', 'codex_exec') + turn(T, 'gpt-6-luna', 'C:\\Work\\I') + rec(T + 1, a) + rec(T + 2, b) + rec(T + 3, a));
  const { index } = await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir });
  ok('two responses a second apart count as two, a true repeat as one', index.totals.requests === 2, String(index.totals.requests));
  ok('each id is kept by 34 characters', Object.values(index.files)[0].contrib.rids.every((r) => r.length === 34));
  ok('the cache version moved, so a version 1 cache is rebuilt', C.CODEX_INDEX_VERSION === 2);
}

// ── 12. Missing folder ─────────────────────────────────────────────────────

console.log('\nno Codex on this machine');
{
  const { index } = await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir: path.join(tmp, 'nope', 'sessions') });
  ok('a missing sessions folder is unavailable, not an error', index.unavailable === true && index.totals.requests === 0);
  ok('and gives no Codex view', C.codexView(index, {}, { indexing: false }) === null);
  ok('the default root honours MBW_CODEX_HOME', C.CODEX_SESSIONS_DIR === path.join(tmp, 'no-codex-here', 'sessions'));
}

// ── 13. Wire round trip ────────────────────────────────────────────────────

console.log('\nprojection wire: an optional codex block, masked like Claude\'s projects');
{
  const dir = await sessionsDir();
  const home = path.join('C:\\Users', 'gustavsecret');
  await fs.writeFile(rollout(dir, 'wire'), meta(T, 's-w', `${home}\\Desktop\\Proj One`, 'codex_exec') +
    turn(T, 'gpt-6-astra', `${home}\\Desktop\\Proj One`) + usage(T + 1, 's-w', 'resp_w_000000000000000000000000001', 1000, 900, 50) +
    turn(T + 2, 'gpt-6-astra', home) + usage(T + 3, 's-w', 'resp_w_000000000000000000000000002', 100, 0, 5) +
    limits(T + 4, 'codex', { used_percent: 50, window_minutes: 300, resets_at: 1793023200 }, null));
  const { index } = await C.refreshCodexIndex(C.emptyCodexIndex(), undefined, { dir });
  const codex = C.codexView(index, {}, { indexing: false });
  const src = { totals: { input: 1 }, codex };
  const shared = W.toWire(src, { shareProjectNames: true, sourceLabel: 'PC', indexing: false, homeDirName: 'gustavsecret' });
  const text = JSON.stringify(shared);
  ok('the block crosses when the source has Codex', shared.codex?.totals.requests === 2);
  ok('projects are labels, the home folder masked, no path anywhere',
    !!shared.codex.projects['Proj One'] && !!shared.codex.projects.home && !text.includes('gustavsecret') && !text.includes('Users') && !text.includes('\\\\'),
    JSON.stringify(Object.keys(shared.codex.projects)));
  ok('display is the label', shared.codex.projects['Proj One'].display === 'Proj One');
  const back = W.fromWire(JSON.parse(text));
  ok('a round trip keeps every number', JSON.stringify(back.codex.totals) === JSON.stringify(codex.totals) &&
    JSON.stringify(back.codex.sessions) === JSON.stringify(codex.sessions) && back.codex.todaySlots.join() === codex.todaySlots.join() &&
    JSON.stringify(back.codex.limits) === JSON.stringify(codex.limits) && back.codex.activeTime.seconds === codex.activeTime.seconds);
  ok('and the project labels', JSON.stringify(back.codex.projects) === JSON.stringify(shared.codex.projects));
  const unshared = W.toWire(src, { shareProjectNames: false, sourceLabel: 'PC', indexing: false });
  ok('names not shared: no Codex projects at all', Object.keys(unshared.codex.projects).length === 0 && !JSON.stringify(unshared).includes('Proj One'));
  const none = W.toWire({ totals: {} }, { shareProjectNames: true, sourceLabel: 'PC', indexing: false });
  ok('a source with no Codex sends no block', !('codex' in none) && !('codex' in W.fromWire(none)));
  const zero = W.toWire({ codex: { ...codex, totals: { ...codex.totals, requests: 0 } } }, { shareProjectNames: true, sourceLabel: 'PC', indexing: false });
  ok('nor one with zero responses', !('codex' in zero));
  const hostile = JSON.parse(text);
  hostile.codex.projects['C:\\Users\\x\\secret'] = { input: 1, display: 'C:\\Users\\x\\secret' };
  hostile.codex.todaySlots = [1, 2, 3];
  hostile.codex.limits = { at: 'yesterday', fiveHour: { usedPercent: 'lots' } };
  hostile.codex.sessions.byClaude = -4;
  hostile.codex.extra = 'smuggled';
  const cleaned = W.fromWire(hostile).codex;
  ok('on arrival a path-like project key is dropped', !Object.keys(cleaned.projects).some((k) => k.includes('\\')));
  ok('a malformed lane is dropped (absent), never 288 zeros', !('todaySlots' in cleaned));
  const junkLane = JSON.parse(text);
  junkLane.codex.todaySlots = new Array(288).fill(null).map((v, i) => (i % 2 ? 'x' : v));
  ok('a lane of the right length but junk entries is dropped too', !('todaySlots' in W.fromWire(junkLane).codex));
  const noLane = W.toWire({ codex: { ...codex, todaySlots: undefined } }, { shareProjectNames: true, sourceLabel: 'PC', indexing: false });
  ok('a Codex view with no lane crosses with no lane', !('todaySlots' in noLane.codex) && !('todaySlots' in W.fromWire(JSON.parse(JSON.stringify(noLane))).codex));
  ok('a malformed limits reading becomes null', cleaned.limits === null);
  ok('negative counts become zero and unknown fields are dropped', cleaned.sessions.byClaude === 0 && !('extra' in cleaned));
  ok('names unshared on arrival: projects dropped even if sent',
    Object.keys(W.fromWire({ ...JSON.parse(text), projectsShared: false }).codex.projects).length === 0);
  ok('frameKey sees a Codex change', W.frameKey(shared) !== W.frameKey({ ...shared, codex: { ...shared.codex, totals: { ...shared.codex.totals, output: 1 } } }));
}

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
if (fail) process.exit(1);
