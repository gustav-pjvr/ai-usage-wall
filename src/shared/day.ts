/**
 * Local days and hours.
 *
 * The index keys `daily` by the UTC date (`ts.slice(0, 10)`) and `hourly` by
 * the UTC hour (`ts.slice(0, 13)`). On this machine, two hours ahead of UTC,
 * that makes a UTC "day" run from 02:00 to 02:00. Gustav chose to leave the
 * daily chart that way. Everything NEW that talks about "today" or "a day"
 * goes through here instead, so it means the day on the wall's own clock.
 *
 * Hour buckets convert exactly: an hour key names one UTC hour, which is one
 * local hour in any time zone with a whole-hour offset. Real Date objects are
 * used rather than adding a fixed offset, so this stays right anywhere.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of the LOCAL calendar day containing this moment. */
export function localDayKey(at: number | string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Epoch ms of local midnight at the start of the day containing `at`. */
export function localDayStart(at: number | Date = Date.now()): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Epoch ms at the start of a UTC hour key (`YYYY-MM-DDTHH`), or NaN. */
export function hourKeyMs(hourKey: string): number {
  return Date.parse(`${hourKey}:00:00Z`);
}

/** The local hour of day (0 to 23) a UTC hour key falls in, or -1 if malformed. */
export function localHourOf(hourKey: string): number {
  const ms = hourKeyMs(hourKey);
  return Number.isFinite(ms) ? new Date(ms).getHours() : -1;
}

/**
 * The longest run of consecutive local days, and the run ending on the most
 * recent active day. Days are `YYYY-MM-DD` keys; order does not matter.
 *
 * Consecutive is decided by calendar arithmetic on the keys, not by 24 hour
 * steps, so a daylight saving change could never split a run.
 */
export function dayRuns(days: Iterable<string>): { longest: number; current: number; lastDay: string | null } {
  const sorted = [...new Set(days)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!sorted.length) return { longest: 0, current: 0, lastDay: null };
  const next = (key: string): string => {
    const [y, m, d] = key.split('-').map(Number);
    return localDayKey(new Date(y, m - 1, d + 1));
  };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === next(sorted[i - 1]) ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return { longest, current: run, lastDay: sorted[sorted.length - 1] };
}
