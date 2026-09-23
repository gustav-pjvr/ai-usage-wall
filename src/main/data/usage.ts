/**
 * Claude usage indexer.
 *
 * WHERE THE DATA COMES FROM, and what was ruled out.
 *
 * Claude Code writes an append-only JSONL transcript per session under
 * `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl`. Every assistant
 * record carries a real `message.usage` block: input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens,
 * output_tokens_details.thinking_tokens and server_tool_use counts, plus the
 * model, timestamp, sessionId and cwd. `~/.claude/history.jsonl` separately
 * records every prompt the user submitted.
 *
 * That is the authoritative source and it is entirely local: no API, no
 * authentication, no network, and therefore no rate limits and nothing that can
 * be throttled or go down.
 *
 * Ruled out, deliberately:
 *   - The Anthropic Usage/Cost Admin API needs an admin API key issued to an
 *     organisation. It does not cover Claude subscription usage and there is no
 *     such key on this machine.
 *   - There is NO local record of remaining quota, plan limits or reset times.
 *     Hitting a limit shows up only as free-text inside a transcript
 *     ("You've hit your session limit"), which is indistinguishable from an
 *     assistant message discussing rate limiting. So the dashboard shows no
 *     quota or headroom figure at all rather than a guessed one.
 *   - Money. On a subscription, per-token pricing is not what is billed, so a
 *     currency figure here would be invented. Tokens are reported instead.
 *
 * REFRESH STRATEGY, measured rather than assumed.
 *
 * A full parse of the corpus on this machine is 961 MB in 5.5 s (174 MB/s), so
 * a cold index is a one-off cost, cached to disk. After that the files are
 * append-only, so a refresh reads ONLY the bytes appended since the last read,
 * tracked as a byte offset per file. That is milliseconds.
 *
 * Because of that, POLLING IS THE WRONG MODEL. There is no server to ask and no
 * quota to spend: the correct trigger is a filesystem watch, which reflects new
 * activity within its debounce rather than up to a minute late, and costs
 * nothing while idle. A polling interval would be strictly worse on both
 * latency and cost.
 */

import type { PeakVelocity } from '../../shared/velocity';
import { promises as fs, createReadStream } from 'node:fs';
import { costOf } from '../../shared/pricing';
import { localDayKey } from '../../shared/day';
import { bucketOf, foldIntraday, type Intraday } from '../../shared/intraday';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';

/**
 * Where Claude Code keeps its data. Overridable so the "no Claude Code
 * installed" path can actually be exercised, and so a non-default location can
 * be pointed at without a rebuild.
 */
export const CLAUDE_HOME = process.env.MBW_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const HISTORY_FILE = path.join(CLAUDE_HOME, 'history.jsonl');

/**
 * Bump when the aggregate shape changes, to invalidate old caches.
 *
 * 4 (2026-09-22): `projectHourly` and `activeDays`, for the work time-lapse and
 * the streak milestone.
 *
 * 5 (2026-09-22): every file carries its own `contrib`, so a transcript that is
 * deleted can have its numbers moved to the history store instead of vanishing.
 *
 * 6 (2026-09-23): five-minute `intraday` detail in every file's `contrib`, for
 * the any-day time-lapse; `projectHourly` removed. CONTRIB_VERSION is NOT
 * bumped: `intraday` is optional, and a bump would make loadIndex drop every
 * contribution it hands over, the exact loss version 5 exists to prevent.
 *
 * A BUMP NO LONGER LOSES ANYTHING, and that is the point of version 5. Version
 * 4's bump discarded a cache that remembered about 350 transcripts Claude Code
 * had already deleted, and the wall dropped from 39.35B tokens to 19.79B.
 * `loadIndex` now hands a mismatched cache's per-file contributions back as
 * `staleFiles`, and the first refresh archives the ones whose file is gone.
 * (Version 4 caches have no contributions to hand back; that history came back
 * through a one-off seed, see docs/design/history-archive.md.)
 */
export const INDEX_VERSION = 6;

/** Schema of one file's contribution. Independent of INDEX_VERSION: history outlives the cache. */
export const CONTRIB_VERSION = 1;

