/**
 * Codex usage indexer: the second source beside Claude.
 *
 * WHERE THE DATA COMES FROM (docs/design/codex-side-by-side.md, docs/codex-usage.md)
 *
 * Codex writes one append-only JSONL file per session under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl`. Four kinds
 * of line matter, and nothing else is parsed:
 *
 *   session_meta        line 1: session id, cwd, originator (who started it)
 *   turn_context        the model and cwd for the turns that follow
 *   token_usage_record  one per model response: the token counts
 *   event_msg/token_count  carries `rate_limits`, Codex's own plan reading
 *
 * Message text, prompts, tool calls and reasoning (`response_item` lines) are
 * skipped by their top-level type before any parse, and `auth.json` is never
 * opened. T3 Code's database is NOT a second source: its Codex threads are the
 * `T3 Code` rollouts already read here, and t3-usage.ts reads Claude rows only.
 *
 * THE SAME MACHINERY AS CLAUDE, A SECOND INDEX
 *
 * Byte-offset incremental reads bounded at the stat'd size, a partial trailing
 * line read again next pass, a shrunk file meaning a rebuild, per-file
 * contributions folded through usage.ts `fold` (so the two can never disagree),
 * deleted files moved to a history store of their own, and a cache with its
 * own version. Every rule and every bug fix in usage.ts applies here for the
 * same reasons; the comments there say why.
 *
 * NORMALISATION. OpenAI counts cached tokens INSIDE `input_tokens`; Anthropic
 * reports them apart. So a record maps onto TokenTotals as: input = input -
 * cached, cacheRead = cached, cacheCreate = cache writes, output = output
 * (reasoning already inside), thinking = reasoning, one request. "Tokens
 * processed" then means the same thing for both providers.
 */

import { promises as fs, createReadStream } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';

import { costOf } from '../../shared/pricing';
import { localDayKey } from '../../shared/day';
import { bucketOf, foldIntraday, todaySlotsOf } from '../../shared/intraday';
import { activeTime, foldActive } from '../../shared/active-time';
import { mergeHistory } from '../../shared/usage-merge';
import type { CodexLimits, CodexLimitWindow, CodexView } from '../../shared/codex-view';
import {
  absorb,
  addInto,
  emptyContrib,
  emptyTotals,
  fold,
  isGone,
  type FileContribution,
  type HistoryPort,
  type IndexProgress,
  type SessionInfo,
  type TokenTotals,
} from './usage';
import { createHistoryStore } from './history';

/** Where Codex keeps its data. Overridable like MBW_CLAUDE_HOME. */
export const CODEX_HOME = process.env.MBW_CODEX_HOME || path.join(os.homedir(), '.codex');
export const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');

/**
 * Bump when the aggregate shape changes. Independent of Claude's INDEX_VERSION.
 * 2: response ids are kept by their last 34 characters (the timestamp is in),
 * so a version 1 cache is rebuilt, its per-file contributions handed back.
 */
export const CODEX_INDEX_VERSION = 2;
/** Schema of one file's contribution. History outlives the cache. */
export const CODEX_CONTRIB_VERSION = 1;

const HOURLY_DAYS = 14;
const RECENT_EVENTS = 600;
/**
 * Response ids are kept by this many trailing characters. An id is `resp_`, a
 * 16 hex session head (shared by the whole session), `01`, 8 hex epoch seconds,
 * 4 hex, a constant `8191` and 16 hex: the trailing 34 characters reach back
 * through the timestamp, so they carry roughly 90 varying bits, where the old
 * trailing 24 (4 + `8191` + 16) carried only about 64 to 80.
 */
const RID_CHARS = 34;

/** Codex's own history store: `codex-usage-history.json`, never Claude's file, never a seed. */
export const codexHistory = createHistoryStore({ file: 'codex-usage-history.json', seedFile: null, tag: 'codex-history' });

/**
 * One rollout's contribution: Claude's shape plus who started each session
 * and the response ids it counted, so a response can never be counted twice,
 * not even across files (a forked session copying records) or after the file
 * that first held it was archived.
 */
export interface CodexContribution extends FileContribution {
  /** Session id to `session_meta.originator`. */
  origin: Record<string, string>;
  /** Trailing RID_CHARS of every `response_id` this file counted. */
  rids: string[];
}

/**
 * What the reader knows at the end of the bytes it has read: the latest
 * model and cwd, and the session. Persisted per file, so an incremental read
 * that starts mid-file still prices and places its records.
 */
