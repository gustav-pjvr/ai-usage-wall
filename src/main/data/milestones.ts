/**
 * The milestone ledger: what has been achieved, and what has been seen.
 *
 * Its own file, for the reason peak.ts gives: the usage index is a cache that a
 * version bump throws away, and "already announced" must outlive that, or the
 * next bump would announce everything again.
 *
 * The rules themselves are pure and live in src/shared/milestones.ts. This file
 * only loads, gates, saves and hands the renderer what it may see.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { evaluate, listAchieved, nextUps, type Ledger, type MilestoneInput } from '../../shared/milestones';
import type { UsageIndex } from './usage';

let ledger: Ledger | null = null;
let loaded = false;
let file: string | null = null;
/** Saves run one at a time. Two writers sharing one tmp path could interleave. */
let saving: Promise<void> = Promise.resolve();

export async function loadMilestones(userData: string): Promise<void> {
  file = path.join(userData, 'milestones.json');
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Ledger>;
    const valid =
      raw?.v === 1 &&
      typeof raw.seededAt === 'string' &&
      raw.achieved !== null && typeof raw.achieved === 'object' &&
      Array.isArray(raw.unseen);
    ledger = valid ? (raw as Ledger) : null;
    if (!valid) console.warn('[milestones] ledger unreadable, it will be reseeded silently');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') {
      /*
       * The file exists and could not be READ: on Windows an antivirus or a
       * backup scanner holding it for a moment is enough. Treating that as
       * "no ledger" would reseed on the next scan and overwrite the real file,
       * turning every honest date into "earlier" and emptying the badge, from a
       * read that would have worked a second later. So stay unloaded, which
       * skips evaluating and saving, and try again on the next scan.
       */
      console.warn(`[milestones] could not read the ledger (${code}), will retry:`, (err as Error).message);
      return;
    }
    // Missing is normal on first run. A parse failure lands above as invalid.
    ledger = null;
  }
  loaded = true;
}

/** The index, reduced to what the rules read. */
export function milestoneInput(u: UsageIndex): MilestoneInput {
  const t = u.totals;
  return {
    processed: t.input + t.output + t.cacheCreate + t.cacheRead,
    generated: t.output,
    requests: t.requests,
    models: Object.keys(u.models ?? {}),
    activeDays: Object.keys(u.activeDays ?? {}).filter((d) => (u.activeDays[d] ?? 0) > 0),
    sessions: Object.values(u.sessions ?? {}).map((s) => ({ id: s.id, requests: s.requests, output: s.output })),
  };
}

function save(): Promise<void> {
  // Chained, so a scan announcing a milestone and a click marking the list seen
  // can never write the same tmp file at once and leave the older one on disk.
  saving = saving.then(async () => {
    if (!file || !ledger) return;
    const tmp = `${file}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      // Losing a write costs a re-announcement at worst. It must never take the
      // scan down with it.
      console.warn('[milestones] could not save:', (err as Error).message);
    }
  });
  return saving;
}

/**
 * Evaluate after a scan. `ready` must be false while indexing or when the
 * source is unreadable: a half-built index would announce thresholds it has
 * not really crossed, and the ledger can never take one back.
 *
 * Returns how many were newly achieved.
 */
export async function evaluateMilestones(u: UsageIndex, ready: boolean, now = Date.now()): Promise<number> {
  // A ledger that could not be read at launch is retried here rather than
  // assumed missing. See loadMilestones.
  if (!loaded && file) await loadMilestones(path.dirname(file));
  if (!loaded || !ready) return 0;
  const r = evaluate(milestoneInput(u), ledger, now);
  ledger = r.ledger;
  if (r.changed) await save();
  for (const a of r.fresh) console.log(`[milestones] ${a.title}`);
  return r.fresh.length;
}

/** Opening the list clears the badge. */
export async function markMilestonesSeen(): Promise<boolean> {
  if (!ledger || ledger.unseen.length === 0) return false;
  ledger = { ...ledger, unseen: [] };
  await save();
  return true;
}

/**
 * What the renderer gets. `holder` is a session id, which the renderer has no
 * use for, so it stays in the main process with the rest of the ledger.
 */
export function milestonesForRenderer(u: UsageIndex, indexing: boolean) {
  if (!ledger) return null;
  /*
   * "Next up" is measured against the index, so it must not be computed from
   * one that is still being built. After a version bump the index starts empty
   * while the ledger already holds "25B processed", and the list would have
   * said "1B tokens processed, 1.0B to go" under it for the whole reindex.
   */
  const partial = indexing || u.unavailable || u.totals.requests === 0;
  return {
    achieved: listAchieved(ledger).map(({ holder: _holder, ...rest }) => rest),
    unseen: [...ledger.unseen],
    next: partial ? [] : nextUps(milestoneInput(u)),
    reading: partial,
  };
}
