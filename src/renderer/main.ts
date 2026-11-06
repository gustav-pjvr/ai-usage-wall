/** Renderer entry for the wall: Claude Stats, Work (full build only) and the shell controls. */

import type { UsageIndex } from '../main/data/usage';
import { StatsView } from './stats';
import { NotesBar } from './notes';
import { WallActions } from './actions';
import { AskPanel, type AskBridge } from './ask';
import { isStatsOnly } from '../shared/edition';
import type { DayRaw, TimelapseDays } from '../shared/intraday';
// Type only, erased at build: the module is required below inside `if (!isStatsOnly)`.
import type { WorkBridge, WorkView } from './work';
import type { MailBridge } from './inbox';

// ── Types mirrored from main ───────────────────────────────────────────────

interface WallState {
  settings: {
    debug: boolean;
    layerMode: string;
    clickThrough: boolean;
    opacity: number;
    background: 'none' | 'plain' | 'gradient';
    backgroundOpacity: number;
    notes: string;
    topPanel: 'constellation' | 'throughput';
    /** Claude and Codex side by side (src/shared/codex-view.ts). Optional: an older main omits them. */
    statsView?: 'detailed' | 'simple';
    showCodex?: boolean;
    /** Work mode's Mine | Everyone (full build). */
    workFilter?: 'mine' | 'everyone';
  };
  /** The view to show. Main already resolved it: never 'work' in the stats build or on a paired screen. */
  mode?: 'stats' | 'work';
  /** Whether this wall offers Work at all. */
  work?: boolean;
  capability: { tier: 'low' | 'balanced' | 'high'; cores: number; memoryGb: number; gpuAccelerated: boolean; reasons: string[] };
  focusMode: boolean;
  appVersion: string;
  display: { id: number; width: number; height: number; scaleFactor: number; isPrimary: boolean; index: number; total: number } | null;
  win32: { available: boolean; reason: string | null };
}

declare global {
  interface Window {
    wall: {
      getState(): Promise<WallState | null>;
      updateSettings(patch: unknown): Promise<void>;
      toggleFocus(): Promise<void>;
      openExternal(url: string): Promise<void>;
      onState(cb: (state: WallState) => void): () => void;
      exitFocus(): Promise<void>;
      getUsage(): Promise<UsageIndex | null>;
      onUsage(cb: (usage: UsageIndex) => void): () => void;
      onUsageProgress(cb: (p: { done: number; total: number; bytesDone: number; bytesTotal: number }) => void): () => void;
      onUpdate(cb: (s: { phase: string; version?: string; percent?: number }) => void): () => void;
      installUpdate(): Promise<void>;
      notesEdit(active: boolean): Promise<boolean>;
      milestonesSeen(): Promise<void>;
      timelapseDays(): Promise<TimelapseDays | null>;
      timelapseDay(day: string): Promise<DayRaw | null>;
      /** Ask Gemini. Present in the full build only. */
      ask?: AskBridge;
      /** Work mode (monday Tasks). Present in the full build only. */
      work?: WorkBridge;
      /** Work mode's inbox. Present in the full build only. */
      mail?: MailBridge;
    };
  }
}

// ── State ──────────────────────────────────────────────────────────────────

const statsMount = document.getElementById('view-stats') as HTMLDivElement;
const switchEl = document.getElementById('mode-switch') as HTMLElement;
const diagEl = document.getElementById('diagnostics') as HTMLPreElement;

let state: WallState | null = null;
const statsView = new StatsView();

/*
 * The notes bar belongs to the shell, so it is mounted on
 * the body. Saving goes through updateSettings like
 * every other setting, which means the other monitor's wall window picks the
 * text up on the state push that follows.
 */
const notesBar = new NotesBar({
  save: (text) => window.wall.updateSettings({ notes: text }),
  // The wall cannot receive a keystroke unless it is made focusable first. See
  // the WallWindow.notesEditing comment in src/main/index.ts.
  setEditing: (active) => window.wall.notesEdit(active),
});
document.body.appendChild(notesBar.root);

/*
 * Top right: "Today" plays the work time-lapse and "Milestones" opens the list.
 * Shell furniture like the notes bar, fed from the same usage push as the
 * stats view.
 */
const wallActions = new WallActions();
document.body.appendChild(wallActions.root);

/*
 * Ask Gemini (docs/ask-gemini.md), full build only. Both conditions on
 * purpose: the edition constant keeps the panel out of the stats bundle's
 * behaviour, and the preload is the authority on whether the calls exist.
 */