/** Hourly buckets are kept for this many days. Daily buckets are kept forever. */
const HOURLY_DAYS = 14;
/** Rolling window of recent records powering the live velocity readouts. */
const RECENT_EVENTS = 600;

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  thinking: number;
  requests: number;
  webSearch: number;
  webFetch: number;
  /**
   * Dollars at API list prices. DERIVED, not recorded: cost appears nowhere in
   * the transcripts, so this is the same arithmetic Claude Code's own /cost
   * does on the same token counts. See src/shared/pricing.ts.
   */
  costUsd: number;
  /**
   * Tokens belonging to a model the price table does not know.
   *
   * Kept so an unpriced model shows as a caveat rather than quietly making the
   * total too low. A new model id is a question, not a zero.
   */
  unpricedTokens: number;
}

export interface SessionInfo {
  id: string;
  start: string;
  end: string;
  requests: number;
  output: number;
  total: number;
  cwd: string | null;
  models: string[];
}

/**
 * Everything one transcript put into the index.
 *
 * Kept per file so that when the transcript disappears its numbers can be
 * MOVED to the history store (src/main/data/history.ts) rather than lost. The
 * live aggregates cannot subtract a file, so a disappearance is handled by
 * archiving its contribution and rebuilding from the files that remain; the
 * contribution is what makes the archive exact instead of a guess.
 *
 * Not kept: hourly, recent, latest. Those are short windows, and a file old
 * enough to be deleted is outside them.
 */
export interface FileContribution {
  cv: number;
  totals: TokenTotals;
  daily: Record<string, TokenTotals>;
  models: Record<string, TokenTotals>;
  projects: Record<string, TokenTotals & { lastSeen: string; display: string }>;
  sessions: Record<string, SessionInfo>;
  activeDays: Record<string, number>;
  /**
   * This file's records in five-minute slots of the local day, per project.
   * The time-lapse sums a day across every live and archived contribution
   * (src/shared/intraday.ts), so a deleted transcript keeps its curve. Absent
   * on a contribution archived before index version 6: that file's requests
   * still count in `activeDays`, and its days show as partly detailed.
   */
  intraday?: Intraday;
}

export interface FileEntry {
  size: number;
  offset: number;
  contrib: FileContribution;
}

export interface UsageIndex {
  version: number;
  builtAt: string;
  /** Byte offsets so a refresh only reads what was appended, and what each file contributed. */
  files: Record<string, FileEntry>;
  totals: TokenTotals;
  daily: Record<string, TokenTotals>;
  hourly: Record<string, TokenTotals>;
  models: Record<string, TokenTotals>;
  projects: Record<string, TokenTotals & { lastSeen: string; display: string }>;
  sessions: Record<string, SessionInfo>;
  /** [epochMs, totalTokens, outputTokens] for the most recent records. */
  recent: [number, number, number][];
  /**
   * LOCAL calendar days with at least one request, and how many.
   *
   * `daily` is keyed by the UTC date and deliberately stays that way. The
   * streak milestone needs the day on the wall's own clock, and sessions cannot
   * stand in for it: a resumed session keeps its id, so its start and end can
   * be weeks apart and every day between would silently vanish from a streak.
   * Kept forever, like `daily`; it is one number per day.
   */
  activeDays: Record<string, number>;
  prompts: {
    total: number;
    daily: Record<string, number>;
    lastAt: string | null;
    offset: number;
    size: number;
    /** history.jsonl was seen shorter, at this size; reconciled once it holds still. */
    pendingShrink?: number;
  };
  latest: { ts: string | null; model: string | null; sessionId: string | null; version: string | null; cwd: string | null };
  /** Wall-clock ms of parse work in the last refresh. */
  lastScanMs: number;
  /**
   * All time peak tokens per minute. Attached in memory before each push and
   * deliberately NOT trusted from the cache file: a version bump discards this
   * whole index, and a record must outlive that. See src/main/data/peak.ts.
   */
  peak?: PeakVelocity | null;
  /**
   * Contributions an older-version cache handed over that could not be settled
   * yet (store unreadable, archive failed, file locked). Saved with the cache
   * so a restart cannot drop them; loadIndex hands them back as `staleFiles`.
   */
  pendingStale?: Record<string, FileContribution>;
  /** True when the source directory could not be read at all. */
  unavailable: boolean;
  unavailableReason?: string;
}

