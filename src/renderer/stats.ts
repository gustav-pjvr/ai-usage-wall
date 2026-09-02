/**
 * Claude Stats: a live command centre for local Claude Code usage.
 *
 * PROVENANCE IS PART OF THE DESIGN. Every panel is tagged either
 *   MEASURED  read directly out of the transcripts, no interpretation
 *   DERIVED   computed from measured values, with the method stated
 * and anything that cannot be known is stated as unavailable rather than
 * filled with a plausible number. See src/main/data/usage.ts for what was
 * ruled out and why (quota, plan limits and cost are all unobtainable here).
 *
 * MOTION BUDGET. This runs on a wall that is up 24/7, so the animation loop
 * only turns while the stats view is actually on screen, and it throttles hard
 * when Claude has been idle. Chromium already stops painting the window when
 * other apps cover it, so a covered wall costs nothing at all.
 */

import type { UsageIndex, TokenTotals } from '../main/data/usage';

// ── Formatting ─────────────────────────────────────────────────────────────

/** Compact token counts: 25.3B, 663M, 53.7M, 4,422. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(a >= 1e13 ? 1 : 2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString('en-US');
}

const full = (n: number) => n.toLocaleString('en-US');

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

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

const totalOf = (t: TokenTotals) => t.input + t.output + t.cacheCreate + t.cacheRead;

// ── Derived metrics, each with its method stated ───────────────────────────

export interface Derived {
  /** Tokens per minute over the trailing window, from record timestamps. */
  velocity: number;
  /** Share of context tokens served from cache rather than re-sent. */
  cacheHitRate: number;
  /** Mean total tokens per assistant request. */
  tokensPerRequest: number;
  /** Sum of within-session gaps under the idle threshold, in hours. */
  activeHours: number;
  /** Milliseconds since the most recent record. */
  sinceLast: number;
  /** 0..1 activity level driving the visual intensity. */
  intensity: number;
  todayTotals: TokenTotals | null;
  weekTotals: TokenTotals;
}

/** Gaps longer than this inside a session are treated as "away", not work. */
const IDLE_GAP_MS = 5 * 60 * 1000;
const VELOCITY_WINDOW_MS = 10 * 60 * 1000;

export function derive(idx: UsageIndex): Derived {
  const now = Date.now();

  let windowTokens = 0;
  let earliest = now;
  for (const [ts, total] of idx.recent) {
    if (now - ts <= VELOCITY_WINDOW_MS) {
      windowTokens += total;
      if (ts < earliest) earliest = ts;
    }
  }
  const spanMin = Math.max(1, (now - earliest) / 60000);
  const velocity = windowTokens > 0 ? windowTokens / spanMin : 0;

  const t = idx.totals;
  const contextTokens = t.cacheRead + t.cacheCreate + t.input;
  const cacheHitRate = contextTokens > 0 ? t.cacheRead / contextTokens : 0;
  const tokensPerRequest = t.requests > 0 ? totalOf(t) / t.requests : 0;

  // Active time: sum each session's span, minus any gap we cannot observe.
  // Records only exist per assistant reply, so this is a lower bound on time
  // spent, not a stopwatch. Stated as approximate in the UI for that reason.
  let activeMs = 0;
  for (const s of Object.values(idx.sessions)) {
    const a = Date.parse(s.start);
    const b = Date.parse(s.end);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      activeMs += Math.min(b - a, s.requests * IDLE_GAP_MS);
    }
  }

  const lastTs = idx.latest.ts ? Date.parse(idx.latest.ts) : NaN;
  const sinceLast = Number.isFinite(lastTs) ? now - lastTs : Infinity;

  // Intensity ramps with velocity and decays once Claude goes quiet.
  const vNorm = Math.min(1, velocity / 400_000);
  const recency = sinceLast < 60_000 ? 1 : sinceLast < 15 * 60_000 ? 0.55 : sinceLast < 60 * 60_000 ? 0.22 : 0.06;
  const intensity = Math.max(0.06, Math.min(1, vNorm * 0.65 + recency * 0.5));

  const todayKey = new Date().toISOString().slice(0, 10);
  const todayTotals = idx.daily[todayKey] ?? null;

  const weekTotals: TokenTotals = {
    input: 0, output: 0, cacheCreate: 0, cacheRead: 0,
    thinking: 0, requests: 0, webSearch: 0, webFetch: 0,
  };
  for (let i = 0; i < 7; i++) {
    const key = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const d = idx.daily[key];
    if (!d) continue;
    weekTotals.input += d.input;
    weekTotals.output += d.output;
    weekTotals.cacheCreate += d.cacheCreate;
    weekTotals.cacheRead += d.cacheRead;
    weekTotals.thinking += d.thinking;
    weekTotals.requests += d.requests;
  }

  return { velocity, cacheHitRate, tokensPerRequest, activeHours: activeMs / 3_600_000, sinceLast, intensity, todayTotals, weekTotals };
}