if (!isStatsOnly && window.wall.ask) {
  const askPanel = new AskPanel(window.wall.ask);
  // The panel goes inside the action row, so it hangs from the row's real bottom (ask.css).
  wallActions.addChip(askPanel.chip, askPanel.root);
}

/*
 * Work mode (docs/work-mode.md), full build only. The require is inside a test
 * of the build define itself (not the imported isStatsOnly, which esbuild only
 * inlines after it has chosen the files), so the stats bundle leaves out the
 * whole module and every monday string; the preload is the authority on
 * whether the calls exist. Its stylesheet is linked here for the same reason.
 */
let workView: WorkView | null = null;
let workMount: HTMLDivElement | null = null;
if (process.env.MBW_EDITION !== 'stats' && window.wall.work) {
  const { WorkView: View } = require('./work') as typeof import('./work');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'styles/work.css';
  document.head.append(link);
  workMount = document.createElement('div');
  workMount.id = 'view-work';
  workMount.className = 'view';
  document.getElementById('stage')!.append(workMount);
  workView = new View(window.wall.work, window.wall.mail);
  workMount.append(workView.root);
  // Mine | Everyone and + Task live in the action row, shown only in Work (actions.css).
  wallActions.addChip(workView.newChip, workView.newPanel);
  wallActions.addChip(workView.filterChip);
  workView.onFilter = (f) => {
    void window.wall.updateSettings({ workFilter: f }).catch((err: unknown) =>
      console.error('[renderer] could not save the task filter:', err),
    );
  };
}

// The top panel's Constellation / Live toggle is saved like any other setting,
// so the choice survives a restart and a second monitor follows it.
statsView.onTopPanel = (mode) => {
  void window.wall.updateSettings({ topPanel: mode }).catch((err: unknown) =>
    console.error('[renderer] could not save the top panel choice:', err),
  );
};
statsMount.appendChild(statsView.root);

/*
 * Simple | Detailed and Codex on or off (docs/design/codex-side-by-side.md).
 * Saved like the top panel choice, so they survive a restart and a second
 * monitor follows. A click applies at once; the state push that follows the
 * save repeats the same values, and applyViewPrefs is idempotent.
 */
let viewPref: 'detailed' | 'simple' = 'detailed';
let codexPref = true;
/** The values last read from settings, so a resize re-render does not re-apply a stale state. */
let lastSavedView: 'detailed' | 'simple' | null = null;
let lastSavedCodex: boolean | null = null;
function applyViewPrefs(): void {
  statsView.setPrefs(viewPref, codexPref);
  wallActions.setPrefs(viewPref, codexPref);
}
wallActions.onView = (v) => {
  viewPref = v;
  applyViewPrefs();
  void window.wall.updateSettings({ statsView: v }).catch((err: unknown) =>
    console.error('[renderer] could not save the dashboard view:', err),
  );
};
wallActions.onCodex = (on) => {
  codexPref = on;
  applyViewPrefs();
  void window.wall.updateSettings({ showCodex: on }).catch((err: unknown) =>
    console.error('[renderer] could not save the Codex choice:', err),
  );
};

/** Create shell elements without interpreting text as HTML. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let lastSavedFilter: 'mine' | 'everyone' | null = null;

function render(): void {
  if (!state) return;

  document.body.dataset.perf = state.capability.tier;
  notesBar.setText(state.settings.notes);
  statsView.setTopPanel(state.settings.topPanel ?? 'constellation');
  /*
   * Defaults per the contract: the wall opens on the detailed view, with Codex
   * shown. Applied only when the SAVED values change: render() also runs on
   * every resize, and re-reading a state that predates a click would undo the
   * click until the save's own push arrives.
   */
  const savedView = state.settings.statsView === 'simple' ? 'simple' : 'detailed';
  const savedCodex = state.settings.showCodex !== false;
  if (savedView !== lastSavedView || savedCodex !== lastSavedCodex) {
    lastSavedView = savedView;
    lastSavedCodex = savedCodex;
    viewPref = savedView;
    codexPref = savedCodex;
    applyViewPrefs();
  }
  if (workView && state.settings.workFilter && state.settings.workFilter !== lastSavedFilter) {
    lastSavedFilter = state.settings.workFilter;
    workView.setFilter(state.settings.workFilter);
  }
  document.body.dataset.background = state.settings.background ?? 'gradient';
  document.body.style.setProperty('--backdrop-opacity', String(state.settings.backgroundOpacity ?? 1));
  renderDiagnostics();
}

