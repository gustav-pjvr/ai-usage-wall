/**
 * The constellation panel: the project sky drawn into the top row's big panel,
 * in place of the live throughput trace, which stays one click away.
 *
 * Layout is src/shared/constellation.ts, pure and tested. This file only
 * draws it, and draws it as little as possible: the canvas is repainted when
 * the data or the panel size changes, never on a timer. GPU compositing is not
 * available on Gustav's laptop, so a loop here would be paid for in software on
 * every frame. The one moving thing, the pulse on the active project, is a
 * single DOM element animating opacity and transform, and it stops under
 * reduced motion and on the low performance tier.
 */

import {
  ACTIVE_WINDOW_MS,
  brightnessOf,
  bucketOf,
  buildLinks,
  maxStarsFor,
  hitTest,
  layoutConstellation,
  placeLabels,
  type Layout,
  type Link,
  type StarInput,
} from '../shared/constellation';
import { labelProjects } from '../shared/project-label';
import { localDayKey } from '../shared/day';

export interface TipHost {
  showAt(x: number, y: number, title: string, rows: [string, string][]): void;
  hide(): void;
}

interface Source {
  projects: Record<string, { input: number; output: number; cacheCreate: number; cacheRead: number; requests: number; lastSeen: string; display: string }>;
  sessions: Record<string, { start?: string; end?: string; cwd?: string | null }>;
  latest: { ts: string | null; cwd?: string | null; project?: string | null };
  projectLinks?: Link[];
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const compact = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};

export class ConstellationPanel {
  readonly node: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly pulse: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly empty: HTMLElement;
  private stars: StarInput[] = [];
  private links: Link[] = [];
  private activeLabel: string | null = null;
  private layout: Layout | null = null;
  private labels: ReturnType<typeof placeLabels> = [];
  private shown = false;
  private dirty = true;
  private lastPaintMs = 0;
  private raf = 0;
  private emptyText = '';
  /**
   * What the sky would look like, reduced to the things that change a pixel:
   * each star's label, size bucket and brightness step, the links and the
   * active star. A usage push arrives every few seconds during a session and
   * almost never changes any of these, and repainting anyway broke the rule
   * this panel exists under: repaint on change, never on a timer.
   */
  private signature = '';

  constructor(private readonly tip: TipHost) {
    this.node = el('div', 'const-wrap');
    this.canvas = el('canvas', 'const-canvas');
    this.pulse = el('div', 'const-pulse');
    this.pulse.hidden = true;
    this.empty = el('div', 'const-empty');
    this.empty.hidden = true;
    this.caption = el(
      'div',
      'const-caption',
      'Size: tokens, log scale  ·  brightness: last used, halves weekly  ·  linked when worked on the same day',
    );
    const sky = el('div', 'const-sky');
    sky.append(this.canvas, this.pulse, this.empty);
    this.node.append(sky, this.caption);

    new ResizeObserver(() => {
      this.dirty = true;
      this.schedule();
    }).observe(sky);

    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => this.tip.hide());

