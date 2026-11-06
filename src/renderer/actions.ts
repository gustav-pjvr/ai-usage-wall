/**
 * The wall's on-demand buttons, top right: "Today", which plays today's
 * time-lapse; "Any day", which opens a month grid to replay another day; and
 * "Milestones", which opens the list, with a badge counting ones not yet seen.
 *
 * Gustav asked for all of them to be on demand. Nothing here plays or opens by
 * itself, and nothing floats over other applications: the badge is the only
 * announcement a milestone gets, and it waits on the wall until he looks.
 *
 * Clicks only. The wall is `focusable: false`, and no control here needs a key,
 * so none asks for focus. Each popover closes on a click anywhere outside it,
 * which is also why it can never become a trap (rule 17), and only one is open
 * at a time.
 */

import { localDayKey } from '../shared/day';
import type { DayRaw } from '../shared/intraday';
import { labelProjects } from '../shared/project-label';
import { buildDaySeries } from '../shared/timelapse';
import { DayPicker } from './day-picker';
import { longDay, WorkReplay } from './timelapse';

interface AchievedView { key: string; title: string; sub: string; at: string; seeded: boolean }
interface MilestonesView {
  achieved: AchievedView[];
  unseen: string[];
  next: { title: string; progress: number; remaining: string }[];
  /** True while the index is being rebuilt: "next up" is withheld, not guessed. */
  reading?: boolean;
}

interface UsageLike {
  /** Present when this machine (or the source it is paired to) has Codex data. */
  codex?: { indexing?: boolean } | null;
  projects?: Record<string, { display?: string }>;
  activeDays?: Record<string, number>;
  indexing?: boolean;
  unavailable?: boolean;
  milestones?: MilestonesView | null;
  projection?: { role?: string };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const shortDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

type Popover = 'milestones' | 'days' | null;

export class WallActions {
  readonly root: HTMLElement;
  private readonly todayBtn: HTMLButtonElement;
  private readonly daysBtn: HTMLButtonElement;
  private readonly msBtn: HTMLButtonElement;
  private readonly badge: HTMLElement;
  private readonly pop: HTMLElement;
  private readonly picker = new DayPicker();
  private readonly replay = new WorkReplay();
  private usage: UsageLike | null = null;
  private ms: MilestonesView | null = null;
  /** A day is being fetched: a second click must not start a second replay. */
  private loading = false;
  /*
   * The two view choices for Claude and Codex side by side
   * (docs/design/codex-side-by-side.md): Simple | Detailed, and Codex on or
   * off. Saved in settings by main.ts, which owns persistence; this only
   * reports the click and paints what it is told.
   */
  private readonly seg: HTMLElement;
  private readonly codexBtn: HTMLButtonElement;
  private view: 'detailed' | 'simple' = 'detailed';
  private showCodex = true;
  onView: ((v: 'detailed' | 'simple') => void) | null = null;
  onCodex: ((on: boolean) => void) | null = null;

  constructor() {
    this.root = el('div');
    this.root.id = 'wall-actions';

    this.seg = el('div', 'wall-seg');
    this.seg.setAttribute('role', 'group');
    this.seg.setAttribute('aria-label', 'Dashboard view');
    for (const [v, label] of [['simple', 'Simple'], ['detailed', 'Detailed']] as const) {
      const b = el('button', 'wall-seg-btn', label);
      b.type = 'button';
      b.dataset.view = v;
      b.addEventListener('click', () => {
        if (this.view === v) return;
        this.setPrefs(v, this.showCodex);
        this.onView?.(v);
      });
      this.seg.append(b);
    }

    /*
     * The Codex chip. Not in the DOM at all while the payload carries no Codex
     * data (any other install of the stats edition): there is nothing to turn
     * on, and a toggle that does nothing is a lie.
     */
    this.codexBtn = el('button', 'wall-codex');
    this.codexBtn.type = 'button';
    this.codexBtn.append(el('span', 'wall-codex-dot'), el('span', 'wall-codex-label', 'Codex'), el('span', 'wall-codex-track'));
    this.codexBtn.addEventListener('click', () => {
      const next = !this.showCodex;
      this.setPrefs(this.view, next);
      this.onCodex?.(next);
    });

    this.todayBtn = el('button', 'wall-action wall-action-today', 'Today');
    this.todayBtn.type = 'button';
    this.todayBtn.title = 'Replay today so far';
    this.todayBtn.addEventListener('click', () => this.playDay(localDayKey(Date.now())));

    this.daysBtn = el('button', 'wall-action wall-action-days', 'Any day');
    this.daysBtn.type = 'button';
    this.daysBtn.title = 'Replay another day';
    this.daysBtn.addEventListener('click', () => this.toggle('days'));

    this.msBtn = el('button', 'wall-action wall-action-ms');
    this.msBtn.type = 'button';
    this.msBtn.append(el('span', 'wall-action-label', 'Milestones'));
    this.badge = el('span', 'wall-badge');
    this.badge.setAttribute('aria-label', 'new milestones');
    this.msBtn.append(this.badge);
    this.msBtn.addEventListener('click', () => this.toggle('milestones'));

    this.pop = el('div', 'ms-pop');
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', 'Milestones');

    this.picker.onPick = (day) => {
      this.close();
      this.playDay(day);
    };

    this.root.append(this.seg, this.todayBtn, this.daysBtn, this.msBtn, this.pop, this.picker.root);
    this.setBadge(0);
    this.setPrefs(this.view, this.showCodex);

    // A click anywhere outside closes whichever popover is open. pointerdown,
    // so it closes before the click lands on whatever was underneath.
    document.addEventListener('pointerdown', (e) => {
      const open = this.open;
      if (!open) return;
      const t = e.target as Node;
      const [panel, btn] = open === 'milestones' ? [this.pop, this.msBtn] : [this.picker.root, this.daysBtn];
      if (!panel.contains(t) && !btn.contains(t)) this.close();
    });
  }