const emptyTotals = (): TokenTotals => ({
  input: 0,
  output: 0,
  cacheCreate: 0,
  cacheRead: 0,
  thinking: 0,
  requests: 0,
  webSearch: 0,
  webFetch: 0,
  costUsd: 0,
  unpricedTokens: 0,
});

function addInto(target: TokenTotals, u: TokenTotals): void {
  target.input += u.input;
  target.output += u.output;
  target.cacheCreate += u.cacheCreate;
  target.cacheRead += u.cacheRead;
  target.thinking += u.thinking;
  target.requests += u.requests;
  target.webSearch += u.webSearch;
  target.webFetch += u.webFetch;
  target.costUsd += u.costUsd;
  target.unpricedTokens += u.unpricedTokens;
}

export function emptyContrib(): FileContribution {
  return { cv: CONTRIB_VERSION, totals: emptyTotals(), daily: {}, models: {}, projects: {}, sessions: {}, activeDays: {}, intraday: {} };
}

/** The aggregates a record lands in, shared by the index and each file's contribution. */
type Aggregates = Pick<UsageIndex, 'totals' | 'daily' | 'models' | 'projects' | 'sessions' | 'activeDays'>;

/**
 * Fold one record into a set of aggregates.
 *
 * The index and the file's own contribution go through this ONE function, so
 * the two can never disagree about what a record added. If they could, an
 * archived file would carry different numbers from the ones it is replacing
 * and the totals would move on deletion, which is the exact failure this
 * exists to prevent.
 */
function fold(
  into: Aggregates,
  rec: TokenTotals,
  m: { model: string; ts: string | null; tsMs: number; cwd: string | null; sid: string | null },
): void {
  addInto(into.totals, rec);
  into.models[m.model] ??= emptyTotals();
  addInto(into.models[m.model], rec);

  if (m.cwd !== null) {
    const key = m.cwd.toLowerCase();
    into.projects[key] ??= { ...emptyTotals(), lastSeen: m.ts ?? '', display: m.cwd };
    addInto(into.projects[key], rec);
    if (m.ts && m.ts > into.projects[key].lastSeen) into.projects[key].lastSeen = m.ts;
  }

  if (m.ts) {
    const day = m.ts.slice(0, 10);
    into.daily[day] ??= emptyTotals();
    addInto(into.daily[day], rec);
    if (Number.isFinite(m.tsMs)) {
      const local = localDayKey(m.tsMs);
      into.activeDays[local] = (into.activeDays[local] || 0) + 1;
    }
  }

  if (m.sid && m.ts) {
    const s = (into.sessions[m.sid] ??= {
      id: m.sid,
      start: m.ts,
      end: m.ts,
      requests: 0,
      output: 0,
      total: 0,
      cwd: m.cwd,
      models: [],
    });
    if (m.ts < s.start) s.start = m.ts;
    if (m.ts > s.end) s.end = m.ts;
    s.requests += 1;
    s.output += rec.output;
    s.total += rec.input + rec.output + rec.cacheCreate + rec.cacheRead;
    if (!s.models.includes(m.model)) s.models.push(m.model);
  }
}

/**
 * Add a whole file's contribution back into aggregates, for a file a rebuild
 * could not re-read. Sessions are unioned, since one id can span files.
 */
function absorb(into: Aggregates, c: FileContribution): void {
  addInto(into.totals, c.totals);
  for (const [k, v] of Object.entries(c.daily)) addInto((into.daily[k] ??= emptyTotals()), v);
  for (const [k, v] of Object.entries(c.models)) addInto((into.models[k] ??= emptyTotals()), v);
  for (const [k, v] of Object.entries(c.projects)) {
    const cur = (into.projects[k] ??= { ...emptyTotals(), lastSeen: v.lastSeen, display: v.display });
    addInto(cur, v);
    if (v.lastSeen > cur.lastSeen) cur.lastSeen = v.lastSeen;
  }
  for (const [k, n] of Object.entries(c.activeDays)) into.activeDays[k] = (into.activeDays[k] || 0) + n;
  for (const [id, sv] of Object.entries(c.sessions)) {
    const cur = into.sessions[id];
    if (!cur) {
      into.sessions[id] = { ...sv, models: [...sv.models] };
      continue;
    }
    if (sv.start < cur.start) cur.start = sv.start;
    if (sv.end > cur.end) cur.end = sv.end;
    cur.requests += sv.requests;
    cur.output += sv.output;
    cur.total += sv.total;
    for (const m of sv.models) if (!cur.models.includes(m)) cur.models.push(m);
  }
}