function renderDiagnostics(): void {
  if (!state) return;
  /*
   * Coerced, because toggleAttribute TOGGLES when its second argument is
   * undefined rather than clearing. A settings file written before `debug`
   * existed, or any state that reaches here without the key, made the
   * diagnostics panel flip on and off on every render. It was found by
   * capturing a screenshot for the website: an empty bordered box sat over the
   * status bar and nothing in the DOM explained it until elementFromPoint
   * named the element.
   */
  const on = state.settings.debug === true;
  diagEl.toggleAttribute('data-on', on);
  if (!on) return;

  const d = state.display;

  diagEl.replaceChildren();
  const line = (text: string, cls?: string) => {
    const s = el('span', cls, `${text}\n`);
    diagEl.appendChild(s);
  };

  line('MuchBetter Client Wall  ::  diagnostics');
  line(
    `display   ${d ? `${d.index + 1}/${d.total}  ${d.width}x${d.height} @${d.scaleFactor}x${d.isPrimary ? '  primary' : ''}` : 'unknown'}`,
  );
  line(`viewport  ${window.innerWidth}x${window.innerHeight}`);
  line(
    `perf      ${state.capability.tier}  (${state.capability.cores} cores, ${state.capability.memoryGb} GB, GPU ${
      state.capability.gpuAccelerated ? 'on' : 'OFF'
    })`,
  );
  line(`layer     ${state.settings.layerMode}${state.focusMode ? '  [FOCUS]' : ''}   clickThrough ${state.settings.clickThrough}`);
  line(
    `win32     ${state.win32.available ? 'available' : `UNAVAILABLE (${state.win32.reason})`}`,
    state.win32.available ? 'diag-ok' : 'diag-err',
  );
}

// ── Modes ──────────────────────────────────────────────────────────────────

let mode: 'stats' | 'work' = 'stats';
/** Work is offered: full build, the Work view exists, and main says this wall may show it. */
const workOffered = (): boolean => !isStatsOnly && !!workView && state?.work === true;

/**
 * Cross-fade between the two views. Both stay mounted; only the stats canvas
 * is stopped while hidden, because it is the one thing that costs CPU.
 */
function applyMode(next: 'stats' | 'work', animate = true): void {
  if (!workOffered()) next = 'stats';
  mode = next;
  document.body.dataset.mode = next;
  statsMount.classList.toggle('is-active', next === 'stats');
  workMount?.classList.toggle('is-active', next === 'work');
  if (!animate) {
    for (const m of [statsMount, workMount]) {
      if (!m) continue;
      m.style.transition = 'none';
      requestAnimationFrame(() => {
        m.style.transition = '';
      });
    }
  }
  statsView.setVisible(next === 'stats');
  workView?.setVisible(next === 'work');
  renderFocusExit();
}

function setMode(next: 'stats' | 'work'): void {
  if (mode === next || !workOffered()) return;
  applyMode(next);
  void window.wall.updateSettings({ mode: next }).catch((err: unknown) =>
    console.error('[renderer] could not save the view:', err),
  );
}

/**
 * The top-centre bar: Claude Stats | Work when Work is offered, and the focus
 * mode exit when focus mode is on. With neither, it is hidden.
 */