    // The render suite reads the real layout rather than guessing it.
    (window as unknown as { __cswConstellation?: () => unknown }).__cswConstellation = () => ({
      layout: this.layout,
      labels: this.labels,
      paintMs: this.lastPaintMs,
      canvas: this.canvas.getBoundingClientRect().toJSON(),
    });
  }

  /**
   * New data. `onScreen` means these numbers came from a paired machine: the
   * project names are already labels, and links arrive ready made because the
   * sessions a screen receives carry no working directory.
   */
  update(idx: Source, onScreen: boolean, now = Date.now()): void {
    const entries = Object.entries(idx.projects ?? {});
    const paths = entries.map(([key, v]) => v.display || key);
    const labels = onScreen ? new Map(paths.map((p) => [p, p])) : labelProjects(paths);
    const labelOfKey = new Map(entries.map(([key], i) => [key, labels.get(paths[i]) ?? paths[i]]));

    this.stars = entries.map(([key, v], i) => ({
      key,
      label: labels.get(paths[i]) ?? paths[i],
      total: (v.input || 0) + (v.output || 0) + (v.cacheCreate || 0) + (v.cacheRead || 0),
      output: v.output || 0,
      requests: v.requests || 0,
      lastSeen: v.lastSeen || '',
    }));

    this.links = onScreen
      ? idx.projectLinks ?? []
      : buildLinks(Object.values(idx.sessions ?? {}), (cwd) => labelOfKey.get(cwd.toLowerCase()) ?? null);

    const latestMs = idx.latest?.ts ? Date.parse(idx.latest.ts) : NaN;
    const fresh = Number.isFinite(latestMs) && now - latestMs < ACTIVE_WINDOW_MS;
    if (!fresh) this.activeLabel = null;
    else if (onScreen) this.activeLabel = idx.latest.project ?? null;
    else this.activeLabel = idx.latest.cwd ? labelOfKey.get(idx.latest.cwd.toLowerCase()) ?? null : null;

    this.emptyText = this.stars.some((s) => s.total > 0)
      ? ''
      : onScreen
        ? 'The paired machine is not sharing project names'
        : 'No projects yet';

    const signature = JSON.stringify([
      this.stars.map((s) => [s.label, bucketOf(s.total), Math.round(brightnessOf(s.lastSeen, now) * 40)]),
      this.links,
      this.activeLabel,
      this.emptyText,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.dirty = true;
    this.schedule();
  }

  setShown(v: boolean): void {
    this.shown = v;
    if (!v) this.tip.hide();
    this.schedule();
  }

  private schedule(): void {
    if (!this.shown || !this.dirty || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  private paint(): void {
    const t0 = performance.now();
    this.dirty = false;
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const w = Math.max(1, Math.floor(box.width));
    const h = Math.max(1, Math.floor(box.height));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    this.empty.hidden = !this.emptyText;
    this.empty.textContent = this.emptyText;

    const layout = layoutConstellation({
      stars: this.stars,
      links: this.links,
      activeLabel: this.activeLabel,
      now: Date.now(),
      width: w,
      height: h,
    });
    this.layout = layout;

    // Links first, so stars sit on top of them.
    for (const l of layout.links) {
      const a = layout.stars[l.a];
      const b = layout.stars[l.b];
      ctx.strokeStyle = `oklch(0.78 0.08 200 / ${(0.08 + l.w * 0.05).toFixed(2)})`;
      ctx.lineWidth = 0.6 + l.w * 0.3;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const s of layout.stars) {
      const half = s.size / 2;
      const r = Math.max(2, s.size * 0.24);
      // A soft halo as a larger translucent square: shadowBlur is very slow in
      // software rendering, and this costs one extra fill.
      ctx.fillStyle = `oklch(0.75 0.14 ${s.hue.toFixed(0)} / ${(s.brightness * 0.16).toFixed(3)})`;
      roundRect(ctx, s.x - half * 1.7, s.y - half * 1.7, s.size * 1.7, s.size * 1.7, r * 1.7);
      ctx.fill();
      ctx.fillStyle = `oklch(${(0.45 + s.brightness * 0.35).toFixed(3)} 0.14 ${s.hue.toFixed(0)} / ${(0.35 + s.brightness * 0.65).toFixed(3)})`;
      roundRect(ctx, s.x - half, s.y - half, s.size, s.size, r);
      ctx.fill();
    }

    // In step with the rest of the dashboard's label tier: 9 to 12px.
    const fontPx = Math.max(9, Math.min(12, Math.round(Math.min(w, h) * 0.036)));
    ctx.font = `500 ${fontPx}px ui-monospace, 'Cascadia Code', Consolas, monospace`;
    ctx.textBaseline = 'top';
    // Every star is offered a label; placeLabels drops any that would collide.
    // The budget scales with the panel, like the star cap does, and when a
    // "+N more" note is needed its corner is kept clear of labels.
    const budget = Math.max(6, Math.ceil(maxStarsFor(w, h) * 0.7));
    const reserve = layout.more > 0 ? fontPx + 8 : 0;
    this.labels = placeLabels({ ...layout, height: h - reserve }, (t) => ctx.measureText(t).width, fontPx, budget);
    for (const p of this.labels) {
      const s = layout.stars[p.star];
      ctx.fillStyle = `oklch(0.9 0.02 220 / ${(0.45 + s.brightness * 0.55).toFixed(3)})`;
      ctx.fillText(s.label, p.x, p.y);
    }

    if (layout.more > 0) {
      ctx.fillStyle = 'oklch(0.6 0.015 235 / 0.8)';
      const text = `+${layout.more} more`;
      ctx.fillText(text, w - ctx.measureText(text).width - 4, h - fontPx - 4);
    }

    const active = layout.stars.find((s) => s.active);
    this.pulse.hidden = !active;
    if (active) {
      const size = active.size * 2.2;
      this.pulse.style.width = `${size}px`;
      this.pulse.style.height = `${size}px`;
      this.pulse.style.left = `${active.x - size / 2}px`;
      this.pulse.style.top = `${active.y - size / 2}px`;
      this.pulse.style.setProperty('--hue', active.hue.toFixed(0));
    }
    this.lastPaintMs = Math.round((performance.now() - t0) * 10) / 10;
  }

  private hover(e: PointerEvent): void {
    if (!this.layout) return;
    const r = this.canvas.getBoundingClientRect();
    const s = hitTest(this.layout, e.clientX - r.left, e.clientY - r.top);
    if (!s) {
      this.tip.hide();
      return;
    }
    // The local day, not the UTC date in the ISO string: a project last used at
    // 00:30 here must not say yesterday (rule 38).
    const seen = s.lastSeen && Number.isFinite(Date.parse(s.lastSeen)) ? localDayKey(s.lastSeen) : 'unknown';
    this.tip.showAt(r.left + s.x, r.top + s.y - s.size / 2, s.label, [
      ['total', compact(s.total)],
      ['generated', compact(s.output)],
      ['requests', s.requests.toLocaleString()],
      ['last used', seen],
    ]);
  }
}

/** A rounded square path. Shared with the replay so its stars are the same shape. */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