export function emptyIndex(): UsageIndex {
  return {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    files: {},
    totals: emptyTotals(),
    daily: {},
    hourly: {},
    models: {},
    projects: {},
    sessions: {},
    recent: [],
    activeDays: {},
    prompts: { total: 0, daily: {}, lastAt: null, offset: 0, size: 0 },
    latest: { ts: null, model: null, sessionId: null, version: null, cwd: null },
    lastScanMs: 0,
    unavailable: false,
  };
}

async function listTranscripts(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listTranscripts(p)));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/*
 * There is deliberately no rate-limit metric.
 *
 * A limit only ever appears as free text inside a transcript, and a text match
 * cannot tell an actual limit event apart from an assistant message discussing
 * rate limiting. A first attempt reported 200 events, which was simply its own
 * cap: it had matched conversations about building rate limiters. Counting
 * those would have been fabrication, so the metric is gone rather than wrong.
 */

/**
 * Read one transcript from `fromOffset` to `size`, folding records into the
 * index. Returns the new offset. Never throws: a damaged file costs that file
 * only.
 *
 * THE READ IS BOUNDED AT `size` ON PURPOSE, and the offset that comes back
 * counts only bytes of COMPLETE lines.
 *
 * It used to read to EOF while returning the size stat'd before the read.
 * Claude Code appends to these files continuously, so anything written during
 * the scan was folded into the totals AND left below the recorded offset, and
 * the next pass read the same bytes again. Every token in that window was
 * counted twice. It was found by writing 1,000 records into a 26 MB transcript
 * 60 ms into a 350 ms scan: the second pass reached 122,000 records where
 * 121,000 was correct.
 *
 * Bounding the read alone would trade one bug for a quieter one. `size` can
 * land mid-line while the writer is between a record and its newline, and an
 * offset set flatly to `size` would skip the remainder of that record forever.
 * So the returned offset is walked back to the end of the last complete line,
 * and the partial tail is read again next pass, when it is whole.
 */
