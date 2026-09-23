/**
 * The time-lapse overlay: one day as three lines that draw themselves left to
 * right behind a moving playhead, while a clock and three running totals count
 * up. Played only when "Today" or a day in the picker is clicked.
 *
 * WHAT IT SHOWS (Gustav: "I dont really get what its displaying")
 *
 * Three stacked lanes on one time axis: tokens processed (the headline, twice
 * the height), tokens generated, and requests, each per five minutes. Each lane
 * has its own fixed scale from the first frame, set by that day's highest slot
 * and stated in its corner, so a spike is visibly a spike before it arrives.
 * Time is uniform: an hour is the same width everywhere.
 *
 * WHY IT CANNOT TRAP ANYONE (rule 17)
 *
 * - It is driven by elapsed wall-clock time (src/shared/timelapse.ts), so a
 *   slow or throttled frame skips ahead rather than stretching the replay.
 * - A hard stop at `replayLength`, whatever happens.
 * - Any click anywhere on it ends it at once.
 * - It never takes keyboard focus, so it never needs a key to escape.
 *
 * COST (rule 39): one canvas, frame-capped by performance tier, and a frame is
 * skipped when the playhead has not moved a whole device pixel. Nothing runs
 * while it is closed.
 */

import { FADE_MS, hhmm, replayFrame, replayLength, type DaySeries, type ReplayFrame } from '../shared/timelapse';
import { BUCKET_MINUTES } from '../shared/intraday';

/** How long a "nothing to replay" notice stays up. Any click ends it sooner. */
const NOTICE_MS = 4_000;

const LANES = [
  { key: 'tokens', name: 'Tokens processed', line: 'oklch(0.8 0.13 75)', fill: 'oklch(0.8 0.13 75 / 0.12)' },
  { key: 'output', name: 'Tokens generated', line: 'oklch(0.8 0.14 200)', fill: 'oklch(0.8 0.14 200 / 0.12)' },
  { key: 'requests', name: 'Requests', line: 'oklch(0.85 0.02 220)', fill: 'oklch(0.85 0.02 220 / 0.12)' },
] as const;
type LaneKey = (typeof LANES)[number]['key'];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const compact = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.floor(n));
};
const count = (n: number): string => Math.floor(n).toLocaleString('en-GB');
const laneValue = (key: LaneKey, n: number): string => (key === 'requests' ? count(n) : compact(n));

/** "Tuesday 22 September" for a local day key. */
export function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

const set = (node: Element | null, text: string): void => {
  if (node && node.textContent !== text) node.textContent = text;
};

export class WorkReplay {
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private series: DaySeries | null = null;
  private t0 = 0;
  private raf = 0;
  /** The hard stop as a timer too: rAF pauses while the wall is covered, timers only slow. */
  private stopTimer = 0;
  private lastFrame = 0;
  private lastPx = -1;
  private frozenAt: number | null = null;
  private ending = false;
  /** Read once per replay, not on every frame. */
  private reduced = false;
  /** How long this one may stay up. */
  private lengthMs = 0;
  onEnd: (() => void) | null = null;

  constructor() {
    // Lets the render suite hold the replay at a chosen moment and measure it.
    (window as unknown as { __cswTimelapse?: (ms: number | null) => unknown }).__cswTimelapse = (ms) => {
      this.frozenAt = ms;
      if (ms !== null) this.draw(ms, true);
      return this.root ? this.measure() : null;
    };
  }

  get playing(): boolean {
    return this.root !== null;
  }

