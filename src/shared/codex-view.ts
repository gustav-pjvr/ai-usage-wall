/**
 * The contract between the main process and the renderer for Codex, and for
 * the side-by-side views (docs/design/codex-side-by-side.md, approved by
 * Gustav 2026-10-26).
 *
 * The usage payload the renderer receives (`wall:usage`, `wall:getUsage`)
 * gains two optional fields:
 *
 *   codex?: CodexView      absent when this machine has no Codex data, when it
 *                          is a paired screen whose source sent none, or while
 *                          Codex's own first index is still running and has
 *                          nothing yet. Absent means: no Codex toggle at all,
 *                          and every view looks exactly as it does today.
 *   todaySlots?: number[]  Claude's tokens per five-minute slot of the LOCAL
 *                          day, length 288, for the simple view's "Today, side
 *                          by side" lane. Same meaning as CodexView.todaySlots.
 *
 * Settings gain (src/main/settings.ts, renderer WallState):
 *
 *   statsView: 'detailed' | 'simple'   default 'detailed' (Gustav: the wall opens on it)
 *   showCodex: boolean                 default true
 *
 * Shapes are structural so src/shared imports nothing from src/main.
 */

/** Same fields and meaning as Claude's TokenTotals, after normalisation (see CodexTotals docs). */
export interface CodexTotals {
  /** Fresh input: OpenAI `input_tokens - cached_input_tokens`. */
  input: number;
  /** `output_tokens`, which already includes reasoning. */
  output: number;
  /** `cache_write_input_tokens`. */
  cacheCreate: number;
  /** `cached_input_tokens`. */
  cacheRead: number;
  /** `reasoning_output_tokens` (a part of output, not added to it). */
  thinking: number;
  /** One per `token_usage_record` (one model response). */
  requests: number;
  webSearch: number;
  webFetch: number;
  /** USD at OpenAI API list prices. Derived, like Claude's. */
  costUsd: number;
  /** Tokens of a model with no published price. */
  unpricedTokens: number;
}

export type CodexProject = CodexTotals & { lastSeen: string; display: string };

/** One plan window from Codex's own `rate_limits` reading. */
export interface CodexLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  /** Epoch ms when this window resets. Once in the past, the window has reset: never show the stale percent. */
  resetsAt: number;
}

export interface CodexLimits {
  /** ISO time of the reading (when Codex last ran). Always shown, so its age is visible. */
  at: string;
  /** e.g. "plus". */
  plan: string | null;
  /** `primary`, the 5-hour window, or null if the reading had none. */
  fiveHour: CodexLimitWindow | null;
  /** `secondary`, the weekly window. */
  weekly: CodexLimitWindow | null;
}

export interface CodexView {
  totals: CodexTotals;
  /** UTC date `YYYY-MM-DD`, like Claude's `daily` (Gustav's standing choice). */
  daily: Record<string, CodexTotals>;
  /** UTC hour `YYYY-MM-DDTHH`, last 14 days, like Claude's `hourly`. */
  hourly: Record<string, CodexTotals>;
  models: Record<string, CodexTotals>;
  /** Lowercased cwd key to totals; `display` is the path. Labelled in the renderer like Claude's. */
  projects: Record<string, CodexProject>;
  /** LOCAL day to responses, like Claude's `activeDays`. */
  activeDays: Record<string, number>;
  /** Sessions in all, and who started them (`session_meta.originator`). */
  sessions: { total: number; byClaude: number; byYou: number; byT3: number; other: number };
  /** Hours, same method as Claude (src/shared/active-time.ts). */
  activeTime: { seconds: number; since: number | null };
  /** Tokens per five-minute slot of the LOCAL day, length 288. */
  todaySlots: number[];
  /** [epochMs, totalTokens, outputTokens] for the most recent responses, like Claude's `recent`. */
  recent: [number, number, number][];
  limits: CodexLimits | null;
  /** ISO time of the first and latest response on record. */
  firstAt: string | null;
  latestAt: string | null;
  /** True while Codex's index is being built for the first time: numbers are partial (rule 15). */
  indexing: boolean;
}

/** Whether a limit window is still current at `now`; a past `resetsAt` means it has reset. */
export function windowCurrent(w: CodexLimitWindow | null, now: number = Date.now()): boolean {
  return !!w && Number.isFinite(w.resetsAt) && w.resetsAt > now;
}
