/**
 * The "Any day" picker: a month grid of every day, and which of them can be
 * replayed.
 *
 * Clicks only. The wall is `focusable: false`, so there is no date field to
 * type into and no key to press; a month is six rows, so there is no scrolling
 * either. Clicking a bright day plays it at once, with no confirm step.
 *
 * What a day can do comes from the main process (`wall:timelapseDays`), which
 * compares the requests that day with the ones that have five-minute detail:
 *
 *   full     every request has detail            bright, plays
 *   partial  some are archived without detail    bright with a dot, plays, captioned
 *   total    only a reconstructed count survives dim, does nothing
 *   none     nothing recorded                    very dim, does nothing
 *
 * The dim days are said to be what they are, never drawn (rule 12).
 */

import { dayShape, type TimelapseDays } from '../shared/intraday';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const pad = (n: number): string => String(n).padStart(2, '0');
const keyOf = (y: number, m: number, d: number): string => `${y}-${pad(m + 1)}-${pad(d)}`;
const monthIndex = (y: number, m: number): number => y * 12 + m;

export class DayPicker {
  readonly root: HTMLElement;
  private days: TimelapseDays | null = null;
  /** The month shown, as year * 12 + month. */
  private shown = 0;
  onPick: ((day: string) => void) | null = null;

  constructor() {
    this.root = el('div', 'dp-pop');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Pick a day to replay');
  }

  /** Show the grid for these days, opening on today's month. Null while they load. */
  show(days: TimelapseDays | null): void {
    this.days = days;
    const [y, m] = (days?.today ?? keyOf(new Date().getFullYear(), new Date().getMonth(), 1)).split('-').map(Number);
    this.shown = monthIndex(y, m - 1);
    this.render();
  }

  /** The months that can be shown: from the first day with any record to this month. */
  private range(): { min: number; max: number } {
    const [ty, tm] = (this.days?.today ?? '').split('-').map(Number);
    const max = Number.isFinite(ty) ? monthIndex(ty, tm - 1) : this.shown;
    const keys = Object.keys(this.days?.days ?? {}).sort();
    const [fy, fm] = (keys[0] ?? '').split('-').map(Number);
    const min = Number.isFinite(fy) ? Math.min(max, monthIndex(fy, fm - 1)) : max;
    return { min, max };
  }

  private render(): void {
    this.root.replaceChildren();
    const head = el('div', 'dp-head');
    const { min, max } = this.range();
    const prev = el('button', 'dp-nav', '‹');
    prev.type = 'button';
    prev.title = 'Previous month';
    prev.disabled = this.shown <= min;
    prev.addEventListener('click', () => this.go(-1));
    const next = el('button', 'dp-nav', '›');
    next.type = 'button';
    next.title = 'Next month';
    next.disabled = this.shown >= max;
    next.addEventListener('click', () => this.go(1));
    const y = Math.floor(this.shown / 12);
    const m = this.shown % 12;
    const title = new Date(y, m, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    head.append(prev, el('div', 'dp-month', title), next);
    this.root.appendChild(head);

    if (!this.days) {
      this.root.appendChild(el('div', 'dp-empty', 'Reading days...'));
      return;
    }

    const grid = el('div', 'dp-grid');
    for (const d of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) grid.appendChild(el('span', 'dp-dow', d));
    // Monday first: getDay() is 0 for Sunday.
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) grid.appendChild(el('span', 'dp-blank'));
    const inMonth = new Date(y, m + 1, 0).getDate();
    const today = this.days.today;
    for (let d = 1; d <= inMonth; d++) grid.appendChild(this.cell(keyOf(y, m, d), d, today));
    this.root.append(grid, el('div', 'dp-foot', 'Bright days can be replayed. Dim days have a total only.'));
  }

  private cell(key: string, n: number, today: string): HTMLElement {
    const info = this.days?.days[key];
    const shape = key > today ? 'future' : dayShape(info);
    const playable = shape === 'full' || shape === 'partial';
    const c = el(playable ? 'button' : 'span', 'dp-day', String(n));
    c.dataset.shape = shape;
    c.dataset.day = key;
    if (key === today) c.dataset.today = 'true';
    if (shape === 'partial' && info) {
      c.title = `${info.shaped.toLocaleString('en-GB')} of ${info.requests.toLocaleString('en-GB')} requests have minute detail`;
    } else if (shape === 'total') {
      c.title = 'Total only: reconstructed, no minute detail to replay';
    } else if (shape === 'full' && info) {
      c.title = `${info.requests.toLocaleString('en-GB')} requests`;
    } else if (shape === 'none') {
      c.title = 'Nothing recorded';
    }
    if (playable) {
      (c as HTMLButtonElement).type = 'button';
      c.addEventListener('click', () => this.onPick?.(key));
    }
    return c;
  }

  private go(delta: number): void {
    const { min, max } = this.range();
    this.shown = Math.max(min, Math.min(max, this.shown + delta));
    this.render();
  }
}
