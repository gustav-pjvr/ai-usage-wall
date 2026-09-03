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

/**
 * Tokens per minute across the records inside the window ending at `now`.
 *
 * The span is measured from the EARLIEST record still in the window rather than
 * from the window's full width, so a burst that started two minutes ago is
 * reported as two minutes of work rather than diluted across ten. The one
 * minute floor stops a pair of records milliseconds apart from reporting a rate
 * in the billions.
 */
export function velocityOf(recent: readonly RecentRecord[], now: number = Date.now()): number {
  let windowTokens = 0;
  let earliest = now;
  for (const [ts, total] of recent) {
    if (now - ts <= VELOCITY_WINDOW_MS) {
      windowTokens += total;
      if (ts < earliest) earliest = ts;
    }
  }
  if (windowTokens <= 0) return 0;
  const spanMin = Math.max(1, (now - earliest) / 60000);
  return windowTokens / spanMin;
}

/** The persisted high water mark. */
export interface PeakVelocity {
  /** Tokens per minute. */
  velocity: number;
  /** When it was reached, ISO 8601. */
  at: string;
}
