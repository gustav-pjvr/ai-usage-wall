/**
 * The all time peak token rate, as a high water mark.
 *
 * WHY IT IS ITS OWN FILE
 *
 * The obvious home is the usage index, and it would be wrong. loadIndex()
 * discards the whole cache when INDEX_VERSION changes (src/main/data/usage.ts,
 * the version check in loadIndex), which is correct for a derived cache that
 * can be rebuilt from the transcripts. A record cannot be rebuilt: the peak is
 * the highest rate ever OBSERVED, and once the moment has passed the only proof
 * it happened is the number itself. Storing it beside a cache that is designed
 * to be thrown away would quietly reset it on the next schema change.
 *
 * WHAT IT IS AND IS NOT
 *
 * It is a high water mark, exactly as asked for: it holds a number, replaces it
 * when the live rate goes above, and otherwise stays put. It is therefore the
 * peak since this file first existed, NOT the peak across all history that the
 * transcripts might contain. That distinction is real and the UI must not
 * pretend otherwise, because on a machine that has been running for months the
 * two would be very different numbers.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { PeakVelocity } from '../../shared/velocity';

/** Ignore anything below this, so noise never sets a record. */
const FLOOR = 1000;

/**
 * Which definition of velocity the stored record was measured with.
 *
 * Version 1 divided the window's tokens by the time since the oldest record in
 * it; version 2 divides by the window. The ratio between them is 10/spanMin
 * with spanMin floored at 1, so version 1 read between 1x and 10x version 2
 * depending only on how tightly the work was bunched. Measured across the live
 * buffer: mean 2.16x, worst exactly 10.00x.
 *
 * A stored record is therefore discarded rather than converted, because there
 * is no conversion. Recovering the old spanMin would need the moment that
 * produced it, and that is gone.
 *
 * NOT because the old figure is out of reach. That was the first reason written
 * here and it was wrong: Gustav asked where the "10x" came from, and checking it
 * showed the new formula reaching 26.4M/min in the same buffer against a stored
 * record of 9.6M. The old number would have been beaten within the hour. The
 * reason to drop it is that a high water mark mixing two definitions measures
 * nothing, which is true regardless of which number is larger.
 */
const PEAK_VERSION = 2;

let cached: PeakVelocity | null = null;
let file: string | null = null;

const fileFor = (userData: string) => path.join(userData, 'peak-velocity.json');

/** Load once at startup. A missing or unreadable file simply means no record. */
export async function loadPeak(userData: string): Promise<PeakVelocity | null> {
  file = fileFor(userData);
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<PeakVelocity> & { v?: number };
    if (Number(raw?.v) !== PEAK_VERSION) {
      console.log('[peak] discarding a record measured with an older velocity definition');
      return (cached = null);
    }
    const v = Number(raw?.velocity);
    // A record that is not a finite positive number is not a record.
    if (!Number.isFinite(v) || v < FLOOR) return (cached = null);
    const at = typeof raw?.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? raw.at : new Date().toISOString();
    return (cached = { velocity: v, at });
  } catch {
    return (cached = null);
  }
}

/** The record as it stands, without touching the disk. */
export const currentPeak = (): PeakVelocity | null => cached;

/**
 * Offer a reading. Returns true only when it beat the record, so the caller can
 * decide whether anything needs pushing to a renderer.
 *
 * Writes only on a new record. A machine sitting at a steady rate below its
 * best writes nothing at all, which is the common case by a wide margin.
 */
export async function offerPeak(velocity: number, when: number = Date.now()): Promise<boolean> {
  if (!Number.isFinite(velocity) || velocity < FLOOR) return false;
  if (cached && velocity <= cached.velocity) return false;
  cached = { velocity, at: new Date(when).toISOString() };
  if (!file) return true;
  try {
    await fs.writeFile(file, JSON.stringify({ v: PEAK_VERSION, ...cached }, null, 2), 'utf8');
  } catch (err) {
    // Losing the write costs the record on next launch, nothing more. It must
    // never take the scan down with it.
    console.warn('[peak] could not save:', (err as Error).message);
  }
  return true;
}
