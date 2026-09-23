/**
 * The time-lapse: one day, drawn through time as three lines.
 *
 * Pure. `buildDaySeries` turns one day's five-minute cells (src/shared/intraday.ts)
 * into the three series the graph draws; `replayFrame` answers "what does the
 * replay show at this many milliseconds in". The overlay is driven by elapsed
 * time rather than by counting frames, so a throttled or dropped frame skips
 * ahead and never makes the replay run long. That is what guarantees it ends.
 *
 * WHAT IS MEASURED AND WHAT IS PACING
 *
 * Every point is a five-minute slot measured at ingest. Only two things are
 * design: how fast the playhead crosses the day, and that the slot under the
 * playhead fills in evenly. At the end the running totals equal the day's
 * measured totals, to the token, and the test suite pins that.
 *
 * THE THREE SERIES
 *
 * Tokens processed, tokens generated and requests, per five minutes: the three
 * words already on the dashboard's hero tiles. A token spike with few requests
 * is one huge context; a request spike with few tokens is a tool loop of many
 * small steps; generated rising is Claude writing rather than reading.
 *
 * "TODAY" IS THE LOCAL DAY, and today stops at now: the current slot's share is
 * measured against the part of it that has actually passed.
 */

import { localDayKey } from './day';
import { BUCKET_MINUTES, BUCKETS_PER_DAY, type DayRaw } from './intraday';

/** Axes, lane names and peaks on screen, nothing moving, so the frame is read before it changes. */
export const LEAD_MS = 700;
/** The playhead crosses the day in this long, linear in elapsed time. */
export const SWEEP_MS = 20_000;
/** Held on the finished day. */
export const HOLD_MS = 2_500;
export const FADE_MS = 450;
/** Under reduced motion the complete day is shown at once and held this long. */
export const REDUCED_HOLD_MS = 10_000;
/** Hard stop, from the moment it opened, whatever the frame rate did. */
export const replayLength = (reduced: boolean): number => (reduced ? REDUCED_HOLD_MS : LEAD_MS + SWEEP_MS + HOLD_MS);

/** The shortest axis, so a day of ten minutes is still a readable graph. */
const MIN_SPAN_MINUTES = 120;

export interface DaySeries {
  day: string;
  today: boolean;
  asOf: number;
  /** Axis start and end, minutes from local midnight, on whole hours. */
  fromMinute: number;
  toMinute: number;
  /** Where the playhead stops: the axis end, or now for today. */
  endMinute: number;
  /** Length 288, zero where nothing happened. */
  tokens: number[];
  output: number[];
  requests: number[];
  /** The busiest project's label in each slot, null where empty. */
  onProject: (string | null)[];
  /** Each lane's fixed scale: that day's highest slot for that series. */
  peaks: { tokens: number; output: number; requests: number };
  /** The slot with the most tokens processed. */
  peak: { bucket: number; tokens: number; label: string | null } | null;
  totals: { tokens: number; output: number; requests: number };
  /** Requests that day that have no five-minute detail (archived before it existed). */
  missingRequests: number;
}

/**
 * The wall-clock minute of the day, the same clock `bucketOf` files slots by.
 * NOT the time elapsed since midnight: on a daylight saving day the two differ
 * by an hour, and the playhead would stop an hour short of the slots (or run an
 * hour ahead of them).
 */
function clockMinute(at: number): number {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60_000;
}

/**
 * The day's three series, or null when there is nothing to draw: a day that
 * only exists as a reconstructed total has no shape, and inventing one would
 * break rule 12. `labelOf` maps a project key and its display path to the label
 * the rest of the wall uses; null for records with no project.
 */
