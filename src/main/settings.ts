/**
 * Settings: a single JSON file next to the client data, loaded once and written
 * atomically. Deliberately small. Every key has a working default, so a deleted
 * or corrupt settings file costs nothing.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

import type { LayerMode } from './win32/desktop-layer';
import type { PerfTier } from './capability';

export type WallMode = 'stats' | 'clients';

export interface Settings {
  /** Which view the wall shows. Claude Stats is the default experience. */
  mode: WallMode;
  /** Desktop layering. 'desktop' is the interactive-but-behind-apps hybrid. */
  layerMode: LayerMode;
  /** 'auto' inspects the machine. */
  performance: PerfTier | 'auto';
  /** Cards ignore the mouse entirely. Useful with layerMode 'desktop'. */
  clickThrough: boolean;
  /** Global hotkey to toggle focus mode. Electron accelerator syntax. */
  hotkeyFocus: string;
  /** Global hotkey to show/hide the wall. */
  hotkeyToggle: string;
  /** Launch on Windows sign-in. */
  startWithWindows: boolean;
  /** Wall opacity in ambient mode, 0.2 to 1. */
  opacity: number;
  /**
   * Backdrop painted behind the cards.
   *
   * 'none' leaves the window transparent, so the desktop wallpaper and any icons
   * underneath show through the gaps. 'plain' and 'gradient' cover them.
   */
  background: 'none' | 'plain' | 'gradient';
  /** Backdrop opacity, 0 to 1. Below 1 the wallpaper shows through faintly. */
  backgroundOpacity: number;
  /** Layout density multiplier. Lower packs more cards in. */
  densityScale: number;
  /** Seconds between ambient page changes when the wall paginates. */
  pageRotateSeconds: number;
  /** Which monitors to render on. Empty means all. */
  monitors: number[];
  clientsDir: string | null;
  assetsDir: string | null;
  vaultPath: string | null;
  useVault: boolean;
  /** Show the diagnostics overlay. */
  debug: boolean;
}

const DEFAULTS: Settings = {
  mode: 'stats',
  layerMode: 'desktop',
  performance: 'auto',
  clickThrough: false,
  hotkeyFocus: 'Control+Alt+W',
  hotkeyToggle: 'Control+Alt+Shift+W',
  startWithWindows: false,
  opacity: 1,
  background: 'gradient',
  backgroundOpacity: 1,
  densityScale: 1,
  pageRotateSeconds: 45,
  monitors: [],
  clientsDir: null,
  assetsDir: null,
  vaultPath: null,
  useVault: true,
  debug: false,
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Coerce anything into a valid Settings object. Never throws. */
export function normaliseSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  // 'wallpaper' was a third mode until 2026-09-02. Anything not in this list,
  // including that value, falls back to the default, which is what makes the
  // migration free: an old settings.json simply loads as 'desktop'.
  const layerModes: LayerMode[] = ['desktop', 'top'];
  const tiers = ['auto', 'low', 'balanced', 'high'];

  return {
    mode: r.mode === 'clients' ? 'clients' : DEFAULTS.mode,
    layerMode: layerModes.includes(r.layerMode as LayerMode) ? (r.layerMode as LayerMode) : DEFAULTS.layerMode,
    performance: tiers.includes(r.performance as string) ? (r.performance as Settings['performance']) : 'auto',
    clickThrough: r.clickThrough === true,
    hotkeyFocus: typeof r.hotkeyFocus === 'string' && r.hotkeyFocus ? r.hotkeyFocus : DEFAULTS.hotkeyFocus,
    hotkeyToggle: typeof r.hotkeyToggle === 'string' && r.hotkeyToggle ? r.hotkeyToggle : DEFAULTS.hotkeyToggle,
    startWithWindows: r.startWithWindows === true,
    opacity: typeof r.opacity === 'number' ? clamp(r.opacity, 0.2, 1) : DEFAULTS.opacity,
    background: (['none', 'plain', 'gradient'] as const).includes(r.background as never)
      ? (r.background as Settings['background'])
      : DEFAULTS.background,
    backgroundOpacity:
      typeof r.backgroundOpacity === 'number' ? clamp(r.backgroundOpacity, 0, 1) : DEFAULTS.backgroundOpacity,
    densityScale: typeof r.densityScale === 'number' ? clamp(r.densityScale, 0.6, 2) : DEFAULTS.densityScale,
    pageRotateSeconds:
      typeof r.pageRotateSeconds === 'number' ? clamp(r.pageRotateSeconds, 10, 600) : DEFAULTS.pageRotateSeconds,
    monitors: Array.isArray(r.monitors) ? r.monitors.filter((m) => Number.isInteger(m)) : [],
    clientsDir: typeof r.clientsDir === 'string' ? r.clientsDir : null,
    assetsDir: typeof r.assetsDir === 'string' ? r.assetsDir : null,
    vaultPath: typeof r.vaultPath === 'string' ? r.vaultPath : null,
    useVault: r.useVault !== false,
    debug: r.debug === true,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const text = await fs.readFile(settingsPath(), 'utf8');
    // Strip a UTF-8 BOM. Notepad and PowerShell's Set-Content -Encoding utf8
    // both write one, JSON.parse rejects it, and the failure is invisible: the
    // file looks perfect and every setting silently reverts to its default.
    // The client store does the same for exactly the same reason.
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Partial<Settings>;
    const settings = normaliseSettings(raw);

    // The one removed value gets an explicit notice rather than the silent
    // default, because a machine left on it was a machine with an invisible
    // wall. Rewrite the file so it stops claiming a mode that no longer exists.
    if ((raw as { layerMode?: string }).layerMode === 'wallpaper') {
      console.warn(`[settings] layerMode 'wallpaper' is no longer supported, using '${settings.layerMode}'`);
      await saveSettings(settings).catch((err) =>
        console.error('[settings] could not rewrite migrated settings:', (err as Error).message),
      );
    }
    return settings;
  } catch (err) {
    // A missing file is normal on first run. A file that EXISTS but will not
    // parse is not: every setting silently reverts to its default and the user
    // has no idea why their configuration stopped applying. Say so.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(
        `[settings] ${settingsPath()} could not be read, using defaults: ${(err as Error).message}`,
      );
    }
    return { ...DEFAULTS };
  }
}

/** Atomic write: temp file then rename, so a crash cannot truncate settings. */
export async function saveSettings(settings: Settings): Promise<void> {
  const target = settingsPath();
  const tmp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(normaliseSettings(settings), null, 2), 'utf8');
  await fs.rename(tmp, target);
}

export { DEFAULTS as DEFAULT_SETTINGS };