  /**
   * Add a chip after Milestones, and a panel that hangs from this row (like the
   * milestone list). Generic on purpose: the one caller is Ask Gemini, full
   * build only (src/renderer/main.ts), and keeping its own code out of this
   * file keeps it out of the stats bundle entirely.
   */
  addChip(chip: HTMLElement, panel?: HTMLElement): void {
    if (chip.isConnected) return;
    this.msBtn.after(chip);
    if (panel) this.root.append(panel);
  }

  /** Paint the saved choices. Idempotent: every state push repeats them. */
  setPrefs(view: 'detailed' | 'simple', showCodex: boolean): void {
    this.view = view;
    this.showCodex = showCodex;
    for (const b of this.seg.querySelectorAll<HTMLButtonElement>('.wall-seg-btn')) {
      const on = b.dataset.view === view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.codexBtn.dataset.on = showCodex ? 'on' : 'off';
    this.codexBtn.setAttribute('aria-pressed', String(showCodex));
    this.paintCodexTitle();
  }

  private paintCodexTitle(): void {
    this.codexBtn.title = this.codexBtn.dataset.reading === 'on'
      ? 'Still reading Codex sessions'
      : this.showCodex ? 'Hide Codex' : 'Show Codex beside Claude';
  }

  private get open(): Popover {
    const v = this.root.dataset.open;
    return v === 'milestones' || v === 'days' ? v : null;
  }

  update(u: UsageLike): void {
    this.usage = u;
    const onScreen = u.projection?.role === 'screen';

    // The chip exists only with Codex data, right after the view switch.
    const hasCodex = !!u.codex && typeof u.codex === 'object';
    if (hasCodex && !this.codexBtn.isConnected) this.seg.after(this.codexBtn);
    else if (!hasCodex && this.codexBtn.isConnected) this.codexBtn.remove();
    // First index still running: the choice can be made, but nothing shows yet (rule 15).
    this.codexBtn.dataset.reading = hasCodex && u.codex?.indexing ? 'on' : 'off';
    this.paintCodexTitle();

    /*
     * The replay needs this machine's five-minute detail, which does not cross
     * the projection wire, so a screen has nothing to replay and offers neither
     * button. While indexing, no day is complete yet; say so rather than replay
     * part of one as if it were the whole (rule 15).
     */
    const hasToday = (u.activeDays?.[localDayKey(Date.now())] ?? 0) > 0;
    const blocked = Boolean(u.indexing) || Boolean(u.unavailable);
    this.root.dataset.replay = onScreen ? 'off' : 'on';
    this.todayBtn.disabled = blocked || !hasToday;
    this.todayBtn.title = u.indexing ? 'Still reading transcripts' : hasToday ? 'Replay today so far' : 'Nothing recorded yet today';
    this.daysBtn.disabled = blocked;
    this.daysBtn.title = u.indexing ? 'Still reading transcripts' : 'Replay another day';
    if (blocked && this.open === 'days') this.close();

    this.ms = u.milestones ?? null;
    this.root.dataset.milestones = this.ms ? 'on' : 'off';
    this.setBadge(this.ms?.unseen.length ?? 0);
    if (this.open === 'milestones') this.renderList();
  }

  /** Labels exactly as the rest of the wall makes them, disambiguated against every known project. */
  private labeller(raw: DayRaw): (key: string, display: string) => string | null {
    const paths = new Set<string>();
    for (const [key, v] of Object.entries(this.usage?.projects ?? {})) paths.add(v.display || key);
    for (const [key, p] of Object.entries(raw.projects)) if (key) paths.add(p.display || key);
    const labels = labelProjects([...paths]);
    return (key, display) => (key ? labels.get(display || key) ?? (display || key).split(/[\\/]/).pop() ?? key : null);
  }

  private playDay(day: string): void {
    if (this.replay.playing || this.loading) return;
    this.close();
    this.loading = true;
    window.wall
      .timelapseDay(day)
      .then((raw) => {
        if (!raw) return; // refused: indexing started, or this is a screen
        const series = buildDaySeries(raw, this.labeller(raw), Date.now());
        if (series) this.replay.play(series);
        else this.replay.notice(longDay(day), `${longDay(day)} has a total only, nothing to replay.`);
      })
      .catch((err: unknown) => {
        console.error(`[renderer] could not read ${day} for the time-lapse:`, err);
        this.replay.notice(longDay(day), 'Could not read that day.');
      })
      .finally(() => {
        this.loading = false;
      });
  }

  private setBadge(n: number): void {
    this.badge.textContent = n > 9 ? '9+' : String(n);
    this.root.dataset.badge = n > 0 ? 'on' : 'off';
    this.msBtn.title = n > 0 ? `${n} new milestone${n === 1 ? '' : 's'}` : 'Milestones';
  }

  private toggle(which: 'milestones' | 'days'): void {
    if (this.open === which) {
      this.close();
      return;
    }
    if (which === 'milestones') {
      this.renderList();
      this.root.dataset.open = 'milestones';
      // Seen the moment it is open. The badge clears on the push that follows,
      // because the ledger in the main process is the only authority on it.
      if ((this.ms?.unseen.length ?? 0) > 0) {
        void window.wall.milestonesSeen().catch((err: unknown) =>
          console.error('[renderer] could not mark milestones seen:', err),
        );
      }
      return;
    }
    this.picker.show(null);
    this.root.dataset.open = 'days';
    window.wall
      .timelapseDays()
      .then((days) => {
        if (this.open !== 'days') return;
        if (days) this.picker.show(days);
        else this.close(); // refused: indexing started meanwhile
      })
      .catch((err: unknown) => {
        console.error('[renderer] could not list days for the time-lapse:', err);
        this.close();
      });
  }

  private close(): void {
    this.root.dataset.open = 'false';
  }

  private renderList(): void {
    const ms = this.ms;
    this.pop.replaceChildren();
    const head = el('div', 'ms-head');
    head.append(el('div', 'ms-title', 'Milestones'));
    const x = el('button', 'ms-close', 'Close');
    x.type = 'button';
    x.addEventListener('click', () => this.close());
    head.append(x);
    this.pop.append(head);

    if (!ms) {
      this.pop.append(el('div', 'ms-empty', 'Milestones start once the first scan finishes.'));
      return;
    }
    const unseen = new Set(ms.unseen);
    const body = el('div', 'ms-body');

    if (ms.reading) {
      body.append(el('div', 'ms-section', 'Next up'));
      body.append(el('div', 'ms-empty', 'Still reading transcripts. Progress appears when the scan finishes.'));
    } else if (ms.next.length) {
      body.append(el('div', 'ms-section', 'Next up'));
      for (const n of ms.next) {
        const row = el('div', 'ms-next');
        const top = el('div', 'ms-next-top');
        top.append(el('span', 'ms-next-title', n.title), el('span', 'ms-next-left', n.remaining));
        const track = el('div', 'ms-track');
        const fill = el('div', 'ms-fill');
        fill.style.transform = `scaleX(${Math.max(0, Math.min(1, n.progress)).toFixed(3)})`;
        track.append(fill);
        row.append(top, track);
        body.append(row);
      }
    }

    body.append(el('div', 'ms-section', 'Achieved'));
    if (!ms.achieved.length) body.append(el('div', 'ms-empty', 'Nothing yet. The first one is on its way.'));
    for (const a of ms.achieved) {
      const row = el('div', 'ms-row');
      if (unseen.has(a.key)) row.classList.add('is-new');
      const text = el('div', 'ms-row-text');
      text.append(el('div', 'ms-row-title', a.title), el('div', 'ms-row-sub', a.sub));
      // A seeded milestone was already crossed when the ledger began, so it has
      // no honest date of its own. It says "earlier", not the day it was noticed.
      const when = el('div', 'ms-row-when', unseen.has(a.key) ? 'new' : a.seeded ? 'earlier' : shortDate(a.at));
      row.append(text, when);
      body.append(row);
    }
    this.pop.append(body);
  }
}