// ── Building blocks ────────────────────────────────────────────────────────

type Tag = 'measured' | 'derived' | 'unavailable';

function panel(title: string, tag: Tag, extraClass = ''): HTMLElement {
  const p = el('section', `panel ${extraClass}`.trim());
  const head = el('header', 'panel-head');
  head.appendChild(el('h2', 'panel-title', title));
  head.appendChild(el('span', `tag tag-${tag}`, tag === 'measured' ? 'MEASURED' : tag === 'derived' ? 'DERIVED' : 'N/A'));
  p.appendChild(head);
  return p;
}

/**
 * A number that animates to its value and keeps its own display state, so an
 * update tweens from the old figure rather than snapping.
 */
class Odometer {
  readonly node: HTMLElement;
  private current = 0;
  private target = 0;
  private raf = 0;
  constructor(className: string, private readonly format: (n: number) => string) {
    this.node = el('span', className, format(0));
  }
  set(value: number, animate = true): void {
    this.target = value;
    if (!animate || Math.abs(value - this.current) < 1) {
      this.current = value;
      this.node.textContent = this.format(value);
      return;
    }
    if (this.raf) return;
    const from = this.current;
    const start = performance.now();
    const dur = 900;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      // Quart-out, the same curve the client wall uses for reveals.
      const eased = 1 - Math.pow(1 - k, 4);
      this.current = from + (this.target - from) * eased;
      this.node.textContent = this.format(this.current);
      if (k < 1) this.raf = requestAnimationFrame(tick);
      else {
        this.raf = 0;
        this.current = this.target;
        this.node.textContent = this.format(this.target);
      }
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

function statTile(label: string, hint?: string): { root: HTMLElement; odo: Odometer } {
  const root = el('div', 'stat');
  const odo = new Odometer('stat-value', compact);
  root.appendChild(odo.node);
  root.appendChild(el('div', 'stat-label', label));
  if (hint) root.appendChild(el('div', 'stat-hint', hint));
  return { root, odo };
}

/** Horizontal proportion bar with a legend, used for models and projects. */
function breakdown(
  rows: { label: string; value: number; sub?: string; tip?: [string, string][] }[],
  max = 6,
  tip?: Tooltip,
): HTMLElement {
  const wrap = el('div', 'breakdown');
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const shown = rows.slice(0, max);
  for (const [i, r] of shown.entries()) {
    const line = el('div', 'bd-row');
    const head = el('div', 'bd-head');
    head.appendChild(el('span', 'bd-label', r.label));
    head.appendChild(el('span', 'bd-value', compact(r.value)));
    line.appendChild(head);
    const track = el('div', 'bd-track');
    const fill = el('div', 'bd-fill');
    fill.style.setProperty('--w', `${((r.value / total) * 100).toFixed(2)}%`);
    fill.style.setProperty('--i', String(i));
    fill.style.setProperty('--hue', String(190 + i * 26));
    track.appendChild(fill);
    line.appendChild(track);
    if (r.sub) line.appendChild(el('div', 'bd-sub', r.sub));
    if (tip && r.tip) tip.attach(line, r.label, r.tip);
    wrap.appendChild(line);
  }
  return wrap;
}

/** Column chart for a dated series. Bars carry their own reveal delay. */
function columns(
  series: { key: string; value: number; label: string; tip?: [string, string][] }[],
  tip?: Tooltip,
): HTMLElement {
  const wrap = el('div', 'cols');
  const max = Math.max(1, ...series.map((s) => s.value));
  for (const [i, s] of series.entries()) {
    const col = el('div', 'col');
    if (tip && s.tip) tip.attach(col, s.label, s.tip);
    const bar = el('div', 'col-bar');
    bar.style.setProperty('--h', `${Math.max(1.5, (s.value / max) * 100).toFixed(2)}%`);
    bar.style.setProperty('--i', String(i));
    col.appendChild(bar);
    wrap.appendChild(col);
  }
  return wrap;
}

/**
 * One tooltip for the whole view, moved and refilled on hover.
 *
 * Native `title` attributes were being used before: they take about a second to
 * appear, cannot be styled, and look nothing like the rest of the surface.
 */
class Tooltip {
  readonly node: HTMLElement;
  constructor() {
    this.node = el('div', 'tip');
    this.node.setAttribute('role', 'tooltip');
  }

  attach(target: HTMLElement, title: string, rows: [string, string][]): void {
    const show = () => {
      this.node.replaceChildren();
      this.node.appendChild(el('div', 'tip-title', title));
      for (const [k, v] of rows) {
        const r = el('div', 'tip-row');
        r.appendChild(el('span', 'tip-k', k));
        r.appendChild(el('span', 'tip-v', v));
        this.node.appendChild(r);
      }
      this.node.classList.add('is-on');
      this.position(target);
    };
    target.addEventListener('pointerenter', show);
    target.addEventListener('pointermove', () => this.position(target));
    target.addEventListener('pointerleave', () => this.node.classList.remove('is-on'));
  }

  /** Above the target, clamped inside the viewport so it never runs off-screen. */
  private position(target: HTMLElement): void {
    const r = target.getBoundingClientRect();
    const t = this.node.getBoundingClientRect();
    const margin = 8;
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));
    let top = r.top - t.height - 10;
    if (top < margin) top = r.bottom + 10;
    this.node.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }
}

