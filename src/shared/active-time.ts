/**
 * How many hours Claude has run: the "Hours" block beside Total cost.
 *
 * WHAT IT COUNTS
 *
 * The time Claude was actually working. Two responses in the same transcript
 * at most five minutes apart are joined into one stretch of activity, and the
 * stretches of every transcript (main sessions and subagents alike) are merged,
 * so an hour in which three sessions ran side by side counts as one hour, not
 * three. A pause longer than five minutes (Gustav reading, a lunch break, a
 * session left open overnight) counts nothing.
 *
 * WHY THIS AND NOT THE OBVIOUS SOURCES (measured 2026-10-10, 980 transcripts)
 *
 * - Session start to end: a resumed session keeps its id, and one spans 1107
 *   hours on this machine. Not a duration of anything.
 * - Claude Code's own `turn_duration` records: exact per turn, but only written
 *   since 31 Aug and present in 65 of 972 transcripts, and the turns overlap
 *   (271.8 hours summed, 232.3 hours of distinct time) and include hours spent
 *   waiting on a background task. Used as the yardstick instead: over the
 *   period it covers, its distinct time across all sessions is 199.9 hours, and
 *   this method gives 196.9.
 * - Five-minute slots with any response: 245.2 hours over the same period,
 *   because one response alone counts a whole five minutes.
 *
 * Times are whole seconds, which is what the stored spans hold. Pure and
 * shared, so the tests run it without Electron.
 */

/** Two responses this close together are one stretch of work. */
export const ACTIVE_GAP_S = 5 * 60;

/**
 * One transcript's activity: merged [start, end] stretches in epoch seconds,
 * plus the time of its latest response, so a stretch can continue across the
 * appended chunks an incremental refresh reads.
 */
export interface ActiveSpans {
  last: number;
  spans: [number, number][];
}

/**
 * Add one response at `tsMs`. A response no later than the previous one starts
 * nothing: transcripts are written in order, and time never runs backwards.
 */
export function foldActive(a: ActiveSpans, tsMs: number): void {
  if (!Number.isFinite(tsMs)) return;
  const t = Math.floor(tsMs / 1000);
  if (t <= a.last) return;
  if (a.last > 0 && t - a.last <= ACTIVE_GAP_S) {
    const tail = a.spans[a.spans.length - 1];
    if (tail && tail[1] === a.last) tail[1] = t;
    else a.spans.push([a.last, t]);
  }
  a.last = t;
}

/** What `activeTime` reads from a live file entry or an archived one. */
export interface ActiveSource {
  contrib?: { active?: ActiveSpans } | null;
}

export interface ActiveTime {
  /** Distinct seconds in which Claude was working, all transcripts together. */
  seconds: number;
  /** Epoch ms of the first stretch, or null before any. */
  since: number | null;
}

/**
 * Merge every transcript's stretches into distinct time. Live and archived
 * entries both count, so a deleted transcript keeps its hours; a path is only
 * ever in one of the two (the invariant usage.ts and history.ts keep), and an
 * overlap would merge away here anyway rather than count twice.
 */
export function activeTime(...sources: Record<string, ActiveSource>[]): ActiveTime {
  const all: [number, number][] = [];
  for (const src of sources) {
    for (const entry of Object.values(src)) {
      for (const s of entry?.contrib?.active?.spans ?? []) {
        if (Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0]) all.push([s[0], s[1]]);
      }
    }
  }
  if (!all.length) return { seconds: 0, since: null };
  all.sort((a, b) => a[0] - b[0]);
  let seconds = 0;
  let [cs, ce] = all[0];
  for (let i = 1; i < all.length; i++) {
    const [s, e] = all[i];
    if (s > ce) {
      seconds += ce - cs;
      cs = s;
      ce = e;
    } else if (e > ce) {
      ce = e;
    }
  }
  seconds += ce - cs;
  return { seconds, since: all[0][0] * 1000 };
}

/** Whole hours, never rounded up and never turned into days: "1,284". */
export function formatHours(seconds: number): string {
  const h = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds / 3600) : 0;
  return h.toLocaleString('en-US');
}
