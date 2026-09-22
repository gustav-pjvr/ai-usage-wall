/**
 * The work time-lapse: today so far, replayed in about twenty seconds.
 *
 * Pure. `buildWorkDay` turns the measured per-project hourly buckets into
 * today's shape; `replayState` answers "what does the replay show at this many
 * milliseconds in", so the overlay is driven by elapsed time rather than by
 * counting frames. A throttled or dropped frame skips ahead; it never makes the
 * replay run long, which is what guarantees it always ends.
 *
 * WHAT IS MEASURED AND WHAT IS PACING
 *
 * Every hour's tokens per project are measured at ingest (usage.ts
 * `projectHourly`). The order projects light up in follows from those hours,
 * so it is measured too. Only two things are design: how fast the clock runs,
 * and that tokens inside the hour currently being revealed are shown filling in
 * evenly. At the end every project's total equals its measured total for the
 * day, to the token, and the test suite pins that.
 *
 * "TODAY" IS THE LOCAL DAY
 *
 * Hour keys are UTC. Each is converted to a real moment and then to the local
 * hour, so on this machine the 22:00 UTC bucket of yesterday's date is 00:00
 * today. The daily chart is still keyed by UTC date, by Gustav's choice; this
 * does not depend on changing that.
 */

import { hourKeyMs, localDayStart } from './day';

export const REPLAY_MS = 20_000;

export interface WorkProject {
  key: string;
  label: string;
  total: number;
  /** The first local hour of today with work on this project. */
  firstHour: number;
}

export interface WorkDay {
  /** Local midnight at the start of today, epoch ms. */
  dayStart: number;
  /** The moment the day was built. The replay stops here. */
  asOf: number;
  /** Local hours the replay spans: from the first active hour to the current one, inclusive. */
  fromHour: number;
  toHour: number;
  /**
   * Where the replay clock stops: the local time of `asOf`, as fractional hours.
   * Not the end of the current hour. Ending at toHour + 1 made the clock read
   * 09:59 at 09:05 and showed the current hour's tokens arriving across minutes
   * that had not happened yet, which is a shape the data does not contain.
   */
  endAt: number;
  /** tokens[hour][projectKey], local hours 0 to 23. */
  tokens: Record<string, number>[];
  projects: WorkProject[];
  total: number;
}

type ProjectHourly = Record<string, Record<string, [number, number, number]>>;

/**
 * Today's work, or null when nothing has been recorded yet today. `labelOf`
 * maps a project key to the label the rest of the wall uses.
 */
export function buildWorkDay(
  projectHourly: ProjectHourly | undefined,
  labelOf: (key: string) => string,
  now: number = Date.now(),
): WorkDay | null {
  const dayStart = localDayStart(now);
  const tokens: Record<string, number>[] = Array.from({ length: 24 }, () => ({}));
  const totals = new Map<string, number>();
  const first = new Map<string, number>();
  let any = false;

  for (const [hourKey, byProject] of Object.entries(projectHourly ?? {})) {
    const ms = hourKeyMs(hourKey);
    if (!Number.isFinite(ms) || ms < dayStart || ms > now) continue;
    const hour = new Date(ms).getHours();
    for (const [key, cell] of Object.entries(byProject ?? {})) {
      const t = Array.isArray(cell) ? Number(cell[1]) || 0 : 0;
      if (t <= 0) continue;
      any = true;
      tokens[hour][key] = (tokens[hour][key] || 0) + t;
      totals.set(key, (totals.get(key) || 0) + t);
      if (!first.has(key) || hour < first.get(key)!) first.set(key, hour);
    }
  }
  if (!any) return null;

  const projects: WorkProject[] = [...totals]
    .map(([key, total]) => ({ key, label: labelOf(key), total, firstHour: first.get(key)! }))
    .sort((a, b) => a.firstHour - b.firstHour || b.total - a.total || a.label.localeCompare(b.label));

  const fromHour = Math.min(...projects.map((p) => p.firstHour));
  const at = new Date(now);
  const toHour = Math.max(fromHour, at.getHours());
  const endAt = Math.max(fromHour + 1 / 60, at.getHours() + at.getMinutes() / 60 + at.getSeconds() / 3600);
  return {
    dayStart,
    asOf: now,
    fromHour,
    toHour,
    endAt,
    tokens,
    projects,
    total: [...totals.values()].reduce((a, b) => a + b, 0),
  };
}

export interface ReplayFrame {
  /** 0 to 1 through the replay. */
  t: number;
  /** The replay clock, in fractional local hours. */
  clock: number;
  /** Cumulative tokens per project so far. */
  perProject: Record<string, number>;
  /** Tokens revealed in each hour so far, for the trace. */
  byHour: number[];
  total: number;
  done: boolean;
}

/**
 * The replay at `elapsedMs`. `steps` > 0 quantises time into that many
 * jumps, for reduced motion: the same story, told in a few frames.
 */
export function replayState(day: WorkDay, elapsedMs: number, durationMs = REPLAY_MS, steps = 0): ReplayFrame {
  let t = Math.max(0, Math.min(1, elapsedMs / durationMs));
  if (steps > 0) t = Math.floor(t * steps) / steps;
  const span = day.endAt - day.fromHour;
  const clock = day.fromHour + t * span;

  const perProject: Record<string, number> = {};
  const byHour = new Array(24).fill(0);
  let total = 0;
  for (let h = day.fromHour; h <= day.toHour; h++) {
    // 1 for an hour already passed, the fraction for the hour being revealed,
    // 0 for hours still ahead. The CURRENT hour only runs up to endAt, so its
    // share is measured against the part of it that has actually happened, and
    // reaches 1 exactly when the clock reaches now.
    const hourEnd = Math.min(h + 1, day.endAt);
    const f = hourEnd <= h ? 0 : Math.max(0, Math.min(1, (clock - h) / (hourEnd - h)));
    if (f <= 0) continue;
    for (const [key, n] of Object.entries(day.tokens[h])) {
      const v = n * f;
      perProject[key] = (perProject[key] || 0) + v;
      byHour[h] += v;
      total += v;
    }
  }
  return { t, clock, perProject, byHour, total, done: t >= 1 };
}

/** "08:00" for an hour of day. */
export const hh = (h: number): string => `${String(Math.floor(h) % 24).padStart(2, '0')}:00`;
