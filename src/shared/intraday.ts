/**
 * Five-minute detail for any day, for the time-lapse.
 *
 * WHERE IT LIVES, and why nowhere else
 *
 * Every transcript's contribution (usage.ts `FileContribution.intraday`) holds
 * its own records in five-minute slots of the LOCAL day. There is no index-wide
 * copy: a day is summed on demand across the live index's files and the history
 * store's archived entries. A transcript path is in exactly one of those two
 * (the invariant usage.ts and history.ts keep), so the sum is exact, a deleted
 * transcript keeps its curve, and a restored one is counted once.
 *
 * WHY FIVE MINUTES (measured 2026-09-23, 466 transcripts, 43 days)
 *
 * On the busiest day the busiest five minutes held 18% of the busiest hour, so
 * an hourly bar hid the burst entirely. One-minute slots are mostly single
 * records (one cache read of a million tokens is one line) and read as noise,
 * and 1,440 slots is more than a 1366-wide graph has pixels.
 *
 * Pure, and shared so the tests run it without Electron. The shapes are
 * declared structurally because src/shared must not import from src/main.
 * Design: docs/design/timelapse-any-day.md.
 */

import { localDayKey } from './day';

export const BUCKET_MINUTES = 5;
export const BUCKETS_PER_DAY = (24 * 60) / BUCKET_MINUTES;

/** [requests, totalTokens, outputTokens] in one five-minute slot of one local day. */
export type IntradayCell = [number, number, number];
/** localDay -> projectKey (lowercased cwd, as `projects`; "" for no cwd) -> bucket "0".."287" -> cell. */
export type Intraday = Record<string, Record<string, Record<string, IntradayCell>>>;

/** What collectDay and offeredDays need from a contribution, and nothing more. */
export interface IntradaySource {
  contrib?: {
    intraday?: Intraday;
    projects?: Record<string, { display: string }>;
  } | null;
}

/**
 * The five-minute slot of the local day this moment falls in, 0 to 287.
 *
 * Local hours and minutes, the same clock `localDayKey` uses, so a record's
 * slot and its day always agree. On the night the clocks go back the repeated
 * hour folds into the same slots; nothing is dropped.
 */
export function bucketOf(tsMs: number): number {
  const d = new Date(tsMs);
  return Math.floor((d.getHours() * 60 + d.getMinutes()) / BUCKET_MINUTES);
}

/** Add one cell into an intraday map, in place. The ingest accumulator. */
export function foldIntraday(into: Intraday, day: string, projectKey: string, bucket: number, cell: IntradayCell): void {
  const slots = ((into[day] ??= {})[projectKey] ??= {});
  const cur = (slots[String(bucket)] ??= [0, 0, 0]);
  cur[0] += cell[0];
  cur[1] += cell[1];
  cur[2] += cell[2];
}

/** One day, as the main process hands it to the renderer (`wall:timelapseDay`). */
export interface DayRaw {
  day: string;
  asOf: number;
  bucketMinutes: number;
  projects: Record<string, { display: string; cells: Record<string, IntradayCell> }>;
  /** Every request on that local day, from the merged `activeDays` (seed included). */
  requests: number;
  /** The requests that have five-minute detail: the sum of every cell's count. */
  shapedRequests: number;
}

const cellOk = (c: unknown): c is IntradayCell =>
  Array.isArray(c) && c.length === 3 && c.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);

/**
 * Sum one local day across live and archived contributions.
 *
 * Throws if a path is in both: that is the broken invariant, and summing it
 * would count a transcript twice, which is worse than showing nothing.
 */
export function collectDay(
  day: string,
  live: Record<string, IntradaySource>,
  archived: Record<string, IntradaySource>,
  requests: number,
  asOf: number,
): DayRaw {
  for (const p of Object.keys(archived)) {
    if (Object.prototype.hasOwnProperty.call(live, p)) {
      throw new Error(`transcript is both live and archived: ${p}`);
    }
  }
  const projects: DayRaw['projects'] = {};
  let shaped = 0;
  for (const src of [live, archived]) {
    for (const entry of Object.values(src)) {
      const byProject = entry?.contrib?.intraday?.[day];
      if (!byProject) continue;
      for (const [key, slots] of Object.entries(byProject)) {
        const display = entry.contrib?.projects?.[key]?.display ?? '';
        const p = (projects[key] ??= { display, cells: {} });
        if (!p.display && display) p.display = display;
        for (const [b, cell] of Object.entries(slots ?? {})) {
          const n = Number(b);
          if (!Number.isInteger(n) || n < 0 || n >= BUCKETS_PER_DAY || !cellOk(cell)) continue;
          const cur = (p.cells[b] ??= [0, 0, 0]);
          cur[0] += cell[0];
          cur[1] += cell[1];
          cur[2] += cell[2];
          shaped += cell[0];
        }
      }
    }
  }
  return { day, asOf, bucketMinutes: BUCKET_MINUTES, projects, requests: Math.max(requests, 0), shapedRequests: shaped };
}

/** Tokens per five-minute slot of one collected day, all projects together. Length 288. */
export function tokensPerSlot(raw: DayRaw): number[] {
  const out = new Array<number>(BUCKETS_PER_DAY).fill(0);
  for (const p of Object.values(raw.projects)) {
    for (const [b, cell] of Object.entries(p.cells)) out[Number(b)] += cell[1];
  }
  return out;
}

/**
 * Today's LOCAL day as 288 token counts, across live and archived
 * contributions: the simple view's "Today, side by side" lane, the same for
 * Claude and Codex. Null when the live/archived invariant is broken for a
 * moment (a rebuild in progress), so a caller shows nothing rather than a
 * curve that counts a file twice.
 */
export function todaySlotsOf(
  live: Record<string, IntradaySource>,
  archived: Record<string, IntradaySource>,
  now: number = Date.now(),
): number[] | null {
  try {
    return tokensPerSlot(collectDay(localDayKey(now), live, archived, 0, now));
  } catch {
    return null;
  }
}

/** The picker's view of every day (`wall:timelapseDays`). */
export interface TimelapseDays {
  today: string;
  days: Record<string, { requests: number; shaped: number }>;
}

/**
 * Every local day with at least one request, and how much of it has
 * five-minute detail. Reads `activeDays` (local days), never `daily` (UTC).
 */
export function offeredDays(
  activeDays: Record<string, number>,
  live: Record<string, IntradaySource>,
  archived: Record<string, IntradaySource>,
  now: number = Date.now(),
): TimelapseDays {
  const days: TimelapseDays['days'] = {};
  for (const [day, n] of Object.entries(activeDays)) {
    if (n > 0 && /^\d{4}-\d{2}-\d{2}$/.test(day)) days[day] = { requests: n, shaped: 0 };
  }
  for (const src of [live, archived]) {
    for (const entry of Object.values(src)) {
      for (const [day, byProject] of Object.entries(entry?.contrib?.intraday ?? {})) {
        const d = days[day];
        if (!d) continue;
        for (const slots of Object.values(byProject ?? {})) {
          for (const cell of Object.values(slots ?? {})) if (cellOk(cell)) d.shaped += cell[0];
        }
      }
    }
  }
  return { today: localDayKey(now), days };
}

export type DayShape = 'full' | 'partial' | 'total' | 'none';

/** full: every request has detail. partial: some do. total: only a count survives. */
export function dayShape(d: { requests: number; shaped: number } | undefined): DayShape {
  if (!d || d.requests <= 0) return 'none';
  if (d.shaped <= 0) return 'total';
  return d.shaped >= d.requests ? 'full' : 'partial';
}