async function ingestFile(
  index: UsageIndex,
  contrib: FileContribution,
  file: string,
  fromOffset: number,
  size: number,
): Promise<number> {
  if (size <= fromOffset) return fromOffset;

  const hourlyCutoff = Date.now() - HOURLY_DAYS * 86_400_000;
  let processed = 0;

  try {
    // end is inclusive, so this is exactly the bytes that were stat'd.
    const stream = createReadStream(file, { encoding: 'utf8', start: fromOffset, end: size - 1 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    // Bytes of complete lines only. A trailing partial line is not counted, so
    // it is read again next pass rather than skipped.
    let consumed = 0;
    let lastLineBytes = 0;
    let sawAnyLine = false;

    for await (const line of rl) {
      lastLineBytes = Buffer.byteLength(line, 'utf8') + 1;
      consumed += lastLineBytes;
      sawAnyLine = true;
      // Yield to the event loop periodically. The cold index is several seconds
      // of work and the wall must stay responsive while it runs.
      if (++processed % 2000 === 0) await new Promise((r) => setImmediate(r));

      if (line.length < 40) continue;

      // Cheap prefilter: only assistant records carry a usage block.
      if (!line.includes('"usage"')) continue;

      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // truncated final line during an active write, or corruption
      }

      const u = o?.message?.usage;
      if (!u || typeof u !== 'object') continue;

      const model: string = typeof o?.message?.model === 'string' ? o.message.model : 'unknown';

      /*
       * The two cache TTLs are priced differently, 1.25x base for five minutes
       * and 2x for an hour, so the split matters and the record carries it.
       * Falling back to the undivided total as 5m would understate a long
       * session, which is exactly the sessions that cost anything.
       */
      const write1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
      const write5m =
        u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - write1h);

      const cost = costOf(model, {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite5m: write5m,
        cacheWrite1h: write1h,
        webSearch: u.server_tool_use?.web_search_requests || 0,
      });

      const rec: TokenTotals = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        thinking: u.output_tokens_details?.thinking_tokens || 0,
        requests: 1,
        webSearch: u.server_tool_use?.web_search_requests || 0,
        webFetch: u.server_tool_use?.web_fetch_requests || 0,
        costUsd: cost ?? 0,
        unpricedTokens:
          cost === null
            ? (u.input_tokens || 0) + (u.output_tokens || 0) +
              (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
            : 0,
      };

      const ts: string | null = typeof o.timestamp === 'string' ? o.timestamp : null;
      const tsMs = ts ? Date.parse(ts) : NaN;
      /*
       * Projects group case-insensitively (inside `fold`). Claude Code records
       * the working directory with whatever drive-letter case the shell used,
       * so the same folder shows up as both "C:\..." and "c:\..." and was being
       * counted as two separate projects with the same display name.
       */
      const meta = {
        model,
        ts,
        tsMs,
        cwd: typeof o.cwd === 'string' ? o.cwd : null,
        sid: typeof o.sessionId === 'string' ? o.sessionId : null,
      };
      // Into the index AND into this file's own record of what it added. Both
      // through the same function, so the archive can never disagree with the
      // numbers it replaces.
      fold(index, rec, meta);
      fold(contrib, rec, meta);
      /*
       * The same condition and the same local day as `activeDays` in fold, so
       * for every file the slots' request counts add up to its activeDays; the
       * suite pins that equality. Records with no cwd go under "": their tokens
       * are in the curve even though there is no project to name.
       */
      if (ts && Number.isFinite(tsMs)) {
        foldIntraday(
          (contrib.intraday ??= {}),
          localDayKey(tsMs),
          meta.cwd === null ? '' : meta.cwd.toLowerCase(),
          bucketOf(tsMs),
          [1, rec.input + rec.output + rec.cacheCreate + rec.cacheRead, rec.output],
        );
      }

      if (ts) {
        if (Number.isFinite(tsMs) && tsMs >= hourlyCutoff) {
          const hour = ts.slice(0, 13);
          index.hourly[hour] ??= emptyTotals();
          addInto(index.hourly[hour], rec);
        }

        if (Number.isFinite(tsMs)) {
          const total = rec.input + rec.output + rec.cacheCreate + rec.cacheRead;
          index.recent.push([tsMs, total, rec.output]);
        }

        if (!index.latest.ts || ts > index.latest.ts) {
          index.latest = {
            ts,
            model,
            sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
            version: typeof o.version === 'string' ? o.version : null,
            cwd: typeof o.cwd === 'string' ? o.cwd : null,
          };
        }
      }

    }
    rl.close();

    /*
     * If the slice did not end on a newline, readline still handed us the
     * trailing fragment as a line. Its bytes must not be counted, or the rest
     * of that record is skipped when the writer finishes it.
     */
    if (sawAnyLine && consumed > size - fromOffset) consumed -= lastLineBytes;
    return fromOffset + Math.max(0, consumed);
  } catch {
    // Unreadable or mid-write file: keep the old offset and try again next pass.
    return fromOffset;
  }
}

/**
 * What the indexer needs from the history store, and nothing more. Implemented
 * by src/main/data/history.ts; tests pass their own.
 *
 * THE INVARIANT: a transcript path is in exactly one of `index.files` and the
 * history store. That is what makes double counting impossible rather than
 * merely unlikely: history is not a running sum to be corrected, it is the set
 * of contributions whose file is gone.
 */
export interface HistoryPort {
  /** False when the store could not be read. Then nothing is archived and nothing removed. */
  readonly ready: boolean;
  has(path: string): boolean;
  /** Persist these contributions. Resolves true only once they are safely on disk. */
  archive(entries: { path: string; contrib: FileContribution; reason: 'deleted' | 'stale-cache' }[]): Promise<boolean>;
  /** A held path is back on disk: drop it from history so it is measured live instead. */
  release(paths: string[]): Promise<boolean>;
  /** Prompt counts per day that a rewritten history.jsonl no longer contains. */
  archivePrompts(lost: Record<string, number>): Promise<boolean>;
}

export interface RefreshOptions {
  history?: HistoryPort;
  /** Contributions from a cache of another version, handed over by loadIndex. */
  staleFiles?: Record<string, FileContribution>;
}

