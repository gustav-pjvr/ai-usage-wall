/**
 * The work time-lapse overlay: today so far, in about twenty seconds, played
 * only when the "Replay today" button is pressed.
 *
 * WHY IT CANNOT TRAP ANYONE (rule 17)
 *
 * - It is driven by elapsed wall-clock time (src/shared/timelapse.ts), so a
 *   slow or throttled frame skips ahead rather than stretching the replay.
 * - A hard stop at the end of the replay plus a short hold, whatever happens.
 * - Any click anywhere on it ends it at once.
 * - It never takes keyboard focus, so it never needs a key to escape.
 *
 * The stars sit where the constellation would put today's projects, laid out
 * ONCE from the day's final totals, so nothing jumps around mid-replay: each
 * star grows as its tokens accumulate and lights when its first hour arrives.
 */

import { layoutConstellation, type Layout } from '../shared/constellation';
import { roundRect } from './constellation';
import { buildWorkDay, hh, replayState, REPLAY_MS, type WorkDay } from '../shared/timelapse';

const HOLD_MS = 2_500;
const FADE_MS = 450;

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
  return String(Math.round(n));
};

const clockText = (h: number): string => {
  const hour = Math.floor(h);
  const min = Math.min(59, Math.floor((h - hour) * 60));
  return `${String(hour % 24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};

export { buildWorkDay };

export class WorkReplay {
  private root: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private day: WorkDay | null = null;
  private layout: Layout | null = null;
  private t0 = 0;
  private raf = 0;
  private lastFrame = 0;
  private frozenAt: number | null = null;
  private ending = false;
  /** Read once per replay, not on every frame. */
  private reduced = false;
  onEnd: (() => void) | null = null;

  constructor() {
    // Lets the render suite hold the replay at a chosen moment and measure it.
    (window as unknown as { __cswTimelapse?: (ms: number | null) => unknown }).__cswTimelapse = (ms) => {
      this.frozenAt = ms;
      if (ms !== null) this.draw(ms);
      return this.root ? this.measure() : null;
    };
  }

  get playing(): boolean {
    return this.root !== null;
  }

  play(day: WorkDay): void {
    if (this.root) return;
    this.day = day;
    this.ending = false;
    this.frozenAt = null;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const root = el('div', 'replay');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Today so far');
    const head = el('div', 'replay-head');
    head.append(
      el('div', 'replay-title', 'Today so far'),
      el('div', 'replay-clock', clockText(day.fromHour)),
      el('div', 'replay-total', '0'),
    );
    const sky = el('div', 'replay-sky');
    const canvas = el('canvas', 'replay-canvas');
    sky.appendChild(canvas);
    const trace = el('div', 'replay-trace');
    for (let h = day.fromHour; h <= day.toHour; h++) {
      const col = el('div', 'replay-col');
      col.appendChild(el('div', 'replay-bar'));
      col.appendChild(el('div', 'replay-tick', h % 3 === 0 || h === day.fromHour || h === day.toHour ? hh(h).slice(0, 2) : ''));
      trace.appendChild(col);
    }
    const now = new Date(day.asOf);
    const caption = el(
      'div',
      'replay-caption',
      `${hh(day.fromHour)} to ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} local  ·  tokens per project per hour, as measured  ·  click anywhere to close`,
    );
    root.append(head, sky, trace, caption);
    root.addEventListener('pointerdown', () => this.stop());
    document.body.appendChild(root);

    this.root = root;
    this.canvas = canvas;
    this.layout = null;
    this.t0 = performance.now();
    requestAnimationFrame(() => root.classList.add('is-on'));
    this.loop();
  }

  /** End now, from a click or from the clock. Idempotent. */
  stop(): void {
    if (!this.root || this.ending) return;
    this.ending = true;
    cancelAnimationFrame(this.raf);
    const root = this.root;
    root.classList.remove('is-on');
    window.setTimeout(() => {
      root.remove();
      if (this.root === root) {
        this.root = null;
        this.canvas = null;
        this.day = null;
        this.onEnd?.();
      }
    }, FADE_MS);
  }

  private loop = (): void => {
    if (!this.root || this.ending) return;
    const elapsed = performance.now() - this.t0;
    if (this.frozenAt === null) {
      // Frame cap by performance tier. On the software-rendered tier twelve
      // frames a second is plenty for a replay and keeps the paint affordable.
      const tier = document.body.dataset.perf;
      const fps = tier === 'low' ? 12 : tier === 'balanced' ? 24 : 30;
      if (elapsed - this.lastFrame >= 1000 / fps - 1) {
        this.lastFrame = elapsed;
        this.draw(elapsed);
      }
      if (elapsed >= REPLAY_MS + HOLD_MS) {
        this.stop();
        return;
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private draw(elapsed: number): void {
    const day = this.day, root = this.root, canvas = this.canvas;
    if (!day || !root || !canvas) return;
    const f = replayState(day, elapsed, REPLAY_MS, this.reduced ? 4 : 0);

    root.querySelector('.replay-clock')!.textContent = clockText(Math.min(f.clock, day.endAt));
    root.querySelector('.replay-total')!.textContent = `${compact(f.total)} tokens`;

    const cols = root.querySelectorAll<HTMLElement>('.replay-bar');
    const peak = Math.max(1, ...day.tokens.map((m) => Object.values(m).reduce((a, b) => a + b, 0)));
    cols.forEach((bar, i) => {
      const h = day.fromHour + i;
      bar.style.transform = `scaleY(${(f.byHour[h] / peak).toFixed(4)})`;
    });

    const box = canvas.parentElement!.getBoundingClientRect();
    const w = Math.max(1, Math.floor(box.width));
    const hgt = Math.max(1, Math.floor(box.height));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hgt}px`;
      this.layout = null;
    }
    // Laid out once, from the day's final totals, so stars never move.
    if (!this.layout) {
      this.layout = layoutConstellation({
        stars: day.projects.map((p) => ({ key: p.key, label: p.label, total: p.total, output: 0, requests: 0, lastSeen: new Date(day.asOf).toISOString() })),
        links: [],
        activeLabel: null,
        now: day.asOf,
        width: w,
        height: hgt,
      });
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const fontPx = Math.max(10, Math.min(14, Math.round(Math.min(w, hgt) * 0.03)));
    ctx.font = `500 ${fontPx}px ui-monospace, 'Cascadia Code', Consolas, monospace`;
    ctx.textBaseline = 'top';
    for (const s of this.layout.stars) {
      const have = f.perProject[s.key] || 0;
      if (have <= 0) continue;
      // Grows with the day's accumulated share, never past its final size.
      const grow = 0.35 + 0.65 * Math.min(1, have / Math.max(1, s.total));
      const size = s.size * grow;
      const r = Math.max(2, size * 0.24);
      ctx.fillStyle = `oklch(0.75 0.14 ${s.hue.toFixed(0)} / 0.18)`;
      roundRect(ctx, s.x - size * 0.85, s.y - size * 0.85, size * 1.7, size * 1.7, r * 1.7);
      ctx.fill();
      ctx.fillStyle = `oklch(0.8 0.14 ${s.hue.toFixed(0)})`;
      roundRect(ctx, s.x - size / 2, s.y - size / 2, size, size, r);
      ctx.fill();
      const label = s.label;
      const lw = ctx.measureText(label).width;
      const lx = Math.max(0, Math.min(s.x - lw / 2, w - lw));
      if (s.y + s.size / 2 + 3 + fontPx * 1.25 <= hgt) {
        ctx.fillStyle = 'oklch(0.92 0.02 220 / 0.9)';
        ctx.fillText(label, lx, s.y + s.size / 2 + 3);
      }
    }
  }

  private measure() {
    const r = (sel: string) => this.root!.querySelector(sel)?.getBoundingClientRect().toJSON() ?? null;
    return {
      root: this.root!.getBoundingClientRect().toJSON(),
      head: r('.replay-head'),
      trace: r('.replay-trace'),
      caption: r('.replay-caption'),
      captionPx: parseFloat(getComputedStyle(this.root!.querySelector('.replay-caption')!).fontSize),
      cols: this.root!.querySelectorAll('.replay-col').length,
      total: this.root!.querySelector('.replay-total')!.textContent,
      clock: this.root!.querySelector('.replay-clock')!.textContent,
      stars: this.layout?.stars.length ?? 0,
    };
  }
}
