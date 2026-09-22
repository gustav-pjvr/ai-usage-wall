/**
 * Milestones: fixed thresholds crossed, and records taken.
 *
 * Pure. The main process owns the ledger file and decides WHEN to evaluate;
 * this decides WHAT has been achieved. Tested without a window or a disk.
 *
 * THE RULES THAT KEEP IT HONEST
 *
 * - A milestone is announced once, ever. The ledger outlives the usage cache,
 *   which is designed to be thrown away on a version bump (peak.ts has the same
 *   reason for living apart).
 * - The first evaluation SEEDS silently. Everything already crossed is written
 *   down as seeded and nothing is announced, or a new install would light the
 *   badge with a year of history at once.
 * - Tokens are counted exactly as the headline counts them, so "50B processed"
 *   agrees with the big number to the token.
 * - No duration record. A resumed session keeps its id, so start to end reads
 *   1107 hours on this machine, which is not how long anyone worked.
 * - No money. These surface on the desktop, and cost milestones would put a
 *   dollar figure where rule 24 says one does not belong.
 * - A session record announces when a DIFFERENT session takes it. The session
 *   holding the record grows on every refresh while it runs, and announcing
 *   each step would turn the badge into a counter. Its value still updates,
 *   quietly.
 */

import { dayRuns } from './day';

export interface MilestoneInput {
  processed: number;
  generated: number;
  requests: number;
  /** Model ids seen. `<synthetic>` and `unknown` are not models and are ignored. */
  models: string[];
  /** Local calendar days with at least one request. */
  activeDays: string[];
  /** Every session, by id. Local only: milestones never cross the wire. */
  sessions: { id: string; requests: number; output: number }[];
}

export interface Achieved {
  key: string;
  title: string;
  sub: string;
  /** ISO time it was recorded. */
  at: string;
  /** Crossed before the ledger existed: recorded, never announced. */
  seeded: boolean;
  /** Records only: the current value and who holds it. */
  value?: number;
  holder?: string;
}

export interface Ledger {
  v: 1;
  seededAt: string;
  /**
   * The reconstructed history seed this ledger has already absorbed, by its
   * creation time. A seed can put the totals past rungs the live index never
   * reached; those are recorded silently as "earlier", exactly like the first
   * run, and never announced. See docs/design/history-archive.md section 5.
   */
  seededHistoryAt?: string;
  achieved: Record<string, Achieved>;
  /** Keys announced but not yet seen. The badge is its length. */
  unseen: string[];
}

export interface NextUp {
  title: string;
  /** How far along, 0 to 1. */
  progress: number;
  remaining: string;
}

const B = 1e9, M = 1e6, K = 1e3;
export const LADDERS = {
  processed: [1 * B, 5 * B, 10 * B, 25 * B, 50 * B, 100 * B, 250 * B, 500 * B, 1000 * B],
  generated: [10 * M, 25 * M, 50 * M, 100 * M, 250 * M, 500 * M, 1 * B],
  requests: [10 * K, 25 * K, 50 * K, 100 * K, 250 * K, 500 * K, 1000 * K],
  streak: [7, 14, 30, 60, 100, 365],
} as const;

const NOT_MODELS = new Set(['<synthetic>', 'unknown', '']);

/** Round figures only, which is all a ladder ever holds: 1T, 50B, 250M, 10K. */
export function short(n: number): string {
  if (n >= 1e12) return `${n / 1e12}T`;
  if (n >= 1e9) return `${n / 1e9}B`;
  if (n >= 1e6) return `${n / 1e6}M`;
  if (n >= 1e3) return `${n / 1e3}K`;
  return String(n);
}

/** Loose form for "how far to go", which is not a round figure. */
function approx(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.ceil(n));
}

/** Longest run of consecutive local days, ever. One rule, in day.ts. */
export function longestStreak(days: string[]): number {
  return dayRuns(days).longest;
}

/** Everything the input has achieved, ignoring the ledger. */
function crossed(input: MilestoneInput): Omit<Achieved, 'at' | 'seeded'>[] {
  const out: Omit<Achieved, 'at' | 'seeded'>[] = [];
  for (const t of LADDERS.processed) if (input.processed >= t)
    out.push({ key: `processed:${short(t)}`, title: `${short(t)} tokens processed`, sub: 'as the headline counts them, mostly cache reads' });
  for (const t of LADDERS.generated) if (input.generated >= t)
    out.push({ key: `generated:${short(t)}`, title: `${short(t)} tokens generated`, sub: 'output Claude actually wrote' });
  for (const t of LADDERS.requests) if (input.requests >= t)
    out.push({ key: `requests:${short(t)}`, title: `${short(t)} requests`, sub: 'assistant replies, all projects' });
  const streak = longestStreak(input.activeDays);
  for (const t of LADDERS.streak) if (streak >= t)
    out.push({ key: `streak:${t}`, title: `${t} day streak`, sub: 'consecutive local days with at least one request' });
  for (const m of input.models) if (!NOT_MODELS.has(m))
    out.push({ key: `model:${m}`, title: `First use of ${m}`, sub: 'a model this machine had not used before' });
  return out;
}