/**
 * Is this path really gone, as opposed to unreadable for a moment?
 *
 * Only "not found" counts. A lock (EPERM, EBUSY) from an antivirus or a backup
 * scanner must never archive anything: the file is still there, and archiving
 * it would move its numbers out, rebuild, then read it again a minute later.
 * Absence from the directory listing is not evidence either, because
 * listTranscripts quietly skips any folder it cannot read.
 */
async function isGone(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/**
 * Read history.jsonl from `from` up to `size`, into fresh counts.
 *
 * Returns null unless the read reached `size`: a partial read must never be
 * treated as the file's contents, or a rewrite caught halfway would look like
 * prompts that no longer exist.
 */
async function readPrompts(
  from: number,
  size: number,
): Promise<{ total: number; daily: Record<string, number>; lastAt: string | null } | null> {
  const out = { total: 0, daily: {} as Record<string, number>, lastAt: null as string | null };
  let read = from;
  try {
    const stream = createReadStream(HISTORY_FILE, { encoding: 'utf8', start: from, end: size - 1 });
    stream.on('data', (chunk) => {
      read += Buffer.byteLength(chunk as string, 'utf8');
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length < 10) continue;
      try {
        const o = JSON.parse(line) as { timestamp?: number };
        if (typeof o.timestamp !== 'number') continue;
        const iso = new Date(o.timestamp).toISOString();
        out.total += 1;
        const day = iso.slice(0, 10);
        out.daily[day] = (out.daily[day] || 0) + 1;
        if (!out.lastAt || iso > out.lastAt) out.lastAt = iso;
      } catch {
        /* skip */
      }
    }
    rl.close();
  } catch {
    return null;
  }
  return read >= size ? out : null;
}

/** Prompts the user actually submitted, from history.jsonl. Append-only, until it is not. */
async function ingestHistory(index: UsageIndex, port?: HistoryPort): Promise<void> {
  let size = 0;
  try {
    size = (await fs.stat(HISTORY_FILE)).size;
  } catch {
    return;
  }
  const p = index.prompts;

  if (size < p.offset || p.pendingShrink !== undefined) {
    /*
     * Rewritten shorter. This used to start over at zero, so a trimmed
     * history.jsonl made the prompt count fall. Now the prompts it no longer
     * holds are moved into history, day by day. Two guards, because a single
     * look at a file being rewritten is not evidence of anything:
     *
     * 1. Act only once the size has held still for a whole pass. Seen mid
     *    rewrite (0 bytes, or half written), the "lost" prompts would be
     *    archived and then read again when the writer finished.
     * 2. Apply only a read that reached the end. A failed read changes nothing.
     *
     * Without a ready store the old counts are kept: stale beats lower.
     */
    if (p.pendingShrink !== size) {
      index.prompts = { ...p, pendingShrink: size };
      return;
    }
    if (!port?.ready) return;
    const fresh = size > 0 ? await readPrompts(0, size) : { total: 0, daily: {}, lastAt: null };
    if (!fresh) return;
    const lost: Record<string, number> = {};
    for (const [day, n] of Object.entries(p.daily)) {
      const gone = n - (fresh.daily[day] || 0);
      if (gone > 0) lost[day] = gone;
    }
    if (Object.keys(lost).length && !(await port.archivePrompts(lost))) return; // retried next pass
    index.prompts = { ...fresh, offset: size, size };
    return;
  }
  if (size === p.offset) return;

  const more = await readPrompts(p.offset, size);
  if (!more) return; // leave the offset alone and retry next pass
  const daily = { ...p.daily };
  for (const [d, n] of Object.entries(more.daily)) daily[d] = (daily[d] || 0) + n;
  index.prompts = {
    total: p.total + more.total,
    daily,
    lastAt: more.lastAt && (!p.lastAt || more.lastAt > p.lastAt) ? more.lastAt : p.lastAt,
    offset: size,
    size,
  };
}

/** Trim unbounded structures so the cache stays small and load stays fast. */
function prune(index: UsageIndex): void {
  if (index.recent.length > RECENT_EVENTS) {
    index.recent.sort((a, b) => a[0] - b[0]);
    index.recent = index.recent.slice(-RECENT_EVENTS);
  }
  const cutoff = new Date(Date.now() - HOURLY_DAYS * 86_400_000).toISOString().slice(0, 13);
  for (const k of Object.keys(index.hourly)) if (k < cutoff) delete index.hourly[k];
}

/**
 * Refresh the index in place.
 *
 * Only files that grew are read, and only from their last offset. A file that
 * shrank was rewritten, so its aggregates cannot be un-added: that is the one
 * case requiring a full rebuild, which is why `onShrink` is reported upward.
 */
export interface IndexProgress {
  /** Files whose bytes have been read so far. */
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
  /** True for the expensive first pass, false for an incremental top-up. */
  cold: boolean;
}

export async function refreshIndex(
  index: UsageIndex,
  onProgress?: (p: IndexProgress) => void,
  opts: RefreshOptions = {},
): Promise<{ index: UsageIndex; rebuilt: boolean }> {
  const started = Date.now();
  const port = opts.history;

  let files: string[];
  try {
    await fs.access(PROJECTS_DIR);
    files = await listTranscripts(PROJECTS_DIR);
  } catch (err) {
    index.unavailable = true;
    index.unavailableReason = `cannot read ${PROJECTS_DIR}: ${(err as Error).message}`;
    index.lastScanMs = Date.now() - started;
    return { index, rebuilt: false };
  }

  index.unavailable = false;
  delete index.unavailableReason;

  /*
   * History first: nothing the wall has counted may be lost to a deletion.
   *
   * 1. RESTORES. A path history holds that is back on disk is released, so it
   *    is measured live instead, never counted in both. If the release cannot
   *    be saved, the file is left unread this pass for the same reason.
   * 2. DELETIONS. A path the index knew (or a stale cache handed over) that is
   *    confirmed gone has its contribution archived, and only once that is on
   *    disk is it dropped and the index rebuilt from the files that remain.
   *    The live aggregates cannot subtract, so rebuilding is the only exact
   *    way; deletions arrive in batches at Claude Code startup, so it is rare.
   *
   * Without a ready store, none of this runs: the index stays incremental and
   * keeps counting a deleted file's numbers, which is the old behaviour and
   * loses nothing.
   */
  const unreadThisPass = new Set<string>();
  if (port?.ready) {
    const held = files.filter((f) => port.has(f));
    if (held.length && !(await port.release(held))) for (const f of held) unreadThisPass.add(f);

    const listed = new Set(files);
    const candidates: { path: string; contrib: FileContribution; reason: 'deleted' | 'stale-cache' }[] = [];
    for (const [p, e] of Object.entries(index.files)) {
      if (!listed.has(p) && e?.contrib) candidates.push({ path: p, contrib: e.contrib, reason: 'deleted' });
    }
    for (const [p, c] of Object.entries(opts.staleFiles ?? {})) {
      if (!listed.has(p) && !index.files[p] && !port.has(p)) candidates.push({ path: p, contrib: c, reason: 'stale-cache' });
    }
    const gone: typeof candidates = [];
    for (const c of candidates) if (await isGone(c.path)) gone.push(c);

    if (gone.length && (await port.archive(gone)) && gone.some((g) => g.reason === 'deleted')) {
      return rebuildKeeping(index, onProgress, port);
    }
  }

  // A shrunk file means its contents changed underneath us, and incremental
  // aggregates cannot be reversed. Rebuild from scratch rather than serve
  // numbers we know are wrong. (A deleted file that could not be archived is
  // carried through the rebuild by rebuildKeeping, never dropped.)
  for (const f of files) {
    const known = index.files[f];
    if (!known) continue;
    let size = 0;
    try {
      size = (await fs.stat(f)).size;
    } catch {
      continue;
    }
    if (size < known.size) return rebuildKeeping(index, onProgress, port);
  }

  /*
   * Work out up front how much there is to read, so a cold index can report
   * real progress rather than an indeterminate spinner. A first run is several
   * seconds and the user deserves to know it is working, not stuck.
   */
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
    const known = index.files[f] ?? { size: 0, offset: 0 };
    if (size > known.offset) bytesPending += size - known.offset;
  }

  // A cold pass is one where essentially everything still has to be read.
  const cold = Object.keys(index.files).length === 0 || bytesPending > bytesTotal * 0.5;
  let done = 0;
  let bytesDone = 0;
  let lastReport = 0;

  const report = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    // Throttled: 419 files would otherwise mean 419 IPC messages.
    if (!force && now - lastReport < 120) return;
    lastReport = now;
    onProgress({ done, total: files.length, bytesDone, bytesTotal, cold });
  };

  report(true);

  for (const f of files) {
    const size = sizes.get(f);
    if (size === undefined || unreadThisPass.has(f)) continue;
    const known = index.files[f];
    // A path new to the index starts a fresh contribution, never one left over.
    const contrib = known?.contrib ?? emptyContrib();
    const from = known?.offset ?? 0;
    if (size <= from) {
      index.files[f] = { size, offset: from, contrib };
      done++;
      bytesDone += size;
      report();
      continue;
    }
    const offset = await ingestFile(index, contrib, f, from, size);
    index.files[f] = { size, offset, contrib };
    done++;
    bytesDone += size;
    report();
  }
  report(true);

  await ingestHistory(index, port);
  prune(index);

  index.builtAt = new Date().toISOString();
  index.lastScanMs = Date.now() - started;
  return { index, rebuilt: false };
}