// ── The live activity canvas ───────────────────────────────────────────────

/**
 * Scrolling trace of the last 20 minutes of real token throughput.
 *
 * Every column is a genuine time bucket from the record ring, not decoration.
 * When nothing has happened the trace flattens to a slow baseline pulse, which
 * is both honest and the reason an idle wall costs almost no CPU.
 */
class ActivityCanvas {
  readonly node: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private raf = 0;
  private phase = 0;
  private buckets: number[] = [];
  private peak = 1;
  private intensity = 0.1;
  private lastDraw = 0;
  private fpsCap = 30;

  constructor() {
    this.node = el('canvas', 'activity-canvas');
    this.ctx = this.node.getContext('2d');
  }

  setPerfTier(tier: string): void {
    // Software rendering repaints the whole surface, so cap it hard there.
    this.fpsCap = tier === 'low' ? 12 : tier === 'balanced' ? 24 : 30;
  }

  update(idx: UsageIndex, intensity: number): void {
    const now = Date.now();
    const WINDOW = 20 * 60 * 1000;
    const N = 150;
    const buckets = new Array<number>(N).fill(0);
    for (const [ts, total] of idx.recent) {
      const age = now - ts;
      if (age < 0 || age > WINDOW) continue;
      const i = N - 1 - Math.floor((age / WINDOW) * N);
      if (i >= 0 && i < N) buckets[i] += total;
    }
    this.buckets = buckets;
    this.peak = Math.max(1, ...buckets);
    this.intensity = intensity;
  }