export function buildDaySeries(
  raw: DayRaw,
  labelOf: (key: string, display: string) => string | null,
  now: number = Date.now(),
): DaySeries | null {
  const today = raw.day === localDayKey(now);
  const nowMinute = today ? clockMinute(now) : 24 * 60;

  const tokens = new Array<number>(BUCKETS_PER_DAY).fill(0);
  const output = new Array<number>(BUCKETS_PER_DAY).fill(0);
  const requests = new Array<number>(BUCKETS_PER_DAY).fill(0);
  const busiest: { tokens: number; requests: number; label: string | null }[] = Array.from(
    { length: BUCKETS_PER_DAY },
    () => ({ tokens: -1, requests: -1, label: null }),
  );

  for (const [key, p] of Object.entries(raw.projects ?? {})) {
    const label = labelOf(key, p.display);
    for (const [b, cell] of Object.entries(p.cells ?? {})) {
      const n = Number(b);
      if (!Number.isInteger(n) || n < 0 || n >= BUCKETS_PER_DAY) continue;
      // A slot that starts after now cannot hold a record; a clock skew is not a spike.
      if (n * BUCKET_MINUTES > nowMinute) continue;
      const [r, t, o] = cell;
      requests[n] += r;
      tokens[n] += t;
      output[n] += o;
      const best = busiest[n];
      if (t > best.tokens || (t === best.tokens && r > best.requests) ||
          (t === best.tokens && r === best.requests && (label ?? '') < (best.label ?? '￿'))) {
        busiest[n] = { tokens: t, requests: r, label };
      }
    }
  }

  let first = -1;
  let last = -1;
  for (let b = 0; b < BUCKETS_PER_DAY; b++) {
    if (requests[b] > 0 || tokens[b] > 0) {
      if (first < 0) first = b;
      last = b;
    }
  }
  if (first < 0) return null;

  let fromMinute = Math.floor((first * BUCKET_MINUTES) / 60) * 60;
  const lastEnd = today ? nowMinute : (last + 1) * BUCKET_MINUTES;
  let toMinute = Math.min(24 * 60, Math.ceil(lastEnd / 60) * 60);
  if (toMinute - fromMinute < MIN_SPAN_MINUTES) {
    toMinute = Math.min(24 * 60, fromMinute + MIN_SPAN_MINUTES);
    fromMinute = Math.max(0, toMinute - MIN_SPAN_MINUTES);
  }
  // Today's playhead stops at now. Never exactly at the axis start, or the
  // sweep would divide by zero on the first record of the day.
  const endMinute = today ? Math.min(toMinute, Math.max(fromMinute + 1 / 60, nowMinute)) : toMinute;

  const onProject = busiest.map((b, i) => (requests[i] > 0 || tokens[i] > 0 ? b.label : null));
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  let peak: DaySeries['peak'] = null;
  for (let b = 0; b < BUCKETS_PER_DAY; b++) {
    if (tokens[b] > 0 && (!peak || tokens[b] > peak.tokens)) peak = { bucket: b, tokens: tokens[b], label: onProject[b] };
  }

  return {
    day: raw.day,
    today,
    asOf: now,
    fromMinute,
    toMinute,
    endMinute,
    tokens,
    output,
    requests,
    onProject,
    peaks: { tokens: Math.max(...tokens), output: Math.max(...output), requests: Math.max(...requests) },
    peak,
    totals: { tokens: sum(tokens), output: sum(output), requests: sum(requests) },
    missingRequests: Math.max(0, raw.requests - raw.shapedRequests),
  };
}

export interface ReplayFrame {
  /** 0 to 1 through the sweep. */
  t: number;
  /** The playhead, minutes from local midnight. */
  minute: number;
  /** Slots before this one are shown whole. */
  revealed: number;
  /** How much of slot `revealed` has been shown, 0 to 1. */
  frac: number;
  /** Running totals. Never go backwards; equal the day's totals at t = 1. */
  totals: DaySeries['totals'];
  onProject: string | null;
  peakShown: boolean;
  done: boolean;
}

/** The end of a slot, clipped to where the playhead stops (today's current slot ends at now). */
const slotEnd = (s: DaySeries, b: number): number => Math.min((b + 1) * BUCKET_MINUTES, s.endMinute);

/**
 * The replay at `elapsedMs` since it opened. Under reduced motion there is no
 * sweep: the finished day, for any elapsed time.
 */
export function replayFrame(s: DaySeries, elapsedMs: number, reduced = false): ReplayFrame {
  const t = reduced ? 1 : Math.max(0, Math.min(1, (elapsedMs - LEAD_MS) / SWEEP_MS));
  const minute = t >= 1 ? s.endMinute : s.fromMinute + t * (s.endMinute - s.fromMinute);

  let revealed = Math.min(BUCKETS_PER_DAY, Math.floor(minute / BUCKET_MINUTES));
  let frac = 0;
  if (revealed < BUCKETS_PER_DAY) {
    const start = revealed * BUCKET_MINUTES;
    const end = slotEnd(s, revealed);
    frac = end <= start ? 1 : Math.max(0, Math.min(1, (minute - start) / (end - start)));
    // Today's current slot, complete at now: count it as whole.
    if (frac >= 1) {
      revealed += 1;
      frac = 0;
    }
  }

  const totals = { tokens: 0, output: 0, requests: 0 };
  for (let b = 0; b < revealed; b++) {
    totals.tokens += s.tokens[b];
    totals.output += s.output[b];
    totals.requests += s.requests[b];
  }
  if (revealed < BUCKETS_PER_DAY && frac > 0) {
    totals.tokens += s.tokens[revealed] * frac;
    totals.output += s.output[revealed] * frac;
    totals.requests += s.requests[revealed] * frac;
  }

  const under = Math.min(BUCKETS_PER_DAY - 1, Math.floor(Math.min(minute, s.endMinute - 1e-9) / BUCKET_MINUTES));
  return {
    t,
    minute,
    revealed,
    frac,
    totals,
    // Blank until the playhead moves, and under reduced motion, which has no playhead.
    onProject: t > 0 && !reduced ? s.onProject[Math.max(0, under)] ?? null : null,
    peakShown: !!s.peak && revealed > s.peak.bucket,
    done: t >= 1,
  };
}

/** "09:05" for minutes since midnight; the end of the day reads "24:00", as the axis does. */
export function hhmm(minute: number): string {
  if (minute >= 24 * 60) return '24:00';
  const m = Math.max(0, Math.floor(minute));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