/**
 * Rebuild from the files on disk WITHOUT losing a file the rebuild cannot see.
 *
 * A rebuild only reads what is listed and readable now. A file that is gone
 * but could not be archived (the store failed to save), or that is present
 * but unlisted or locked, would otherwise be in neither the index nor
 * history: its numbers lost, and nothing left to retry. Such a file is carried
 * over with its contribution, so the next pass archives it or reads on from
 * its offset. Prompts are carried too: they come from history.jsonl, not the
 * transcripts, and re-reading them from zero would forget a trimmed file.
 */
async function rebuildKeeping(
  old: UsageIndex,
  onProgress: ((p: IndexProgress) => void) | undefined,
  port: HistoryPort | undefined,
): Promise<{ index: UsageIndex; rebuilt: boolean }> {
  /*
   * Say "indexing" BEFORE anything else. A file just archived is still in the
   * old index until this resolves, so for a moment it is in both the index and
   * history; readers that sum both (the time-lapse) must see a rebuild in
   * progress and wait, not a broken invariant. The first real progress report
   * comes only after every transcript has been listed and stat'd. Zero bytes,
   * so the loading bar ignores it.
   */
  onProgress?.({ done: 0, total: 0, bytesDone: 0, bytesTotal: 0, cold: true });
  const fresh = emptyIndex();
  fresh.prompts = old.prompts;
  const { index } = await refreshIndex(fresh, onProgress, { history: port });
  for (const [p, e] of Object.entries(old.files)) {
    if (index.files[p] || !e?.contrib || port?.has(p)) continue;
    index.files[p] = e;
    absorb(index, e.contrib);
  }
  return { index, rebuilt: true };
}

