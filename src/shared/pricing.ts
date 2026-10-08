/**
 * What the tokens would have cost at API list prices.
 *
 * WHY THIS IS COMPUTED AND NOT READ
 *
 * Cost is not in the transcripts. Every record type in a session file was
 * scanned for any key containing "cost" and there is none: Claude Code's own
 * `/cost` computes it in process from the token counts, which ARE recorded.
 * This does the same arithmetic on the same inputs, so it is DERIVED in the
 * sense the dashboard means, and the card says so.
 *
 * WHAT THE NUMBER IS NOT
 *
 * It is not a bill. On a subscription nothing here was charged per token; this
 * is what the same work would have cost through the API at list prices. It also
 * only covers sessions on this machine.
 *
 * PRICES GO STALE
 *
 * Captured 2026-09-04 from the bundled `claude-api` skill (its table is dated
 * 2026-06-24) plus the cache multipliers from that skill's prompt-caching
 * reference. The 5.5 models were added 2026-10-08 from the live pricing page
 * (platform.claude.com/docs/en/about-claude/pricing). A model this table does not know contributes nothing and is
 * counted separately, so an unpriced model shows up as a caveat rather than
 * quietly making the total too low.
 *
 * VALIDATED AGAINST CLAUDE CODE
 *
 * Checked against a real `/usage` breakdown on 2026-09-04. Claude Sonnet 5
 * matched to the cent ($1.123 against $1.12), Haiku matched once one web search
 * at a cent was included, and the two larger models landed within rounding of
 * the displayed token counts. That is the only reason to trust the multipliers
 * below rather than the tidier assumption that a cache write is a cache write.
 */

/** Dollars per million tokens, before any cache multiplier. */
export interface ModelPrice {
  input: number;
  output: number;
  /**
   * Cache reads, as a fraction of the input price. 0.1 nearly everywhere, but
   * Claude Fable 5.1 reads at $0.25 per million against a $10 input price,
   * which is 0.025 rather than 0.1.
   */
  cacheReadFactor: number;
  /**
   * Claude Haiku 5.5 is priced by prompt length: a request whose prompt (input,
   * cache reads and cache writes together) is over this many tokens pays every
   * token price times `factor`. No other model has this; they price the whole
   * 1M context at one rate.
   */
  longPrompt?: { over: number; factor: number };
}

const OPUS: ModelPrice = { input: 5, output: 25, cacheReadFactor: 0.1 };
/** Cheaper than Opus 5, and cache reads at 0.05x ($0.20), not 0.1x. */
const OPUS_55: ModelPrice = { input: 4, output: 20, cacheReadFactor: 0.05 };
const FABLE: ModelPrice = { input: 10, output: 50, cacheReadFactor: 0.1 };
const FABLE_51: ModelPrice = { input: 10, output: 50, cacheReadFactor: 0.025 };
/** Sonnet 5's price, but cache reads at 0.05x ($0.10). */
const SONNET_55: ModelPrice = { input: 2, output: 10, cacheReadFactor: 0.05 };
const SONNET_5: ModelPrice = { input: 2, output: 10, cacheReadFactor: 0.1 };
const SONNET_46: ModelPrice = { input: 3, output: 15, cacheReadFactor: 0.1 };
const HAIKU: ModelPrice = { input: 1, output: 5, cacheReadFactor: 0.1 };
/** $0.10 / $0.50 up to 100,000 prompt tokens; $0.50 / $2.50 over that. */
const HAIKU_55: ModelPrice = { input: 0.1, output: 0.5, cacheReadFactor: 0.1, longPrompt: { over: 100_000, factor: 5 } };

/*
 * The 5.5 ids MUST be listed. `claude-opus-5-5` starts with `claude-opus-5`,
 * so without its own entry it silently took Opus 5's price (25% too high, and
 * cache reads at double), and the same for Sonnet 5.5. Found 2026-10-08 when
 * Haiku 5.5, which matched nothing, showed up as unpriced.
 */

