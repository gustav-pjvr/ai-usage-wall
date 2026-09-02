/**
 * Hardware capability tiering.
 *
 * The wall runs 24/7, so the cost of a visual effect is paid continuously. This
 * picks a performance tier once at startup and the renderer scales its motion
 * budget to it. The rule is: prioritise smoothness and low idle cost over
 * effects. A dropped frame on an ambient wall reads as "broken", not "busy".
 *
 * Detection is measured, not guessed: real GPU feature status from Chromium,
 * real core count, real memory, real battery state.
 */

import * as os from 'node:os';
import { app, powerMonitor } from 'electron';

export type PerfTier = 'low' | 'balanced' | 'high';

export interface Capability {
  tier: PerfTier;
  cores: number;
  memoryGb: number;
  gpuAccelerated: boolean;
  onBattery: boolean;
  reasons: string[];
}

/**
 * Chromium reports per-feature GPU status. We care specifically about whether
 * canvas and compositing are hardware-backed; if Chromium fell back to software
 * rendering, blur and mesh gradients become CPU-bound and must be dropped.
 */
function gpuAccelerated(): { ok: boolean; detail: string } {
  try {
    const status = app.getGPUFeatureStatus() as unknown as Record<string, string>;
    const key = status.gpu_compositing ?? status.compositing ?? '';
    const ok = typeof key === 'string' && key.startsWith('enabled');
    return { ok, detail: key || 'unknown' };
  } catch (err) {
    return { ok: false, detail: `unavailable: ${(err as Error).message}` };
  }
}

export function detectCapability(overrideTier?: PerfTier | 'auto'): Capability {
  const cores = os.cpus()?.length ?? 2;
  const memoryGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const gpu = gpuAccelerated();

  // On battery, Windows laptops throttle aggressively and the user cares about
  // runtime more than parallax. Treat it as a real signal, not a nicety.
  // powerMonitor is the correct API here; app.isOnBatteryPower does not exist.
  let onBattery = false;
  try {
    onBattery = powerMonitor.isOnBatteryPower();
  } catch {
    onBattery = false;
  }

  const reasons: string[] = [];
  let tier: PerfTier;

  if (!gpu.ok) {
    tier = 'low';
    reasons.push(`GPU compositing ${gpu.detail}, software rendering`);
  } else if (cores <= 4 || memoryGb < 8) {
    tier = 'low';
    reasons.push(`${cores} cores, ${memoryGb} GB RAM`);
  } else if (cores >= 12 && memoryGb >= 24) {
    tier = 'high';
    reasons.push(`${cores} cores, ${memoryGb} GB RAM, GPU ${gpu.detail}`);
  } else {
    tier = 'balanced';
    reasons.push(`${cores} cores, ${memoryGb} GB RAM, GPU ${gpu.detail}`);
  }

  if (onBattery && tier === 'high') {
    tier = 'balanced';
    reasons.push('on battery, stepped down from high');
  }

  if (overrideTier && overrideTier !== 'auto') {
    reasons.push(`overridden to '${overrideTier}' by settings`);
    tier = overrideTier;
  }

  return { tier, cores, memoryGb, gpuAccelerated: gpu.ok, onBattery, reasons };
}