  play(series: DaySeries): void {
    if (this.root) return;
    this.series = series;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const title = series.today ? 'Today so far' : longDay(series.day);
    const root = this.open(title, replayLength(this.reduced));

    const head = root.querySelector('.replay-head')!;
    const titles = el('div', 'replay-titles');
    titles.append(
      el('div', 'replay-title', title),
      el('div', 'replay-sub', `replayed ${hhmm(series.fromMinute)} to ${series.today ? 'now' : hhmm(series.endMinute)}`),
    );
    const centre = el('div', 'replay-centre');
    centre.append(el('div', 'replay-clock', hhmm(series.fromMinute)), el('div', 'replay-on', ''));
    const stats = el('div', 'replay-stats');
    for (const lane of LANES) {
      const stat = el('div', 'replay-stat');
      stat.dataset.lane = lane.key;
      stat.append(el('span', 'replay-stat-value', '0'), el('span', 'replay-stat-label', lane.key === 'tokens' ? 'processed' : lane.key === 'output' ? 'generated' : 'requests'));
      stats.appendChild(stat);
    }
    head.append(titles, centre, stats);

    const graph = el('div', 'replay-graph');
    const canvas = el('canvas', 'replay-canvas');
    graph.appendChild(canvas);
    for (const lane of LANES) {
      const row = el('div', 'replay-lane');
      row.dataset.lane = lane.key;
      const peak = series.peaks[lane.key];
      row.append(el('span', 'replay-lane-name', lane.name), el('span', 'replay-lane-peak', `peak ${laneValue(lane.key, peak)} / 5 min`));
      graph.appendChild(row);
    }
    graph.appendChild(el('div', 'replay-peak-label', ''));

    const axis = el('div', 'replay-axis');
    root.append(graph, axis);
    if (series.missingRequests > 0) {
      root.append(el('div', 'replay-note',
        `${count(series.missingRequests)} request${series.missingRequests === 1 ? '' : 's'} from archived transcripts ${series.missingRequests === 1 ? 'is' : 'are'} in this day but not in the curve.`));
    }
    root.append(el('div', 'replay-caption',
      this.reduced
        ? 'The whole day at once. Height is the amount in each five minutes, as measured. Click anywhere to close.'
        : 'Each line draws through the day. Height is the amount in each five minutes, as measured. Click anywhere to close.'));

    this.canvas = canvas;
    this.start(root);
  }

  /**
   * A day with nothing to draw, said plainly and briefly: a reconstructed total
   * has no shape, and a read that failed is not an empty day.
   */
  notice(title: string, message: string): void {
    if (this.root) return;
    this.series = null;
    this.reduced = false;
    const root = this.open(title, NOTICE_MS);
    root.classList.add('is-notice');
    root.querySelector('.replay-head')!.append(el('div', 'replay-title', title));
    root.append(el('div', 'replay-message', message), el('div', 'replay-caption', 'Click anywhere to close.'));
    this.canvas = null;
    this.start(root);
  }

  private open(label: string, lengthMs: number): HTMLElement {
    this.ending = false;
    this.frozenAt = null;
    this.lastPx = -1;
    this.lastFrame = 0;
    this.lengthMs = lengthMs;
    const root = el('div', 'replay');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', label);
    root.appendChild(el('div', 'replay-head'));
    root.addEventListener('pointerdown', () => this.stop());
    return root;
  }

  private start(root: HTMLElement): void {
    document.body.appendChild(root);
    this.root = root;
    this.t0 = performance.now();
    this.stopTimer = window.setTimeout(() => {
      if (this.frozenAt === null) this.stop();
    }, this.lengthMs);
    requestAnimationFrame(() => root.classList.add('is-on'));
    if (this.series) {
      this.layoutAxis();
      this.draw(0, true);
    }
    this.loop();
  }