/** Exact ids first. Anything else falls through to the prefix rules below. */
const EXACT: Record<string, ModelPrice> = {
  'claude-fable-5-1': FABLE_51,
  'claude-mythos-5-1': FABLE_51,
  'claude-fable-5': FABLE,
  'claude-mythos-5': FABLE,
  'claude-opus-5-5': OPUS_55,
  'claude-opus-5': OPUS,
  'claude-opus-4-8': OPUS,
  'claude-opus-4-7': OPUS,
  'claude-opus-4-6': OPUS,
  'claude-opus-4-5': OPUS,
  'claude-sonnet-5-5': SONNET_55,
  'claude-sonnet-5': SONNET_5,
  'claude-sonnet-4-6': SONNET_46,
  'claude-sonnet-4-5': SONNET_46,
  'claude-haiku-5-5': HAIKU_55,
  'claude-haiku-4-5': HAIKU,
};

/**
 * Prefix rules, because recorded ids sometimes carry a date suffix. The index
 * has `claude-haiku-4-5-20251001` in it, which is the same model as
 * `claude-haiku-4-5` and must not be treated as unknown.
 */
const PREFIXES: [string, ModelPrice][] = [
  ['claude-fable-5-1', FABLE_51],
  ['claude-mythos-5-1', FABLE_51],
  ['claude-fable-5', FABLE],
  ['claude-mythos-5', FABLE],
  ['claude-opus-5-5', OPUS_55],
  ['claude-opus-5', OPUS],
  ['claude-opus-4-8', OPUS],
  ['claude-opus-4-7', OPUS],
  ['claude-opus-4-6', OPUS],
  ['claude-opus-4-5', OPUS],
  ['claude-sonnet-5-5', SONNET_55],
  ['claude-sonnet-5', SONNET_5],
  ['claude-sonnet-4-6', SONNET_46],
  ['claude-sonnet-4-5', SONNET_46],
  ['claude-haiku-5-5', HAIKU_55],
  ['claude-haiku-4-5', HAIKU],
];

/** Cache writes cost more than plain input, and the two TTLs differ. */
const WRITE_5M = 1.25;
const WRITE_1H = 2;

/** A server-side web search, per request. */
const WEB_SEARCH = 0.01;

export function priceFor(model: string): ModelPrice | null {
  if (!model) return null;
  const exact = EXACT[model];
  if (exact) return exact;
  // Longest prefix first, so `claude-fable-5-1` never matches `claude-fable-5`.
  for (const [p, price] of [...PREFIXES].sort((a, b) => b[0].length - a[0].length)) {
    if (model.startsWith(p)) return price;
  }
  return null;
}

/** The token counts one assistant record contributes. */
export interface CostInput {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes at the 5 minute TTL. */
  cacheWrite5m: number;
  /** Cache writes at the 1 hour TTL, which cost twice base rather than 1.25x. */
  cacheWrite1h: number;
  webSearch: number;
}

/**
 * Dollars for one record, or null when the model is not in the table.
 *
 * Null rather than zero on purpose: a caller that treats an unknown model as
 * free produces a total that is quietly too low, and nothing on screen says so.
 */
export function costOf(model: string, u: CostInput): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const per = 1e-6 * (p.longPrompt && prompt > p.longPrompt.over ? p.longPrompt.factor : 1);
  return (
    u.input * p.input * per +
    u.output * p.output * per +
    u.cacheRead * p.input * p.cacheReadFactor * per +
    u.cacheWrite5m * p.input * WRITE_5M * per +
    u.cacheWrite1h * p.input * WRITE_1H * per +
    u.webSearch * WEB_SEARCH
  );
}

/**
 * Human form: dollars and cents, never rounded up.
 *
 * Floored rather than rounded, and toFixed(2) would not do it: toFixed rounds
 * half away from zero, so $22,523.469 would print as $22,523.47 and claim a
 * cent that was not spent. A cost estimate that errs should err low, because
 * the number people check it against is a bill.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  const floored = Math.floor(usd * 100) / 100;
  return `$${floored.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
