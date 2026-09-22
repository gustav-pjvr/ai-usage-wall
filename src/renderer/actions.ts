/**
 * The wall's two on-demand buttons, top right: "Today", which plays the work
 * time-lapse, and "Milestones", which opens the list, with a badge counting
 * ones not yet seen.
 *
 * Gustav asked for both to be on demand. Nothing here plays or opens by
 * itself, and nothing floats over other applications: the badge is the only
 * announcement a milestone gets, and it waits on the wall until he looks.
 *
 * Clicks only. The wall is `focusable: false`, and neither control needs a key,
 * so neither asks for focus. The list closes on a click anywhere outside it,
 * which is also why it can never become a trap (rule 17).
 */

import { labelProjects } from '../shared/project-label';
import { buildWorkDay, WorkReplay } from './timelapse';

interface AchievedView { key: string; title: string; sub: string; at: string; seeded: boolean }
interface MilestonesView {
  achieved: AchievedView[];
  unseen: string[];
  next: { title: string; progress: number; remaining: string }[];
  /** True while the index is being rebuilt: "next up" is withheld, not guessed. */
  reading?: boolean;
}

interface UsageLike {
  projects?: Record<string, { display?: string }>;
  projectHourly?: Record<string, Record<string, [number, number, number]>>;
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

export class WallActions {
  readonly root: HTMLElement;
  private readonly replayBtn: HTMLButtonElement;
  private readonly msBtn: HTMLButtonElement;
  private readonly badge: HTMLElement;
  private readonly pop: HTMLElement;
  private readonly replay = new WorkReplay();
  private usage: UsageLike | null = null;
  private ms: MilestonesView | null = null;

  constructor() {
    this.root = el('div');
    this.root.id = 'wall-actions';

    this.replayBtn = el('button', 'wall-action', 'Today');
    this.replayBtn.type = 'button';
    this.replayBtn.title = 'Replay today so far';
    this.replayBtn.addEventListener('click', () => this.playToday());

    this.msBtn = el('button', 'wall-action');
    this.msBtn.type = 'button';
    this.msBtn.append(el('span', 'wall-action-label', 'Milestones'));
    this.badge = el('span', 'wall-badge');
    this.badge.setAttribute('aria-label', 'new milestones');
    this.msBtn.append(this.badge);
    this.msBtn.addEventListener('click', () => this.toggleList());

    this.pop = el('div', 'ms-pop');
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', 'Milestones');

    this.root.append(this.replayBtn, this.msBtn, this.pop);
    this.setBadge(0);

    // A click anywhere outside closes the list. pointerdown, so it closes
    // before the click lands on whatever was underneath.
    document.addEventListener('pointerdown', (e) => {
      if (!this.isOpen) return;
      const t = e.target as Node;
      if (!this.pop.contains(t) && !this.msBtn.contains(t)) this.close();
    });
  }

  private get isOpen(): boolean {
    return this.root.dataset.open === 'true';
  }

  update(u: UsageLike): void {
    this.usage = u;
    const onScreen = u.projection?.role === 'screen';

    /*
     * The replay needs this machine's per-project hours, which do not cross the
     * projection wire, so a screen has nothing to replay and does not offer it.
     * While indexing, today is not complete yet; say so rather than replay a
     * part of it as if it were the whole.
     */
    const day = this.today();
    this.root.dataset.replay = onScreen ? 'off' : 'on';
    this.replayBtn.disabled = !day || Boolean(u.indexing) || Boolean(u.unavailable);
    this.replayBtn.title = u.indexing
      ? 'Still reading transcripts'
      : day
        ? 'Replay today so far'
        : 'Nothing recorded yet today';

    this.ms = u.milestones ?? null;
    this.root.dataset.milestones = this.ms ? 'on' : 'off';
    this.setBadge(this.ms?.unseen.length ?? 0);
    if (this.isOpen) this.renderList();
  }

  private today() {
    const u = this.usage;
    if (!u?.projectHourly) return null;
    const entries = Object.entries(u.projects ?? {});
    const paths = entries.map(([key, v]) => v.display || key);
    const labels = labelProjects(paths);
    const byKey = new Map(entries.map(([key], i) => [key, labels.get(paths[i]) ?? paths[i]]));
    return buildWorkDay(u.projectHourly, (key) => byKey.get(key) ?? key.split(/[\\/]/).pop() ?? key);
  }

  private playToday(): void {
    if (this.replay.playing) return;
    this.close();
    const day = this.today();
    if (day) this.replay.play(day);
  }

  private setBadge(n: number): void {
    this.badge.textContent = n > 9 ? '9+' : String(n);
    this.root.dataset.badge = n > 0 ? 'on' : 'off';
    this.msBtn.title = n > 0 ? `${n} new milestone${n === 1 ? '' : 's'}` : 'Milestones';
  }

  private toggleList(): void {
    if (this.isOpen) {
      this.close();
      return;
    }
    this.renderList();
    this.root.dataset.open = 'true';
    // Seen the moment it is open. The badge clears on the push that follows,
    // because the ledger in the main process is the only authority on it.
    if ((this.ms?.unseen.length ?? 0) > 0) {
      void window.wall.milestonesSeen().catch((err: unknown) =>
        console.error('[renderer] could not mark milestones seen:', err),
      );
    }
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
