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
 * the streak milestone. One cold reindex on first launch after the update.
 */
const INDEX_VERSION = 4;

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

export interface UsageIndex {
  version: number;
  builtAt: string;
  /** Byte offsets so a refresh only reads what was appended. */
  files: Record<string, { size: number; offset: number }>;
  totals: TokenTotals;
  daily: Record<string, TokenTotals>;
  hourly: Record<string, TokenTotals>;
  models: Record<string, TokenTotals>;
  projects: Record<string, TokenTotals & { lastSeen: string; display: string }>;
  sessions: Record<string, SessionInfo>;
  /** [epochMs, totalTokens, outputTokens] for the most recent records. */
  recent: [number, number, number][];
  /**
   * Per project, per UTC hour: [requests, totalTokens, outputTokens].
   *
   * The work time-lapse replays today project by project, and nothing else in
   * the index knows WHICH project was busy in which hour. Spreading a session's
   * tokens evenly across its span would be inventing a shape, so this is
   * measured at ingest instead. Keyed like `hourly` (UTC hour, then the same
   * lowercased cwd key as `projects`) and pruned with it, so it stays small.
   */
  projectHourly: Record<string, Record<string, [number, number, number]>>;
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
  prompts: { total: number; daily: Record<string, number>; lastAt: string | null; offset: number; size: number };
  latest: { ts: string | null; model: string | null; sessionId: string | null; version: string | null; cwd: string | null };
  /** Wall-clock ms of parse work in the last refresh. */
  lastScanMs: number;
  /**
   * All time peak tokens per minute. Attached in memory before each push and
   * deliberately NOT trusted from the cache file: a version bump discards this
   * whole index, and a record must outlive that. See src/main/data/peak.ts.
   */
  peak?: PeakVelocity | null;
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
    projectHourly: {},
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
async function ingestFile(index: UsageIndex, file: string, fromOffset: number, size: number): Promise<number> {
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

      addInto(index.totals, rec);

      const ts: string | null = typeof o.timestamp === 'string' ? o.timestamp : null;

      index.models[model] ??= emptyTotals();
      addInto(index.models[model], rec);

      if (typeof o.cwd === 'string') {
        /*
         * Group case-insensitively. Claude Code records the working directory
         * with whatever drive-letter case the shell used, so the same folder
         * shows up as both "C:\..." and "c:\..." and was being counted as two
         * separate projects with the same display name.
         */
        const key = o.cwd.toLowerCase();
        index.projects[key] ??= { ...emptyTotals(), lastSeen: ts ?? '', display: o.cwd };
        addInto(index.projects[key], rec);
        if (ts && ts > index.projects[key].lastSeen) index.projects[key].lastSeen = ts;
      }

      if (ts) {
        const day = ts.slice(0, 10);
        index.daily[day] ??= emptyTotals();
        addInto(index.daily[day], rec);

        const tsMs = Date.parse(ts);
        if (Number.isFinite(tsMs) && tsMs >= hourlyCutoff) {
          const hour = ts.slice(0, 13);
          index.hourly[hour] ??= emptyTotals();
          addInto(index.hourly[hour], rec);

          if (typeof o.cwd === 'string') {
            const bucket = (index.projectHourly[hour] ??= {});
            const cell = (bucket[o.cwd.toLowerCase()] ??= [0, 0, 0]);
            cell[0] += 1;
            cell[1] += rec.input + rec.output + rec.cacheCreate + rec.cacheRead;
            cell[2] += rec.output;
          }
        }

        if (Number.isFinite(tsMs)) {
          const day = localDayKey(tsMs);
          index.activeDays[day] = (index.activeDays[day] || 0) + 1;
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

      const sid: string | null = typeof o.sessionId === 'string' ? o.sessionId : null;
      if (sid && ts) {
        const s = (index.sessions[sid] ??= {
          id: sid,
          start: ts,
          end: ts,
          requests: 0,
          output: 0,
          total: 0,
          cwd: typeof o.cwd === 'string' ? o.cwd : null,
          models: [],
        });
        if (ts < s.start) s.start = ts;
        if (ts > s.end) s.end = ts;
        s.requests += 1;
        s.output += rec.output;
        s.total += rec.input + rec.output + rec.cacheCreate + rec.cacheRead;
        if (!s.models.includes(model)) s.models.push(model);
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

/** Prompts the user actually submitted, from history.jsonl. Append-only too. */
async function ingestHistory(index: UsageIndex): Promise<void> {
  let size = 0;
  try {
    size = (await fs.stat(HISTORY_FILE)).size;
  } catch {
    return;
  }
  if (size < index.prompts.offset) {
    // Rewritten, start over.
    index.prompts = { total: 0, daily: {}, lastAt: null, offset: 0, size: 0 };
  }
  if (size <= index.prompts.offset) return;

  try {
    const stream = createReadStream(HISTORY_FILE, { encoding: 'utf8', start: index.prompts.offset });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length < 10) continue;
      try {
        const o = JSON.parse(line) as { timestamp?: number };
        if (typeof o.timestamp !== 'number') continue;
        const iso = new Date(o.timestamp).toISOString();
        index.prompts.total += 1;
        const day = iso.slice(0, 10);
        index.prompts.daily[day] = (index.prompts.daily[day] || 0) + 1;
        if (!index.prompts.lastAt || iso > index.prompts.lastAt) index.prompts.lastAt = iso;
      } catch {
        /* skip */
      }
    }
    rl.close();
    index.prompts.offset = size;
    index.prompts.size = size;
  } catch {
    /* leave the offset alone and retry next pass */
  }
}

/** Trim unbounded structures so the cache stays small and load stays fast. */
function prune(index: UsageIndex): void {
  if (index.recent.length > RECENT_EVENTS) {
    index.recent.sort((a, b) => a[0] - b[0]);
    index.recent = index.recent.slice(-RECENT_EVENTS);
  }
  const cutoff = new Date(Date.now() - HOURLY_DAYS * 86_400_000).toISOString().slice(0, 13);
  for (const k of Object.keys(index.hourly)) if (k < cutoff) delete index.hourly[k];
  for (const k of Object.keys(index.projectHourly)) if (k < cutoff) delete index.projectHourly[k];
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
): Promise<{ index: UsageIndex; rebuilt: boolean }> {
  const started = Date.now();

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

  // A shrunk file means its contents changed underneath us, and incremental
  // aggregates cannot be reversed. Rebuild from scratch rather than serve
  // numbers we know are wrong.
  for (const f of files) {
    const known = index.files[f];
    if (!known) continue;
    let size = 0;
    try {
      size = (await fs.stat(f)).size;
    } catch {
      continue;
    }
    if (size < known.size) {
      const fresh = emptyIndex();
      const rebuilt = await refreshIndex(fresh, onProgress);
      return { index: rebuilt.index, rebuilt: true };
    }
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
    if (size === undefined) continue;
    const known = index.files[f] ?? { size: 0, offset: 0 };
    if (size <= known.offset) {
      index.files[f] = { size, offset: known.offset };
      done++;
      bytesDone += size;
      report();
      continue;
    }
    const offset = await ingestFile(index, f, known.offset, size);
    index.files[f] = { size, offset };
    done++;
    bytesDone += size;
    report();
  }
  report(true);

  await ingestHistory(index);
  prune(index);

  index.builtAt = new Date().toISOString();
  index.lastScanMs = Date.now() - started;
  return { index, rebuilt: false };
}

// ── Cache ──────────────────────────────────────────────────────────────────

export async function loadIndex(cacheFile: string): Promise<UsageIndex> {
  try {
    const text = await fs.readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as UsageIndex;
    if (parsed?.version !== INDEX_VERSION) return emptyIndex();
    // Shallow-heal anything a hand edit or partial write could have removed.
    return { ...emptyIndex(), ...parsed };
  } catch {
    return emptyIndex();
  }
}

export async function saveIndex(cacheFile: string, index: UsageIndex): Promise<void> {
  const tmp = `${cacheFile}.tmp`;
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(index), 'utf8');
  await fs.rename(tmp, cacheFile);
}

export { PROJECTS_DIR, HISTORY_FILE };
