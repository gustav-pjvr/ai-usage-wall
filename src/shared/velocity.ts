/**
 * Tokens per minute over a trailing window.
 *
 * This lives in shared/ for one reason: the live number and the all time record
 * must be the same measurement. The live figure is computed in the renderer and
 * the record is computed in the main process, and if each carried its own copy
 * of this arithmetic they would drift, leaving a card that shows a record the
 * current reading could never reach or beat. One function, two callers.
 */

/** The window velocity is averaged over. Ten minutes, matching the card's note. */
export const VELOCITY_WINDOW_MS = 10 * 60 * 1000;

/** [epochMs, totalTokens, outputTokens], oldest first, as the index stores it. */
export type RecentRecord = [number, number, number];

/** The window in minutes, which is the divisor. Ten. */
const WINDOW_MIN = VELOCITY_WINDOW_MS / 60_000;

/**
 * Average tokens per minute over the last ten minutes.
 *
 * Divided by the WINDOW, not by the time since the oldest record in it. That
 * distinction is the whole of this comment.
 *
 * It used to divide by `now - earliest`, which meant the divisor grew while the
 * numerator sat still, so a figure fell by 65 percent between minute three and
 * minute nine with no new work at all: same three records, 2.65M tokens, and a
 * reading that went 847K, 642K, 517K, 432K, 372K. A 1/t curve, which is exactly
 * what "drops a little then plateaus" looks like. Gustav spotted it because the
 * wall said Claude had been quiet for seven minutes and the rate beside it was
 * still half a million a minute.
 *
 * It was also not what the card claimed. The label said "trailing 10 minutes",
 * which is this, not that. A number that moves while the facts do not is the
 * kind of wrong that looks like a feature.
 *
 * Now: work in the window, divided by the window. It holds steady while those
 * records are in view and falls as they age out, reaching zero ten minutes
 * after the last one.
 */
export function velocityOf(recent: readonly RecentRecord[], now: number = Date.now()): number {
  let windowTokens = 0;
  for (const [ts, total] of recent) {
    if (now - ts <= VELOCITY_WINDOW_MS) windowTokens += total;
  }
  if (windowTokens <= 0) return 0;
  return windowTokens / WINDOW_MIN;
}

/** The persisted high water mark. */
export interface PeakVelocity {
  /** Tokens per minute. */
  velocity: number;
  /** When it was reached, ISO 8601. */
  at: string;
}
