/**
 * Settings: a single JSON file in userData, loaded once and written
 * atomically. Deliberately small. Every key has a working default, so a deleted
 * or corrupt settings file costs nothing.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

import type { LayerMode } from './win32/desktop-layer';
import type { PerfTier } from './capability';

export type WallMode = 'stats';

export interface Settings {
  /** Retained for settings compatibility. Both editions always show stats. */
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
  /** Which monitors to render on. Empty means all. */
  monitors: number[];
  /** Show the diagnostics overlay. */
  debug: boolean;
  /**
   * The one line note across the top of the wall.
   *
   * It lives in settings rather than a file of its own because it is one short
   * string, settings is already written atomically, and it already reaches the
   * renderer on every state push. Capped so a paste cannot turn the settings
   * file into a document.
   */
  notes: string;
  /**
   * What the top row's big panel shows: the project constellation, or the live
   * throughput trace it replaced. Gustav wanted the constellation there without
   * losing the trace, so it is a toggle in the panel's header.
   */
  topPanel: 'constellation' | 'throughput';
  /**
   * The stats dashboard: the detailed grid (the wall as it has always been) or
   * the simple side-by-side cards (docs/design/codex-side-by-side.md). Gustav:
   * the wall opens on the detailed view.
   */
  statsView: 'detailed' | 'simple';
  /**
   * Whether Codex is shown beside Claude. Only matters on a wall that has Codex
   * data; one without behaves as if this were off and shows no toggle.
   */
  showCodex: boolean;
  /**
   * The model Ask Gemini uses (full build only, docs/ask-gemini.md): a slug as
   * `agy models` prints it, chosen in the tray. Validated by shape here; a slug
   * agy does not know fails that one question with a plain message, nothing
   * worse, because it is passed as one argument and can never be a flag.
   */
  askModel: string;
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
  monitors: [],
  debug: false,
  notes: '',
  topPanel: 'constellation',
  statsView: 'detailed',
  showCodex: true,
  askModel: 'gemini-3.8-flash-medium',
};

/** Matches MODEL_SLUG in src/main/ask/agy.ts: a Gemini slug that can never start with `-`. */
const ASK_MODEL = /^gemini-[a-z0-9][a-z0-9.-]{0,56}$/;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Matches NOTES_MAX in the renderer. Enforced here too: the renderer's cap is a
 * courtesy, this one is the guarantee, because settings.json is a supported
 * thing to hand edit. Counted in code POINTS, with Array.from, to agree with
 * the input's own `maxlength`, which counts graphemes rather than code units.
 */
const NOTES_MAX = 400;

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
    mode: DEFAULTS.mode,
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
    monitors: Array.isArray(r.monitors) ? r.monitors.filter((m) => Number.isInteger(m)) : [],
    debug: r.debug === true,
    notes:
      typeof r.notes === 'string' ? Array.from(r.notes).slice(0, NOTES_MAX).join('') : DEFAULTS.notes,
    topPanel: r.topPanel === 'throughput' ? 'throughput' : DEFAULTS.topPanel,
    statsView: r.statsView === 'simple' ? 'simple' : DEFAULTS.statsView,
    showCodex: r.showCodex !== false,
    askModel: typeof r.askModel === 'string' && ASK_MODEL.test(r.askModel) ? r.askModel : DEFAULTS.askModel,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const text = await fs.readFile(settingsPath(), 'utf8');
    // Strip a UTF-8 BOM. Notepad and PowerShell's Set-Content -Encoding utf8
    // both write one, JSON.parse rejects it, and the failure is invisible: the
    // file looks perfect and every setting silently reverts to its default.
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