function renderFocusExit(): void {
  const focused = state?.focusMode === true;
  const offered = workOffered();
  document.body.classList.toggle('is-focus', focused);
  switchEl.hidden = !focused && !offered;
  switchEl.setAttribute('aria-label', offered ? 'View' : 'Focus mode');
  let buttons = [...switchEl.querySelectorAll<HTMLButtonElement>('.mode-btn')];
  if (offered && !buttons.length) {
    for (const [id, label] of [['stats', 'Claude Stats'], ['work', 'Work']] as const) {
      const b = el('button', 'mode-btn', label);
      b.type = 'button';
      b.dataset.mode = id;
      b.addEventListener('click', () => setMode(id));
      switchEl.prepend(b);
    }
    // Prepended in reverse, so put them in reading order.
    const work = switchEl.querySelector('.mode-btn[data-mode="work"]');
    if (work) switchEl.querySelector('.mode-btn[data-mode="stats"]')?.after(work);
    switchEl.prepend(el('span', 'mode-thumb'));
    buttons = [...switchEl.querySelectorAll<HTMLButtonElement>('.mode-btn')];
  } else if (!offered && buttons.length) {
    for (const b of buttons) b.remove();
    switchEl.querySelector('.mode-thumb')?.remove();
    buttons = [];
  }
  for (const b of buttons) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  switchEl.dataset.mode = mode;
  // The pill is sized from the ACTIVE button's real geometry: the labels differ in width.
  requestAnimationFrame(() => {
    const active = switchEl.querySelector<HTMLElement>('.mode-btn.is-on');
    const thumb = switchEl.querySelector<HTMLElement>('.mode-thumb');
    if (!active || !thumb) return;
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft - 3}px)`;
  });
  let exit = switchEl.querySelector<HTMLElement>('.focus-exit');
  if (focused && !exit) {
    exit = el('button', 'focus-exit', 'Exit focus  ·  Esc');
    exit.addEventListener('click', () => void window.wall.exitFocus?.());
    switchEl.appendChild(exit);
  } else if (!focused && exit) {
    exit.remove();
  }
}

document.body.dataset.mode = 'stats';
statsView.setVisible(true);
switchEl.hidden = true;

// ── Wiring ─────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Focus mode puts an opaque fullscreen window on top of everything, so
    // there must always be an obvious way out of it.
    void window.wall.exitFocus?.();
  }
  // Tab flips views without reaching for the mouse (full build, Work offered).
  // Text boxes stop their own keys, so typing never gets here.
  // A form (a Work box or the new-task form) keeps Tab for moving between its fields.
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && workOffered() && !(e.target as Element | null)?.closest?.('form')) {
    e.preventDefault();
    setMode(mode === 'stats' ? 'work' : 'stats');
  }
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(render, 160);
});

window.wall.onState((next) => {
  const focusChanged = state?.focusMode !== next.focusMode;
  const offerChanged = state?.work !== next.work;
  state = next;
  const wanted = next.mode === 'work' ? 'work' : 'stats';
  if (wanted !== mode || offerChanged) applyMode(wanted);
  else if (focusChanged) renderFocusExit();
  statsView.setPerfTier(next.capability.tier);
  statsView.setVersion(next.appVersion);
  render();
});

window.wall.onUsage?.((usage) => {
  statsView.update(usage);
  wallActions.update(usage as never);
});
window.wall.onUsageProgress?.((p) => statsView.setProgress(p));

window.wall
  .getState()
  .then((initial) => {
    if (initial) {
      state = initial;
      statsView.setPerfTier(initial.capability.tier);
      statsView.setVersion(initial.appVersion);
      // No animation on the very first paint: the view should already be there.
      applyMode(initial.mode === 'work' ? 'work' : 'stats', false);
      render();
    }
  })
  .catch((err) => console.error('[renderer] initial state failed:', err));

window.wall
  .getUsage?.()
  .then((u) => {
    if (u) {
      statsView.update(u);
      wallActions.update(u as never);
    }
  })
  .catch((err) => console.error('[renderer] initial usage failed:', err));


/*
 * The Install pill.
 *
 * An update that has downloaded itself is useless if the only way to learn
 * about it is a tray menu nobody opens, so the wall says so directly and the
 * click that installs happens here rather than in the floating toast. The toast
 * cannot be clicked on purpose: it sits above other applications, and a window
 * that intercepts a click while you are working elsewhere is worse than one
 * that only informs.
 *
 * Click-through is honoured rather than worked around. When the wall is set to
 * pass clicks through, nothing on it is clickable. The
 * pill is still shown, because knowing is useful even when the action has to
 * come from the tray.
 */
function installPill(): HTMLButtonElement {
  const pill = el('button', 'update-pill');
  pill.type = 'button';
  pill.hidden = true;
  pill.append(el('span', 'update-pill-dot'), el('span', 'update-pill-label', 'Install update'));
  pill.addEventListener('click', () => {
    pill.disabled = true;
    pill.querySelector('.update-pill-label')!.textContent = 'Installing';
    void window.wall.installUpdate();
  });
  document.body.appendChild(pill);
  return pill;
}

{
  const pill = installPill();
  window.wall.onUpdate?.((u) => {
    const ready = u.phase === 'ready';
    pill.hidden = !ready;
    if (ready && !pill.disabled) {
      pill.title = `Version ${u.version ?? ''} is downloaded and ready to install`.replace('  ', ' ');
    }
  });
}