// ── Cache ──────────────────────────────────────────────────────────────────

/**
 * Load the cache. A cache of another INDEX_VERSION is still discarded, but its
 * per-file contributions are handed back as `staleFiles`, so the first refresh
 * can archive the ones whose transcript no longer exists. Discarding them
 * outright is what halved the wall in 0.9.13.
 */
export async function loadIndex(
  cacheFile: string,
): Promise<{ index: UsageIndex; staleFiles: Record<string, FileContribution> }> {
  try {
    const text = await fs.readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as UsageIndex;
    if (parsed?.version !== INDEX_VERSION) {
      const staleFiles: Record<string, FileContribution> = {};
      for (const [p, e] of Object.entries(parsed?.files ?? {})) {
        if (e?.contrib?.cv === CONTRIB_VERSION) staleFiles[p] = e.contrib;
      }
      return { index: emptyIndex(), staleFiles };
    }
    // Shallow-heal anything a hand edit or partial write could have removed.
    const { pendingStale, ...rest } = parsed;
    return { index: { ...emptyIndex(), ...rest }, staleFiles: pendingStale ?? {} };
  } catch {
    return { index: emptyIndex(), staleFiles: {} };
  }
}

export async function saveIndex(cacheFile: string, index: UsageIndex): Promise<void> {
  const tmp = `${cacheFile}.tmp`;
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(index), 'utf8');
  await fs.rename(tmp, cacheFile);
}

export { PROJECTS_DIR, HISTORY_FILE };