  start(): void {
    if (this.raf) return;
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const minGap = 1000 / this.fpsCap;
      if (t - this.lastDraw < minGap) return;
      this.lastDraw = t;
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.node.clientWidth;
    const h = this.node.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.node.width !== Math.round(w * dpr) || this.node.height !== Math.round(h * dpr)) {
      this.node.width = Math.round(w * dpr);
      this.node.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Idle traces breathe slowly; busy ones move.
    this.phase += 0.006 + this.intensity * 0.03;

    const n = this.buckets.length || 1;
    const colW = w / n;
    const baseline = h * 0.94;
    const alpha = 0.25 + this.intensity * 0.6;

    // Baseline rule
    ctx.strokeStyle = `rgba(120, 200, 220, ${0.10 + this.intensity * 0.12})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseline);
    ctx.lineTo(w, baseline);
    ctx.stroke();

    /*
     * Columns. A bucket with no tokens draws NOTHING.
     *
     * This used to add a small animated ripple to empty buckets so the trace
     * would not look dead. That was decoration shaped exactly like data: a
     * quiet stretch read as light activity when the truth was none. The chart
     * gets its life from the sweep and the leading edge instead, both of which
     * are obviously not measurements.
     */
    for (let i = 0; i < n; i++) {
      const raw = this.buckets[i];
      if (raw <= 0) continue;
      const v = raw / this.peak;
      const barH = Math.pow(v, 0.55) * (h * 0.82);
      const x = i * colW;
      const y = baseline - barH;
      const hue = 186 + Math.min(60, v * 70);
      const g = ctx.createLinearGradient(0, y, 0, baseline);
      g.addColorStop(0, `hsla(${hue}, 85%, 62%, ${alpha})`);
      g.addColorStop(1, `hsla(${hue + 20}, 80%, 45%, ${alpha * 0.15})`);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, Math.max(1, colW - 1.2), Math.max(1, barH));
    }

    // A slow sweep along the baseline, so an idle chart is alive without
    // pretending anything happened.
    const sweepX = ((this.phase * 26) % (w + 160)) - 80;
    const sweep = ctx.createLinearGradient(sweepX - 70, 0, sweepX + 70, 0);
    sweep.addColorStop(0, 'hsla(186, 90%, 65%, 0)');
    sweep.addColorStop(0.5, `hsla(186, 90%, 65%, ${0.1 + this.intensity * 0.14})`);
    sweep.addColorStop(1, 'hsla(186, 90%, 65%, 0)');
    ctx.fillStyle = sweep;
    ctx.fillRect(sweepX - 70, baseline - 2, 140, 3);

    // Leading edge marker: where "now" is.
    const pulse = 0.4 + 0.6 * (Math.sin(this.phase * 3) * 0.5 + 0.5);
    ctx.fillStyle = `hsla(186, 95%, 70%, ${0.5 * pulse * (0.4 + this.intensity)})`;
    ctx.fillRect(w - 2, h * 0.12, 2, baseline - h * 0.12);
  }
}

// ── The view ───────────────────────────────────────────────────────────────

export class StatsView {
  readonly root: HTMLElement;
  private canvas = new ActivityCanvas();
  private tip = new Tooltip();
  private odos: Record<string, Odometer> = {};
  private mounted = false;
  private visible = false;
  private idx: UsageIndex | null = null;
  private lastRenderKey = '';
  private clockTimer = 0;

  constructor() {
    this.root = el('div', 'stats');
    this.build();
  }

  private build(): void {
    const grid = el('div', 'stats-grid');

    // Hero: total tokens processed.
    const hero = panel('Total tokens processed', 'measured', 'panel-hero');
    const heroBody = el('div', 'hero-body');
    this.odos.total = new Odometer('hero-value', compact);
    heroBody.appendChild(this.odos.total.node);
    const heroMeta = el('div', 'hero-meta');
    heroMeta.appendChild(el('span', 'hero-exact', ''));
    heroMeta.appendChild(el('span', 'hero-sub', 'every session on this machine'));
    heroBody.appendChild(heroMeta);

    /*
     * Composition strip.
     *
     * Roughly 97% of that headline is cache READS, the same context re-read on
     * every turn, and only a fraction of a percent is text Claude actually
     * generated. The total is real, but on its own it reads as consumption.
     * Showing what it is made of is the difference between a true number and an
     * honest one.
     */
    const comp = el('div', 'hero-comp');
    const compBar = el('div', 'comp-bar');
    for (const part of ['cacheRead', 'cacheCreate', 'output', 'input']) {
      const seg = el('div', `comp-seg comp-${part}`);
      compBar.appendChild(seg);
    }
    comp.appendChild(compBar);
    comp.appendChild(el('div', 'comp-legend'));
    heroBody.appendChild(comp);
    hero.appendChild(heroBody);
    grid.appendChild(hero);

    // Live activity.
    const live = panel('Live throughput', 'measured', 'panel-live');
    const liveWrap = el('div', 'live-wrap');
    liveWrap.appendChild(this.canvas.node);
    const liveFoot = el('div', 'live-foot');
    liveFoot.appendChild(el('span', 'live-scale', 'last 20 minutes'));
    liveFoot.appendChild(el('span', 'live-state', ''));
    liveWrap.appendChild(liveFoot);
    liveWrap.appendChild(
      el('div', 'live-explain', 'each column is 8 seconds of token throughput, newest on the right'),
    );
    live.appendChild(liveWrap);
    grid.appendChild(live);

    // Velocity + today.
    const vel = panel('Velocity', 'derived', 'panel-vel');
    const velBody = el('div', 'vel-body');
    this.odos.velocity = new Odometer('vel-value', (n) => compact(Math.round(n)));
    velBody.appendChild(this.odos.velocity.node);
    velBody.appendChild(el('div', 'vel-unit', 'tokens / min'));
    velBody.appendChild(el('div', 'vel-note', 'trailing 10 minutes of record timestamps'));
    vel.appendChild(velBody);
    grid.appendChild(vel);

    // Counters.
    const counters = panel('Totals', 'measured', 'panel-counters');
    const cg = el('div', 'counter-grid');
    for (const [key, label, hint] of [
      ['requests', 'Requests', 'assistant replies'],
      ['sessions', 'Sessions', 'distinct transcripts'],
      ['prompts', 'Prompts sent', ''],
      ['days', 'Days active', ''],
      ['output', 'Generated', ''],
      ['thinking', 'Thinking', ''],
    ] as const) {
      const tile = statTile(label, hint);
      this.odos[key] = tile.odo;
      cg.appendChild(tile.root);
    }
    counters.appendChild(cg);
    grid.appendChild(counters);

    // Daily history.
    const daily = panel('Daily activity', 'measured', 'panel-daily');
    daily.appendChild(el('div', 'chart-slot chart-daily'));
    daily.appendChild(el('div', 'chart-legend chart-daily-legend'));
    grid.appendChild(daily);

    // Efficiency.
    const eff = panel('Context efficiency', 'derived', 'panel-eff');
    const effBody = el('div', 'eff-body');
    this.odos.cache = new Odometer('eff-value', (n) => `${n.toFixed(1)}%`);
    effBody.appendChild(this.odos.cache.node);
    effBody.appendChild(el('div', 'eff-label', 'of context served from cache'));
    const effBar = el('div', 'eff-track');
    const effFill = el('div', 'eff-fill');
    effBar.appendChild(effFill);
    effBody.appendChild(effBar);
    effBody.appendChild(el('div', 'eff-note', 'cache reads / (cache reads + cache writes + fresh input)'));
    eff.appendChild(effBody);
    grid.appendChild(eff);

    // Models.
    const models = panel('Models', 'measured', 'panel-models');
    models.appendChild(el('div', 'chart-slot chart-models'));
    grid.appendChild(models);

    // Hour of day.
    const hours = panel('When you work', 'measured', 'panel-hours');
    hours.appendChild(el('div', 'chart-slot chart-hours'));
    hours.appendChild(el('div', 'hour-axis'));
    hours.appendChild(
      el('div', 'chart-legend', 'token throughput by hour of day, pooled across the last 14 days'),
    );
    grid.appendChild(hours);

    // Projects.
    const projects = panel('Top projects', 'measured', 'panel-projects');
    projects.appendChild(el('div', 'chart-slot chart-projects'));
    grid.appendChild(projects);

    this.root.appendChild(grid);

    // Status strip.
    const strip = el('footer', 'status-strip');
    strip.appendChild(el('span', 'status-item status-source', ''));
    strip.appendChild(el('span', 'status-item status-scan', ''));
    strip.appendChild(el('span', 'status-item status-ver', ''));
    strip.appendChild(el('span', 'status-item status-last', ''));
    strip.appendChild(el('span', 'status-item status-note', 'no quota or cost data exists locally, so none is shown'));
    this.root.appendChild(strip);
    this.root.appendChild(this.tip.node);

    /*
     * Loading state.
     *
     * Built up front and shown by default, so from the first painted frame the
     * wall already covers the desktop and says what it is doing. A cold index
     * is several seconds of parsing and rendering zeros during it would look
     * broken and, worse, read as real numbers.
     */
    const load = el('div', 'loading');
    const inner = el('div', 'loading-inner');
    const marks = el('div', 'loading-marks');
    for (let i = 0; i < 4; i++) {
      const m = el('span', 'loading-mark');
      m.style.setProperty('--i', String(i));
      marks.appendChild(m);
    }
    inner.appendChild(marks);
    inner.appendChild(el('div', 'loading-title', 'Indexing Claude usage'));
    inner.appendChild(el('div', 'loading-sub', 'reading local transcripts'));
    const track = el('div', 'loading-track');
    track.appendChild(el('div', 'loading-fill'));
    inner.appendChild(track);
    inner.appendChild(el('div', 'loading-count', ''));
    load.appendChild(inner);
    this.root.appendChild(load);
    this.root.classList.add('is-loading');
  }

  /** Progress from the main process during a cold index. */
  setProgress(p: { done: number; total: number; bytesDone: number; bytesTotal: number }): void {
    // A progress event means a cold index is running, so show the loader.
    this.root.classList.add('is-loading');
    if (p.bytesTotal <= 0) return;
    const frac = p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : 0;
    const fill = this.root.querySelector<HTMLElement>('.loading-fill');
    if (fill) fill.style.setProperty('--p', String(Math.max(0.02, Math.min(1, frac))));
    const count = this.root.querySelector('.loading-count');
    if (count) {
      count.textContent = `${p.done} / ${p.total} transcripts  ·  ${(p.bytesDone / 1048576).toFixed(0)} of ${(p.bytesTotal / 1048576).toFixed(0)} MB`;
    }
  }

  setPerfTier(tier: string): void {
    this.canvas.setPerfTier(tier);
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    if (v) {
      this.canvas.start();
      if (!this.clockTimer) {
        // Only the relative-time labels need a clock, and once every 20s is
        // plenty for "3m ago". Nothing else polls.
        this.clockTimer = window.setInterval(() => this.paintStatus(), 20_000);
      }
    } else {
      this.canvas.stop();
      if (this.clockTimer) {
        window.clearInterval(this.clockTimer);
        this.clockTimer = 0;
      }
    }
  }

  update(idx: UsageIndex): void {
    this.idx = idx;
    const d = derive(idx);

    /*
     * Only leave the loading state when the main process says the index is
     * COMPLETE, or the source is unreadable.
     *
     * Inferring it from "requests > 0" was wrong: refreshIndex mutates the
     * index in place, so a half-built one is observable, and the dashboard
     * briefly presented 5 of 419 transcripts as the final totals. Partial
     * numbers presented as complete are worse than no numbers.
     */
    const indexing = (idx as unknown as { indexing?: boolean }).indexing === true;
    if (!indexing || idx.unavailable) {
      this.root.classList.remove('is-loading');
    } else {
      this.root.classList.add('is-loading');
    }

    this.root.dataset.intensity = d.intensity > 0.66 ? 'high' : d.intensity > 0.3 ? 'mid' : 'calm';
    this.root.style.setProperty('--intensity', d.intensity.toFixed(3));

    const t = idx.totals;
    const animate = this.mounted;
    this.odos.total.set(totalOf(t), animate);
    this.odos.requests.set(t.requests, animate);
    this.odos.sessions.set(Object.keys(idx.sessions).length, animate);
    this.odos.prompts.set(idx.prompts.total, animate);
    this.odos.days.set(Object.keys(idx.daily).length, animate);
    this.odos.output.set(t.output, animate);
    this.odos.thinking.set(t.thinking, animate);
    this.odos.velocity.set(d.velocity, animate);
    this.odos.cache.set(d.cacheHitRate * 100, animate);

    const exact = this.root.querySelector('.hero-exact');
    if (exact) exact.textContent = `${full(totalOf(t))} tokens`;

    // Composition, so the headline cannot be mistaken for consumption.
    const grand = totalOf(t) || 1;
    const parts: [string, number, string][] = [
      ['cacheRead', t.cacheRead, 'cache reads'],
      ['cacheCreate', t.cacheCreate, 'cache writes'],
      ['output', t.output, 'generated'],
      ['input', t.input, 'fresh input'],
    ];
    for (const [key, value] of parts) {
      const seg = this.root.querySelector<HTMLElement>(`.comp-${key}`);
      if (seg) {
        seg.style.setProperty('--w', `${((value / grand) * 100).toFixed(3)}%`);
        seg.title = `${full(value)} tokens`;
      }
    }
    const legend = this.root.querySelector('.comp-legend');
    if (legend) {
      legend.replaceChildren();
      for (const [key, value, label] of parts) {
        const item = el('span', `comp-key comp-key-${key}`);
        const pct = (value / grand) * 100;
        item.textContent = `${label} ${pct >= 0.1 ? pct.toFixed(1) : pct.toFixed(2)}%`;
        legend.appendChild(item);
      }
    }

    const effFill = this.root.querySelector<HTMLElement>('.eff-fill');
    if (effFill) effFill.style.setProperty('--p', String(d.cacheHitRate));

    const liveState = this.root.querySelector('.live-state');
    if (liveState) {
      liveState.textContent = idx.unavailable
        ? 'source unavailable'
        : d.sinceLast < 90_000
          ? 'active now'
          : d.sinceLast < 3_600_000
            ? `quiet ${Math.round(d.sinceLast / 60000)}m`
            : 'idle';
    }

    this.canvas.update(idx, d.intensity);

    // Charts are rebuilt only when their inputs actually changed, so a refresh
    // during an active session does not restart every bar animation.
    const key = [
      Object.keys(idx.daily).length,
      t.requests,
      Object.keys(idx.models).length,
      Object.keys(idx.projects).length,
    ].join(':');
    if (key !== this.lastRenderKey) {
      this.lastRenderKey = key;
      this.paintCharts(idx);
    }

    this.paintStatus();
    this.mounted = true;
  }

  private paintCharts(idx: UsageIndex): void {
    // Daily, oldest to newest.
    const days = Object.entries(idx.daily).sort((a, b) => a[0].localeCompare(b[0]));
    const slot = this.root.querySelector('.chart-daily');
    if (slot) {
      slot.replaceChildren(
        columns(
          days.map(([k, v]) => ({
            key: k,
            value: totalOf(v),
            label: k,
            tip: [
              ['total', full(totalOf(v))],
              ['generated', full(v.output)],
              ['thinking', full(v.thinking)],
              ['requests', full(v.requests)],
            ] as [string, string][],
          })),
          this.tip,
        ),
      );
    }
    const legend = this.root.querySelector('.chart-daily-legend');
    if (legend && days.length) {
      legend.textContent = `${days[0][0]} to ${days[days.length - 1][0]}  ·  ${days.length} days`;
    }

    // Models by total tokens.
    const models = Object.entries(idx.models)
      .map(([label, v]) => ({
        label,
        value: totalOf(v),
        sub: `${full(v.requests)} requests`,
        tip: [
          ['total', full(totalOf(v))],
          ['generated', full(v.output)],
          ['thinking', full(v.thinking)],
          ['requests', full(v.requests)],
        ] as [string, string][],
      }))
      .sort((a, b) => b.value - a.value);
    const mslot = this.root.querySelector('.chart-models');
    if (mslot) mslot.replaceChildren(breakdown(models, 5, this.tip));

    // Hour of day, aggregated across the retained hourly buckets.
    const byHour = new Array(24).fill(0);
    const reqHour = new Array(24).fill(0);
    for (const [k, v] of Object.entries(idx.hourly)) {
      const h = new Date(`${k}:00:00Z`).getHours();
      byHour[h] += totalOf(v);
      reqHour[h] += v.requests;
    }
    const axis = this.root.querySelector('.hour-axis');
    if (axis && axis.childElementCount === 0) {
      for (let h = 0; h < 24; h++) {
        const cell = el('div', 'hour-tick');
        // Label every sixth hour: enough to orient, few enough to stay legible.
        if (h % 6 === 0) cell.textContent = `${String(h).padStart(2, '0')}`;
        axis.appendChild(cell);
      }
    }

    const hslot = this.root.querySelector('.chart-hours');
    if (hslot) {
      hslot.replaceChildren(
        columns(
          byHour.map((value, h) => ({
            key: String(h),
            value,
            label: `${String(h).padStart(2, '0')}:00 to ${String((h + 1) % 24).padStart(2, '0')}:00`,
            tip: [
              ['total', full(value)],
              ['requests', full(reqHour[h])],
            ] as [string, string][],
          })),
          this.tip,
        ),
      );
    }

    // Projects by total tokens, shown by folder name.
    /*
     * Folder name alone is ambiguous: two different working directories can end
     * in the same segment, which listed "Travel Game" twice with different
     * numbers. Fall back to parent/child for any name that is not unique.
     */
    const segsOf = (p: string) => p.split(/[\\/]/).filter(Boolean);
    // The map key is lowercased so a path recorded with a different drive-letter
    // case groups as one project. `display` carries the original casing, which
    // is what a person should actually read.
    const entries = Object.entries(idx.projects).map(([key, v]) => ({ path: v.display || key, v }));
    const leafCounts = new Map<string, number>();
    for (const e of entries) {
      const leaf = (segsOf(e.path).pop() || e.path).toLowerCase();
      leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
    }
    const projects = entries
      .map(({ path: p, v }) => {
        const segs = segsOf(p);
        const leaf = segs.pop() || p;
        const label =
          (leafCounts.get(leaf.toLowerCase()) || 0) > 1 && segs.length
            ? `${segs[segs.length - 1]} / ${leaf}`
            : leaf;
        return {
          label,
          value: totalOf(v),
          sub: `${full(v.requests)} requests`,
          tip: [
            ['total', full(totalOf(v))],
            ['generated', full(v.output)],
            ['requests', full(v.requests)],
            ['last used', v.lastSeen ? v.lastSeen.slice(0, 10) : 'unknown'],
          ] as [string, string][],
        };
      })
      .sort((a, b) => b.value - a.value);
    const busiest = byHour.indexOf(Math.max(...byHour));
    const hourLegend = this.root.querySelector('.panel-hours .chart-legend');
    if (hourLegend && byHour[busiest] > 0) {
      hourLegend.textContent =
        `by hour of day, pooled across the last 14 days  ·  busiest ${String(busiest).padStart(2, '0')}:00`;
    }

    const pslot = this.root.querySelector('.chart-projects');
    if (pslot) pslot.replaceChildren(breakdown(projects, 5, this.tip));
  }

  private paintStatus(): void {
    const idx = this.idx;
    if (!idx) return;
    const set = (sel: string, text: string) => {
      const n = this.root.querySelector(sel);
      if (n) n.textContent = text;
    };
    const fileCount = (idx as unknown as { fileCount?: number }).fileCount ?? Object.keys(idx.files ?? {}).length;
    set(
      '.status-source',
      idx.unavailable
        ? `SOURCE UNAVAILABLE  ${idx.unavailableReason ?? ''}`
        : `${full(fileCount)} transcripts indexed`,
    );
    set('.status-scan', `scan ${idx.lastScanMs}ms`);
    set('.status-ver', idx.latest.version ? `claude code ${idx.latest.version}` : '');
    set('.status-last', `last record ${relTime(idx.latest.ts)}`);
    this.root.classList.toggle('is-stale', idx.unavailable);
  }

  destroy(): void {
    this.canvas.stop();
    for (const o of Object.values(this.odos)) o.stop();
    if (this.clockTimer) window.clearInterval(this.clockTimer);
  }
}