export interface CodexFileState {
  model: string | null;
  cwd: string | null;
  sid: string | null;
}

export interface CodexFileEntry {
  size: number;
  offset: number;
  contrib: CodexContribution;
  state: CodexFileState;
}

export interface CodexIndex {
  version: number;
  builtAt: string;
  files: Record<string, CodexFileEntry>;
  totals: TokenTotals;
  daily: Record<string, TokenTotals>;
  /** UTC hour, last 14 days. */
  hourly: Record<string, TokenTotals>;
  models: Record<string, TokenTotals>;
  projects: Record<string, TokenTotals & { lastSeen: string; display: string }>;
  sessions: Record<string, SessionInfo>;
  activeDays: Record<string, number>;
  recent: [number, number, number][];
  /** The latest `rate_limits` reading for `limit_id: "codex"`, by the record's own time. */
  limits: CodexLimits | null;
  latest: { ts: string | null; model: string | null; cwd: string | null };
  lastScanMs: number;
  /** Contributions a cache of another version handed over that are not settled yet. */
  pendingStale?: Record<string, CodexContribution>;
  unavailable: boolean;
  unavailableReason?: string;
}

export function emptyCodexContrib(): CodexContribution {
  return { ...emptyContrib(), cv: CODEX_CONTRIB_VERSION, origin: {}, rids: [] };
}

export function emptyCodexIndex(): CodexIndex {
  return {
    version: CODEX_INDEX_VERSION,
    builtAt: new Date().toISOString(),
    files: {},
    totals: emptyTotals(),
    daily: {},
    hourly: {},
    models: {},
    projects: {},
    sessions: {},
    activeDays: {},
    recent: [],
    limits: null,
    latest: { ts: null, model: null, cwd: null },
    lastScanMs: 0,
    unavailable: false,
  };
}

async function listRollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listRollouts(p)));
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * The top-level `type` of a rollout line, without parsing it.
 *
 * Codex writes `{"timestamp":...,"ordinal":N,"type":"...","payload":...}`, so
 * the first `"type"` in the line's head is the record's own. Message lines are
 * dropped on this alone and never parsed. A head with no type at all (a future
 * key order) returns null, and the caller parses to find out.
 */
const HEAD = 200;
function headType(line: string): string | null {
  const m = /"type":"([a-z_]+)"/.exec(line.slice(0, HEAD));
  return m ? m[1] : null;
}

const WANTED = new Set(['session_meta', 'turn_context', 'token_usage_record', 'event_msg']);

/** A count from the record: a non-negative finite number, else 0. */
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function limitWindow(w: any): CodexLimitWindow | null {
  if (!w || typeof w !== 'object') return null;
  const used = w.used_percent;
  const mins = w.window_minutes;
  const resets = w.resets_at;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets) || resets <= 0) return null;
  return {
    usedPercent: used,
    windowMinutes: typeof mins === 'number' && Number.isFinite(mins) && mins > 0 ? mins : 0,
    // Codex writes epoch SECONDS.
    resetsAt: resets * 1000,
  };
}

/**
 * The plan reading in a token_count event, or null. Only `limit_id: "codex"`
 * with at least one window counts: `premium` readings carry no windows.
 */
export function limitsOf(o: any): CodexLimits | null {
  const rl = o?.payload?.rate_limits;
  if (o?.type !== 'event_msg' || o?.payload?.type !== 'token_count' || !rl || rl.limit_id !== 'codex') return null;
  const at = typeof o.timestamp === 'string' && Number.isFinite(Date.parse(o.timestamp)) ? o.timestamp : null;
  if (!at) return null;
  const fiveHour = limitWindow(rl.primary);
  const weekly = limitWindow(rl.secondary);
  if (!fiveHour && !weekly) return null;
  return { at, plan: typeof rl.plan_type === 'string' ? rl.plan_type : null, fiveHour, weekly };
}

/** Keep the later reading, by the record's own time. */
function laterLimits(a: CodexLimits | null, b: CodexLimits | null): CodexLimits | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

const ridOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(-RID_CHARS) : null);

/**
 * Read one rollout from `fromOffset` to `size`. Returns the new offset, which
 * counts only bytes of complete lines; see usage.ts ingestFile for why the
 * read is bounded and the partial tail is read again. Never throws.
 */
