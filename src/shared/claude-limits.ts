/**
 * Claude's plan limits (docs/design/codex-side-by-side.md, section 5): the
 * reading Claude Code itself keeps under `cachedUsageUtilization` in
 * `~/.claude.json`, shown like Codex's own plan reading.
 *
 * That file also holds account details and OAuth state, so what crosses from
 * the main process to the renderer and over the projection wire is ONLY this
 * shape, rebuilt field by field from plain numbers and short strings:
 *
 *   claudeLimits?: ClaudeLimits   absent when there is no valid reading
 *
 * `cleanClaudeLimits` is the single gate. The file reader ends with it, the
 * wire applies it leaving the source and again on arrival, and the renderer
 * applies it to whatever the payload carries. Anything it does not name is
 * dropped; a row with any malformed value is dropped; a reading with no valid
 * row is null, so the panel hides rather than painting a 0.
 */

export interface ClaudeLimitRow {
  /** "5 h" (session), "week" (weekly_all) or "week, <model>" (weekly_scoped). */
  label: string;
  /** Percent USED, 0 to 100. */
  usedPercent: number;
  /** Epoch ms when this window resets. Once in the past it has reset: never show the stale percent. */
  resetsAt: number;
}

export interface ClaudeLimits {
  /** ISO time Claude Code fetched the reading. Always shown, so its age is visible. */
  at: string;
  rows: ClaudeLimitRow[];
}

/** The most rows a reading may carry: a session, a weekly and a few scoped weeklies. */
export const MAX_CLAUDE_ROWS = 6;

/** A model name as Claude Code labels it ("Fable", "Opus 5.5"): letters, digits, space, dot, dash, underscore. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,23}$/;
const LABEL = /^(5 h|week|week, [A-Za-z0-9][A-Za-z0-9 ._-]{0,23})$/;

export const sessionLabel = '5 h';
export const weeklyLabel = 'week';
/** The row label for a scoped weekly limit, or null when the model name is not a safe short name. */
export function scopedLabel(model: unknown): string | null {
  return typeof model === 'string' && MODEL_NAME.test(model) ? `week, ${model}` : null;
}

const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);
/** A plausible epoch ms: after 2001 and before 2286. */
const epochMs = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 1e12 && v < 1e13 ? v : null);

/** One row, rebuilt from named fields, or null. */
export function cleanRow(r: unknown): ClaudeLimitRow | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const label = typeof o.label === 'string' && o.label.length <= 40 && LABEL.test(o.label) ? o.label : null;
  const usedPercent = pct(o.usedPercent);
  const resetsAt = epochMs(o.resetsAt);
  if (label === null || usedPercent === null || resetsAt === null) return null;
  return { label, usedPercent, resetsAt };
}

/** The validated reading, a fresh object, or null when nothing valid is left. */
export function cleanClaudeLimits(v: unknown): ClaudeLimits | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const at = typeof o.at === 'string' && o.at.length <= 40 && Number.isFinite(Date.parse(o.at)) ? new Date(Date.parse(o.at)).toISOString() : null;
  if (!at || !Array.isArray(o.rows)) return null;
  const rows: ClaudeLimitRow[] = [];
  const seen = new Set<string>();
  for (const r of o.rows.slice(0, MAX_CLAUDE_ROWS * 4)) {
    const row = cleanRow(r);
    if (!row || seen.has(row.label)) continue;
    seen.add(row.label);
    rows.push(row);
    if (rows.length >= MAX_CLAUDE_ROWS) break;
  }
  return rows.length ? { at, rows } : null;
}

/**
 * From the raw `cachedUsageUtilization` value to a reading, or null. Reads
 * ONLY `fetchedAtMs`, `utilization.limits[].{kind, percent, resets_at,
 * scope.model.display_name}` and, when `limits` is absent or empty,
 * `utilization.five_hour` / `seven_day` `.{utilization, resets_at}`. Every
 * other field, `accountUuid` included, is never looked at.
 */
export function claudeLimitsFromCache(cache: unknown): ClaudeLimits | null {
  if (!cache || typeof cache !== 'object') return null;
  const c = cache as Record<string, unknown>;
  const fetched = epochMs(c.fetchedAtMs);
  if (fetched === null) return null;
  const u = c.utilization && typeof c.utilization === 'object' ? (c.utilization as Record<string, unknown>) : null;
  if (!u) return null;
  const resets = (v: unknown): number | null => {
    if (typeof v !== 'string' || v.length > 40) return null;
    return epochMs(Date.parse(v));
  };
  const rows: unknown[] = [];
  if (Array.isArray(u.limits) && u.limits.length > 0) {
    for (const l of u.limits.slice(0, MAX_CLAUDE_ROWS * 4)) {
      if (!l || typeof l !== 'object') continue;
      const e = l as Record<string, unknown>;
      let label: string | null = null;
      if (e.kind === 'session') label = sessionLabel;
      else if (e.kind === 'weekly_all') label = weeklyLabel;
      else if (e.kind === 'weekly_scoped') {
        const scope = e.scope && typeof e.scope === 'object' ? (e.scope as Record<string, unknown>) : null;
        const model = scope?.model && typeof scope.model === 'object' ? (scope.model as Record<string, unknown>) : null;
        label = scopedLabel(model?.display_name);
      }
      if (label) rows.push({ label, usedPercent: e.percent, resetsAt: resets(e.resets_at) });
    }
  } else {
    const win = (w: unknown, label: string): void => {
      if (!w || typeof w !== 'object') return;
      const x = w as Record<string, unknown>;
      rows.push({ label, usedPercent: x.utilization, resetsAt: resets(x.resets_at) });
    };
    win(u.five_hour, sessionLabel);
    win(u.seven_day, weeklyLabel);
  }
  return cleanClaudeLimits({ at: new Date(fetched).toISOString(), rows });
}