  /** End now, from a click or from the clock. Idempotent. */
  stop(): void {
    if (!this.root || this.ending) return;
    this.ending = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.stopTimer);
    const root = this.root;
    root.classList.remove('is-on');
    window.setTimeout(() => {
      root.remove();
      if (this.root === root) {
        this.root = null;
        this.canvas = null;
        this.series = null;
        this.onEnd?.();
      }
    }, FADE_MS);
  }

  private loop = (): void => {
    if (!this.root || this.ending) return;
    const elapsed = performance.now() - this.t0;
    if (this.frozenAt === null) {
      // Frame cap by performance tier. On the software-rendered tier twelve
      // frames a second is plenty for a line crossing the screen.
      const tier = document.body.dataset.perf;
      const fps = tier === 'low' ? 12 : tier === 'balanced' ? 24 : 30;
      if (this.series && elapsed - this.lastFrame >= 1000 / fps - 1) {
        this.lastFrame = elapsed;
        this.draw(elapsed, false);
      }
      if (elapsed >= this.lengthMs) {
        this.stop();
        return;
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /** x of a minute of the day, inside a graph `w` wide. */
  private xOf(minute: number, w: number): number {
    const s = this.series!;
    return ((minute - s.fromMinute) / Math.max(1e-9, s.toMinute - s.fromMinute)) * w;
  }

  /** Hour ticks under the graph, as DOM so the render suite can measure them. */
  private layoutAxis(): void {
    const s = this.series, root = this.root;
    if (!s || !root) return;
    const axis = root.querySelector<HTMLElement>('.replay-axis')!;
    axis.replaceChildren();
    const w = axis.getBoundingClientRect().width || 1;
    const hours = (s.toMinute - s.fromMinute) / 60;
    // A label needs about 44px; label every hour if there is room, else every 2nd or 3rd.
    const perHour = w / hours;
    const step = [1, 2, 3, 4, 6].find((k) => perHour * k >= 44) ?? 6;
    for (let m = s.fromMinute; m <= s.toMinute; m += 60) {
      const i = (m - s.fromMinute) / 60;
      // Every `step` hours, plus the axis end when it is not crowding the one before.
      const due = i % step === 0 || (m === s.toMinute && perHour * (i % step) >= 44);
      if (!due) continue;
      const tick = el('span', 'replay-tick', hhmm(m));
      const x = this.xOf(m, w);
      tick.style.left = `${x.toFixed(1)}px`;
      // The first and last labels hang inward, so neither runs off the edge.
      tick.style.transform = m === s.fromMinute ? 'none' : m === s.toMinute ? 'translateX(-100%)' : 'translateX(-50%)';
      axis.appendChild(tick);
    }
  }

  private draw(elapsed: number, force: boolean): void {
    const s = this.series, root = this.root, canvas = this.canvas;
    if (!s || !root || !canvas) return;
    const graph = canvas.parentElement!;
    const box = graph.getBoundingClientRect();
    const w = Math.max(1, Math.floor(box.width));
    const h = Math.max(1, Math.floor(box.height));
    const dpr = window.devicePixelRatio || 1;
    let resized = false;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      resized = true;
      this.layoutAxis();
    }

    const f = replayFrame(s, elapsed, this.reduced);
    const px = Math.round(this.xOf(f.minute, w) * dpr);
    if (!force && !resized && px === this.lastPx) return;
    this.lastPx = px;

    this.paintHeader(f);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const playX = this.xOf(f.minute, w);

    // Hour gridlines, faint, the full width from the first frame.
    ctx.strokeStyle = 'oklch(1 0 0 / 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let m = s.fromMinute; m <= s.toMinute; m += 60) {
      const x = Math.round(this.xOf(m, w)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();

    const first = Math.floor(s.fromMinute / BUCKET_MINUTES);
    const last = Math.min(s.tokens.length, Math.ceil(s.toMinute / BUCKET_MINUTES)) - 1;
    const rows = [...graph.querySelectorAll<HTMLElement>('.replay-lane')];
    let peakDot: { x: number; y: number } | null = null;

    LANES.forEach((lane, i) => {
      const row = rows[i];
      if (!row) return;
      const name = row.querySelector<HTMLElement>('.replay-lane-name');
      const top = row.offsetTop + (name ? name.offsetTop + name.offsetHeight + 4 : 0);
      const bottom = row.offsetTop + row.offsetHeight - 1;
      const span = Math.max(1, bottom - top);
      const values = s[lane.key];
      const max = s.peaks[lane.key] || 1;
      const yOf = (v: number) => bottom - (v / max) * span;

      // Baseline.
      ctx.strokeStyle = 'oklch(1 0 0 / 0.1)';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(bottom) + 0.5);
      ctx.lineTo(w, Math.round(bottom) + 0.5);
      ctx.stroke();

      // Everything left of the playhead: the path is the whole day, clipped.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, row.offsetTop, Math.max(0, playX), row.offsetHeight);
      ctx.clip();
      ctx.beginPath();
      for (let b = first; b <= last; b++) {
        const x = this.xOf(b * BUCKET_MINUTES + BUCKET_MINUTES / 2, w);
        if (b === first) ctx.moveTo(x, yOf(values[b]));
        else ctx.lineTo(x, yOf(values[b]));
      }
      ctx.strokeStyle = lane.line;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.lineTo(this.xOf(last * BUCKET_MINUTES + BUCKET_MINUTES / 2, w), bottom);
      ctx.lineTo(this.xOf(first * BUCKET_MINUTES + BUCKET_MINUTES / 2, w), bottom);
      ctx.closePath();
      ctx.fillStyle = lane.fill;
      ctx.fill();
      ctx.restore();

      if (lane.key === 'tokens' && s.peak && f.peakShown) {
        peakDot = { x: this.xOf(s.peak.bucket * BUCKET_MINUTES + BUCKET_MINUTES / 2, w), y: yOf(s.peak.tokens) };
      }
    });

    // The playhead, while it is moving. Reduced motion has none.
    if (!this.reduced && f.t < 1) {
      ctx.strokeStyle = 'oklch(0.97 0.02 200 / 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, h);
      ctx.stroke();
    }

    const label = graph.querySelector<HTMLElement>('.replay-peak-label')!;
    const dot = peakDot as { x: number; y: number } | null;
    if (dot && s.peak) {
      ctx.fillStyle = 'oklch(0.9 0.14 75)';
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, 4, 0, Math.PI * 2);
      ctx.fill();
      const where = s.peak.label ? `, on ${s.peak.label}` : '';
      set(label, `peak ${compact(s.peak.tokens)} in 5 min, ${hhmm(s.peak.bucket * BUCKET_MINUTES)}${where}`);
      label.style.display = 'block';
      // Beside the dot, on whichever side has room, and never outside the graph.
      const lw = label.offsetWidth;
      const right = dot.x + 10 + lw <= w;
      const left = right ? dot.x + 10 : Math.max(0, dot.x - 10 - lw);
      label.style.left = `${Math.min(left, Math.max(0, w - lw)).toFixed(1)}px`;
      label.style.top = `${Math.max(0, dot.y - label.offsetHeight / 2).toFixed(1)}px`;
    } else {
      label.style.display = 'none';
    }
  }

  private paintHeader(f: ReplayFrame): void {
    const root = this.root!;
    set(root.querySelector('.replay-clock'), hhmm(f.minute));
    set(root.querySelector('.replay-on'), f.onProject ? `on ${f.onProject}` : '');
    for (const lane of LANES) {
      set(root.querySelector(`.replay-stat[data-lane="${lane.key}"] .replay-stat-value`), laneValue(lane.key, f.totals[lane.key]));
    }
  }

  private measure() {
    const root = this.root!;
    const r = (sel: string) => root.querySelector(sel)?.getBoundingClientRect().toJSON() ?? null;
    const all = (sel: string) => [...root.querySelectorAll(sel)].map((e) => e.getBoundingClientRect().toJSON());
    const texts = [...root.querySelectorAll<HTMLElement>('*')].filter(
      (e) => e.children.length === 0 && (e.textContent ?? '').trim() && getComputedStyle(e).display !== 'none',
    );
    return {
      root: root.getBoundingClientRect().toJSON(),
      head: r('.replay-head'),
      graph: r('.replay-graph'),
      axis: r('.replay-axis'),
      lanes: all('.replay-lane'),
      ticks: all('.replay-tick'),
      laneNames: all('.replay-lane-name'),
      lanePeaks: all('.replay-lane-peak'),
      peakLabel: getComputedStyle(root.querySelector('.replay-peak-label') ?? root).display === 'none' ? null : r('.replay-peak-label'),
      note: r('.replay-note'),
      caption: r('.replay-caption'),
      message: root.querySelector('.replay-message')?.textContent ?? null,
      smallestPx: Math.min(...texts.map((e) => parseFloat(getComputedStyle(e).fontSize))),
      title: root.querySelector('.replay-title')?.textContent ?? null,
      clock: root.querySelector('.replay-clock')?.textContent ?? null,
      totals: [...root.querySelectorAll('.replay-stat-value')].map((e) => e.textContent),
      on: root.querySelector('.replay-on')?.textContent ?? null,
    };
  }
}