function recordHolder(input: MilestoneInput, field: 'requests' | 'output') {
  let best: { id: string; value: number } | null = null;
  for (const s of input.sessions) {
    const v = Number(s[field]) || 0;
    if (v > 0 && (!best || v > best.value || (v === best.value && s.id < best.id))) best = { id: s.id, value: v };
  }
  return best;
}

const RECORDS = [
  { key: 'record:sessionRequests', field: 'requests' as const, title: (v: number) => `Biggest session: ${v.toLocaleString('en-US')} requests`, sub: 'most requests in one session' },
  { key: 'record:sessionOutput', field: 'output' as const, title: (v: number) => `Biggest session: ${approx(v)} generated`, sub: 'most output in one session' },
];

/**
 * Evaluate. Returns the ledger to store, what is newly announced, and whether
 * anything changed (so the caller only writes the file when it must).
 *
 * Call it ONLY on a complete index: never while indexing, never when the
 * source is unavailable. That gate lives in the caller because only the caller
 * knows; this function would happily announce from a half-built index.
 */
export function evaluate(
  input: MilestoneInput,
  ledger: Ledger | null,
  now: number = Date.now(),
  silent = false,
): { ledger: Ledger; fresh: Achieved[]; changed: boolean } {
  const at = new Date(now).toISOString();
  // `silent`: a pass that must record without announcing (a history seed arriving).
  const seeding = ledger === null || silent;
  const next: Ledger = ledger
    ? { ...ledger, achieved: { ...ledger.achieved }, unseen: [...ledger.unseen] }
    : { v: 1, seededAt: at, achieved: {}, unseen: [] };
  const fresh: Achieved[] = [];
  let changed = ledger === null;

  for (const c of crossed(input)) {
    if (next.achieved[c.key]) continue;
    const a: Achieved = { ...c, at, seeded: seeding };
    next.achieved[c.key] = a;
    changed = true;
    if (!seeding) {
      fresh.push(a);
      next.unseen.push(c.key);
    }
  }

  for (const r of RECORDS) {
    const holder = recordHolder(input, r.field);
    if (!holder) continue;
    const prev = next.achieved[r.key];
    if (prev && holder.value <= (prev.value ?? 0)) continue;
    const a: Achieved = { key: r.key, title: r.title(holder.value), sub: r.sub, at, seeded: seeding, value: holder.value, holder: holder.id };
    const takenOver = !seeding && (!prev || prev.holder !== holder.id);
    // Same holder, bigger number: update quietly, keep the original date.
    next.achieved[r.key] = prev && !takenOver ? { ...a, at: prev.at, seeded: prev.seeded } : a;
    changed = true;
    if (takenOver) {
      fresh.push(a);
      if (!next.unseen.includes(r.key)) next.unseen.push(r.key);
    }
  }

  return { ledger: next, fresh, changed };
}

/** The next rung on each ladder, for the list's "next up" section. */
export function nextUps(input: MilestoneInput): NextUp[] {
  const out: NextUp[] = [];
  const step = (have: number, ladder: readonly number[], title: (t: number) => string, unit = '') => {
    const target = ladder.find((t) => have < t);
    if (target === undefined) return;
    const below = [...ladder].reverse().find((t) => t <= have) ?? 0;
    out.push({
      title: title(target),
      progress: Math.max(0, Math.min(1, (have - below) / (target - below))),
      remaining: `${approx(target - have)}${unit} to go`,
    });
  };
  step(input.processed, LADDERS.processed, (t) => `${short(t)} tokens processed`);
  step(input.generated, LADDERS.generated, (t) => `${short(t)} tokens generated`);
  step(input.requests, LADDERS.requests, (t) => `${short(t)} requests`);
  step(longestStreak(input.activeDays), LADDERS.streak, (t) => `${t} day streak`, ' days');
  return out;
}

/** Newest first, for the list. */
export function listAchieved(ledger: Ledger | null): Achieved[] {
  if (!ledger) return [];
  return Object.values(ledger.achieved).sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}