async function ingestRollout(
  index: CodexIndex,
  entry: { contrib: CodexContribution; state: CodexFileState },
  seen: Set<string>,
  file: string,
  fromOffset: number,
  size: number,
): Promise<number> {
  if (size <= fromOffset) return fromOffset;
  const hourlyCutoff = Date.now() - HOURLY_DAYS * 86_400_000;
  const { contrib } = entry;
  // Saved only with the offset it belongs to, so the two always describe the
  // same point in the file.
  const state: CodexFileState = { ...entry.state };
  let processed = 0;

  try {
    const stream = createReadStream(file, { encoding: 'utf8', start: fromOffset, end: size - 1 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let consumed = 0;
    let lastLineBytes = 0;
    let sawAnyLine = false;
    // A line read but not yet known to be complete: applied only once the next
    // line arrives (or the slice ends on a newline), so a partial tail never
    // moves the model or cwd and is never counted.
    let pending: string | null = null;

    const apply = (line: string): void => {
      if (line.length < 20) return;
      const t = headType(line);
      if (t !== null && !WANTED.has(t)) return;
      if (t === 'event_msg' && !line.includes('"rate_limits"')) return;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      const p = o?.payload;
      if (!p || typeof p !== 'object') return;

      if (o.type === 'session_meta') {
        const sid = typeof p.id === 'string' ? p.id : typeof p.session_id === 'string' ? p.session_id : null;
        if (sid) {
          state.sid = sid;
          contrib.origin[sid] = typeof p.originator === 'string' ? p.originator : '';
        }
        if (typeof p.cwd === 'string' && p.cwd) state.cwd = p.cwd;
        return;
      }
      if (o.type === 'turn_context') {
        if (typeof p.model === 'string' && p.model) state.model = p.model;
        if (typeof p.cwd === 'string' && p.cwd) state.cwd = p.cwd;
        return;
      }
      if (o.type === 'event_msg') {
        const reading = limitsOf(o);
        if (reading) index.limits = laterLimits(index.limits, reading);
        return;
      }
      if (o.type !== 'token_usage_record') return;

      const u = p.usage;
      if (!u || typeof u !== 'object') return;
      const rid = ridOf(p.response_id);
      if (rid !== null) {
        if (seen.has(rid)) return;
        seen.add(rid);
        contrib.rids.push(rid);
      }

      const inputAll = n(u.input_tokens);
      const cached = Math.min(n(u.cached_input_tokens), inputAll);
      const fresh = inputAll - cached;
      const write = n(u.cache_write_input_tokens);
      const output = n(u.output_tokens);
      const model = state.model ?? 'unknown';
      const ts: string | null = typeof o.timestamp === 'string' ? o.timestamp : null;
      const tsMs = ts ? Date.parse(ts) : NaN;
      // Priced at the record's own time, like Claude since index version 8.
      const cost = costOf(model, { input: fresh, output, cacheRead: cached, cacheWrite5m: write, cacheWrite1h: 0, webSearch: 0 }, tsMs);
      const total = fresh + output + write + cached;
      const rec: TokenTotals = {
        input: fresh,
        output,
        cacheCreate: write,
        cacheRead: cached,
        thinking: n(u.reasoning_output_tokens),
        requests: 1,
        webSearch: 0,
        webFetch: 0,
        costUsd: cost ?? 0,
        unpricedTokens: cost === null ? total : 0,
      };
      const sid = typeof p.session_id === 'string' && p.session_id ? p.session_id : state.sid;
      const meta = { model, ts, tsMs, cwd: state.cwd, sid };
      fold(index, rec, meta);
      fold(contrib, rec, meta);
      if (ts && Number.isFinite(tsMs)) {
        foldIntraday((contrib.intraday ??= {}), localDayKey(tsMs), meta.cwd === null ? '' : meta.cwd.toLowerCase(), bucketOf(tsMs), [1, total, output]);
        foldActive((contrib.active ??= { last: 0, spans: [] }), tsMs);
        if (tsMs >= hourlyCutoff) addInto((index.hourly[ts.slice(0, 13)] ??= emptyTotals()), rec);
        index.recent.push([tsMs, total, output]);
        if (!index.latest.ts || ts > index.latest.ts) index.latest = { ts, model, cwd: state.cwd };
      }
    };

    for await (const line of rl) {
      if (pending !== null) apply(pending);
      pending = line;
      lastLineBytes = Buffer.byteLength(line, 'utf8') + 1;
      consumed += lastLineBytes;
      sawAnyLine = true;
      if (++processed % 2000 === 0) await new Promise((r) => setImmediate(r));
    }
    rl.close();

    // The slice did not end on a newline: the last line is a partial record,
    // not applied and not counted, and read again whole next pass.
    const partial = sawAnyLine && consumed > size - fromOffset;
    if (partial) consumed -= lastLineBytes;
    else if (pending !== null) apply(pending);
    entry.state = state;
    return fromOffset + Math.max(0, consumed);
  } catch {
    return fromOffset;
  }
}

export interface CodexRefreshOptions {
  history?: HistoryPort;
  /** Contributions from a cache of another version, handed over by loadCodexIndex. */
  staleFiles?: Record<string, CodexContribution>;
  /** Archived entries, read after the history step, so their response ids are never counted again. */
  archived?: () => Record<string, { contrib: FileContribution }>;
  /** The sessions folder. Defaults to CODEX_SESSIONS_DIR. */
  dir?: string;
}

function prune(index: CodexIndex): void {
  if (index.recent.length > RECENT_EVENTS) {
    index.recent.sort((a, b) => a[0] - b[0]);
    index.recent = index.recent.slice(-RECENT_EVENTS);
  }
  const cutoff = new Date(Date.now() - HOURLY_DAYS * 86_400_000).toISOString().slice(0, 13);
  for (const k of Object.keys(index.hourly)) if (k < cutoff) delete index.hourly[k];
}

/**
 * Refresh the Codex index in place. The same order and the same guards as
 * usage.ts refreshIndex: history first (restores, then confirmed deletions
 * archived before anything is dropped), a shrunk file rebuilds, then only the
 * appended bytes are read.
 */
export async function refreshCodexIndex(
  index: CodexIndex,
  onProgress?: (p: IndexProgress) => void,
  opts: CodexRefreshOptions = {},
): Promise<{ index: CodexIndex; rebuilt: boolean }> {
  const started = Date.now();
  const port = opts.history;
  const dir = opts.dir ?? CODEX_SESSIONS_DIR;

  let files: string[];
  try {
    await fs.access(dir);
    files = await listRollouts(dir);
  } catch (err) {
    index.unavailable = true;
    index.unavailableReason = `cannot read ${dir}: ${(err as Error).message}`;
    index.lastScanMs = Date.now() - started;
    return { index, rebuilt: false };
  }
  index.unavailable = false;
  delete index.unavailableReason;

  const unreadThisPass = new Set<string>();
  if (port?.ready) {
    const held = files.filter((f) => port.has(f));
    if (held.length && !(await port.release(held))) for (const f of held) unreadThisPass.add(f);

    const listed = new Set(files);
    const candidates: { path: string; contrib: CodexContribution; reason: 'deleted' | 'stale-cache' }[] = [];
    for (const [p, e] of Object.entries(index.files)) {
      if (!listed.has(p) && e?.contrib) candidates.push({ path: p, contrib: e.contrib, reason: 'deleted' });
    }
    for (const [p, c] of Object.entries(opts.staleFiles ?? {})) {
      if (!listed.has(p) && !index.files[p] && !port.has(p)) candidates.push({ path: p, contrib: c, reason: 'stale-cache' });
    }
    const gone: typeof candidates = [];
    for (const c of candidates) if (await isGone(c.path)) gone.push(c);
    /*
     * An archived-then-deleted file is in the history store from the moment
     * archive() sets it, a save before it returns, while the old index still
     * holds it too: a view built in that window counts it twice. Say a rebuild
     * is coming BEFORE archiving, so the caller can hold its last good view.
     */
    if (gone.some((g) => g.reason === 'deleted')) onProgress?.({ done: 0, total: 0, bytesDone: 0, bytesTotal: 0, cold: true });
    if (gone.length && (await port.archive(gone)) && gone.some((g) => g.reason === 'deleted')) {
      return rebuildKeeping(index, onProgress, opts);
    }
  }

  for (const f of files) {
    const known = index.files[f];
    if (!known) continue;
    let size = 0;
    try {
      size = (await fs.stat(f)).size;
    } catch {
      continue;
    }
    if (size < known.size) return rebuildKeeping(index, onProgress, opts);
  }

  /*
   * Every response id already counted, live or archived. Built after the
   * history step, so a file archived this pass is in it and a file released
   * back to disk is not.
   */
  const seen = new Set<string>();
  for (const e of Object.values(index.files)) for (const r of e?.contrib?.rids ?? []) seen.add(r);
  for (const e of Object.values(opts.archived?.() ?? {})) for (const r of (e?.contrib as Partial<CodexContribution>)?.rids ?? []) seen.add(r);

  const sizes = new Map<string, number>();
  let bytesTotal = 0;
  let bytesPending = 0;
  for (const f of files) {
    let size = 0;
    try {
      size = (await fs.stat(f)).size;
    } catch {
      continue;
    }
    sizes.set(f, size);
    bytesTotal += size;
    const from = index.files[f]?.offset ?? 0;
    if (size > from) bytesPending += size - from;
  }
  const cold = Object.keys(index.files).length === 0 || bytesPending > bytesTotal * 0.5;
  let done = 0;
  let bytesDone = 0;
  const report = () => onProgress?.({ done, total: files.length, bytesDone, bytesTotal, cold });
  report();

  for (const f of files) {
    const size = sizes.get(f);
    if (size === undefined || unreadThisPass.has(f)) continue;
    const known = index.files[f];
    const entry: CodexFileEntry = known ?? { size, offset: 0, contrib: emptyCodexContrib(), state: { model: null, cwd: null, sid: null } };
    // A cache healed from a hand edit could lack these; never let that throw.
    entry.contrib.origin ??= {};
    entry.contrib.rids ??= [];
    entry.state ??= { model: null, cwd: null, sid: null };
    if (size > entry.offset) entry.offset = await ingestRollout(index, entry, seen, f, entry.offset, size);
    entry.size = size;
    index.files[f] = entry;
    done++;
    bytesDone += size;
  }
  report();

  prune(index);
  index.builtAt = new Date().toISOString();
  index.lastScanMs = Date.now() - started;
  return { index, rebuilt: false };
}

/** Rebuild from disk without losing a file the rebuild cannot see; see usage.ts rebuildKeeping. */
async function rebuildKeeping(
  old: CodexIndex,
  onProgress: ((p: IndexProgress) => void) | undefined,
  opts: CodexRefreshOptions,
): Promise<{ index: CodexIndex; rebuilt: boolean }> {
  onProgress?.({ done: 0, total: 0, bytesDone: 0, bytesTotal: 0, cold: true });
  const { index } = await refreshCodexIndex(emptyCodexIndex(), onProgress, { history: opts.history, archived: opts.archived, dir: opts.dir });
  for (const [p, e] of Object.entries(old.files)) {
    if (index.files[p] || !e?.contrib || opts.history?.has(p)) continue;
    index.files[p] = e;
    absorb(index, e.contrib);
  }
  // A plan reading is not a contribution: keep the latest whichever file held it.
  index.limits = laterLimits(index.limits, old.limits);
  return { index, rebuilt: true };
}

// ── Cache ──────────────────────────────────────────────────────────────────

/**
 * Load the cache. Another version's cache is discarded, but its contributions
 * AND its unsettled pendingStale are handed back as `staleFiles`, the
 * 2026-10-10 fix in usage.ts loadIndex, so a bump can never lose a number.
 */
export async function loadCodexIndex(
  cacheFile: string,
): Promise<{ index: CodexIndex; staleFiles: Record<string, CodexContribution> }> {
  try {
    const text = await fs.readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as CodexIndex;
    if (parsed?.version !== CODEX_INDEX_VERSION) {
      const staleFiles: Record<string, CodexContribution> = {};
      for (const [p, e] of Object.entries(parsed?.files ?? {})) {
        if (e?.contrib?.cv === CODEX_CONTRIB_VERSION) staleFiles[p] = e.contrib;
      }
      for (const [p, c] of Object.entries(parsed?.pendingStale ?? {})) {
        if (c?.cv === CODEX_CONTRIB_VERSION && !staleFiles[p]) staleFiles[p] = c;
      }
      return { index: emptyCodexIndex(), staleFiles };
    }
    const { pendingStale, ...rest } = parsed;
    return { index: { ...emptyCodexIndex(), ...rest }, staleFiles: pendingStale ?? {} };
  } catch {
    return { index: emptyCodexIndex(), staleFiles: {} };
  }
}

export async function saveCodexIndex(cacheFile: string, index: CodexIndex): Promise<void> {
  const tmp = `${cacheFile}.tmp`;
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(index), 'utf8');
  await fs.rename(tmp, cacheFile);
}

// ── The view ───────────────────────────────────────────────────────────────

type ArchivedCodex = Record<string, { contrib: FileContribution & { origin?: Record<string, string> } }>;

/** Who started each session, across live and archived rollouts. */
export function sessionCounts(
  live: Record<string, { contrib: { origin?: Record<string, string>; sessions?: Record<string, unknown> } }>,
  archived: Record<string, { contrib: { origin?: Record<string, string>; sessions?: Record<string, unknown> } }>,
): CodexView['sessions'] {
  const by = new Map<string, string>();
  for (const src of [live, archived]) {
    for (const e of Object.values(src)) {
      for (const [sid, o] of Object.entries(e?.contrib?.origin ?? {})) if (!by.has(sid) || !by.get(sid)) by.set(sid, o);
      // A session with responses but no session_meta seen still counts, as other.
      for (const sid of Object.keys(e?.contrib?.sessions ?? {})) if (!by.has(sid)) by.set(sid, '');
    }
  }
  const out = { total: by.size, byClaude: 0, byYou: 0, byT3: 0, other: 0 };
  for (const o of by.values()) {
    if (o === 'codex_exec') out.byClaude++;
    else if (o === 'codex-tui') out.byYou++;
    else if (o === 'T3 Code') out.byT3++;
    else out.other++;
  }
  return out;
}

/**
 * The renderer's CodexView: the live index merged with its own history store.
 * Null when there is not a single Codex response on record, so a wall with no
 * Codex shows no toggle and looks exactly as it does today.
 */
export function codexView(
  index: CodexIndex,
  archived: ArchivedCodex,
  opts: { indexing: boolean; now?: number },
): CodexView | null {
  const now = opts.now ?? Date.now();
  const empty = { total: 0, daily: {} };
  const merged = mergeHistory({ ...index, prompts: empty }, { entries: archived, seed: null, prompts: empty });
  if (merged.totals.requests <= 0) return null;

  let firstAt: string | null = null;
  let latestAt: string | null = null;
  for (const s of Object.values(merged.sessions)) {
    if (s.start && (!firstAt || s.start < firstAt)) firstAt = s.start;
    if (s.end && (!latestAt || s.end > latestAt)) latestAt = s.end;
  }
  if (index.latest.ts && (!latestAt || index.latest.ts > latestAt)) latestAt = index.latest.ts;

  const recent = [...index.recent].sort((a, b) => a[0] - b[0]).slice(-RECENT_EVENTS);
  // A failed computation is left out, never turned into a row of zeros: the lane hides.
  const todaySlots = todaySlotsOf(index.files, archived, now);
  return {
    totals: merged.totals,
    daily: merged.daily,
    hourly: index.hourly,
    models: merged.models,
    projects: merged.projects,
    activeDays: merged.activeDays,
    sessions: sessionCounts(index.files, archived),
    activeTime: activeTime(index.files, archived),
    ...(todaySlots ? { todaySlots } : {}),
    recent,
    limits: index.limits,
    firstAt,
    latestAt,
    indexing: opts.indexing,
  };
}

/**
 * Holds the view the wall shows across a Codex rebuild.
 *
 * Between `port.archive(gone)` and the end of `rebuildKeeping` a deleted
 * rollout is in the old index AND in history, so a view merged from the two
 * counts it twice (and today's lane cannot be computed at all). Any cold
 * progress report, the zero-byte one included, therefore marks a rebuild; while
 * it lasts the LAST GOOD view is what callers get, with `indexing` false so
 * the renderer keeps Codex on screen. Only the very first index, when there has
 * never been a good view, shows its partial numbers, flagged `indexing`.
 */
export interface CodexViewKeeper {
  /** Feed every progress report of a refresh. */
  progress(p: IndexProgress): void;
  /** The refresh ended, well or badly. */
  settle(): void;
  readonly rebuilding: boolean;
  view(index: CodexIndex, archived: ArchivedCodex, now?: number): CodexView | null;
}

export function createCodexViewKeeper(): CodexViewKeeper {
  let good: CodexView | null = null;
  let rebuilding = false;
  /*
   * No view is final until a refresh has finished once. Before that, an index
   * built from a missing or outdated cache (or history alone) is partial, and
   * keeping it as "last good" would show it as final for the whole first scan
   * (re-check of the review fixes, 2026-10-26).
   */
  let settled = false;
  return {
    progress(p) {
      if (p.cold) rebuilding = true;
    },
    settle() {
      rebuilding = false;
      settled = true;
    },
    get rebuilding() {
      return rebuilding;
    },
    view(index, archived, now) {
      if (rebuilding && good) return good;
      const fresh = codexView(index, archived, { indexing: rebuilding || !settled, now });
      if (!rebuilding && settled) good = fresh;
      return fresh;
    },
  };
}
