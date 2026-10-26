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

import { formatCost } from '../shared/pricing';
import { formatHours } from '../shared/active-time';
import { labelProjects } from '../shared/project-label';
import { ConstellationPanel } from './constellation';
import { velocityOf, VELOCITY_WINDOW_MS } from '../shared/velocity';

/** Minutes in the velocity window, for turning the rate back into a total. */
const VELOCITY_WINDOW_MIN = VELOCITY_WINDOW_MS / 60_000;
import type { UsageIndex, TokenTotals } from '../main/data/usage';
import type { HistorySummary } from '../shared/usage-merge';
import type { ProjectionStatus } from '../main/projection';
import type { ScreenStatus } from '../main/projection/screen';

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

/** The history block the main process attaches (src/shared/usage-merge.ts), if any. */
function historyOf(idx: UsageIndex): HistorySummary | null {
  return (idx as unknown as { history?: HistorySummary }).history ?? null;
}

/** Transcripts no longer on disk whose numbers the wall kept: archived exactly, or reconstructed. */
function archivedCount(idx: UsageIndex): number {
  const h = historyOf(idx);
  return h ? h.archivedFiles + h.reconstructedFiles : 0;
}

/**
 * The hero figure only: same tiers as compact(), one more decimal.
 *
 * At 27.7B a single decimal moves in steps of a hundred million tokens, so the
 * headline sat still through a whole day's work and then jumped. Two decimals
 * step every ten million, which is roughly a busy hour, so the number visibly
 * moves.
 *
 * It is NOT the cost formatter. That one floors, because a money figure that
 * rounds up claims spending that did not happen. This is a token count, it is
 * measured rather than estimated, and normal rounding is the honest thing: the
 * exact figure is printed in full directly underneath it either way.
 *
 * compact() is deliberately left alone. Velocity, models, projects and the peak
 * all read better at one decimal, and this is the one number big enough on
 * screen for a second to be legible.
 */
export function compactPrecise(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

const full = (n: number) => n.toLocaleString('en-US');

/** Age of an epoch-ms instant, coarse on purpose: "3m ago" is all a glance needs. */
function relAgo(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  return relAgo(t);
}

/**
 * Wall-clock HH:MM in the viewer's own zone, for "data as of 14:32". Built by
 * hand rather than with toLocaleTimeString, which some locales render as
 * "14.32" or with a suffix, and a status pill has no room for either.
 */
function clockTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

// ── Projection status wording ──────────────────────────────────────────────

/**
 * The source's label is typed on another machine and reaches three surfaces
 * here. textContent already makes it inert as markup, but a bidi override or
 * a zero-width joiner can still make "LIVE from <label>" read as something
 * else entirely, so control and direction-forcing characters are dropped at
 * this boundary rather than trusted to have been dropped upstream.
 */
/**
 * The label each project row shows.
 *
 * This used to be a second hand-written copy of `labelProjects`, kept in step
 * with src/shared/project-label.ts by nothing but care. It is now the shared
 * function, so the local wall and a paired screen cannot drift apart.
 *
 * `alreadyLabelled` is the part that was a real bug in BOTH copies. A screen
 * receives labels, not paths: the source ran them through the rule before they
 * crossed the wire. Running the rule again split a disambiguated label such as
 * "Desktop / code" on its own slash and rebuilt it as "Desktop  /  code", with
 * the spaces doubled, and a lone one came out as " code". Measured, not
 * assumed: the stats-projection suite pins it.
 */
export function projectLabels(paths: string[], alreadyLabelled: boolean): Map<string, string> {
  if (alreadyLabelled) return new Map(paths.map((p) => [p, p]));
  return labelProjects(paths);
}

export function cleanLabel(label: string): string {
  const cleaned = label.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '').trim();
  return cleaned || 'the source machine';
}

export type PillTone = 'live' | 'warn' | 'bad' | 'muted';

export interface Pill {
  text: string;
  tone: PillTone;
}

/**
 * The status-strip pill for the projection state, or null when projection is
 * off. Pure, so the mapping can be checked without a DOM.
 *
 * `retryAt` is the wall-clock the socket will retry at, fixed when its payload
 * arrived. The countdown is read off the clock at paint time rather than shown
 * as whatever number the last push happened to carry, which would sit frozen
 * between pushes and then be wrong.
 *
 * Ages come from `lastAt`, not `ageMs`, for the same reason: the receiver's
 * snapshot is exact when sent and stale a moment later, while `lastAt` lets the
 * 20 s status clock keep the label honest without a new payload.
 */
export function projectionPill(p: ProjectionStatus, retryAt: number | null, now = Date.now()): Pill | null {
  if (p.role === 'off') return null;
  const retry = (): string => {
    const left = retryAt === null ? 0 : Math.ceil((retryAt - now) / 1000);
    return left > 0 ? `retrying in ${left}s` : 'retrying now';
  };
  if (p.role === 'source') {
    if (p.phase === 'open') {
      const n = p.screens.length;
      if (n === 0) return { text: 'PROJECTING · no screens paired', tone: 'live' };
      const online = p.screens.filter((s) => s.online).length;
      return { text: `PROJECTING · ${online} of ${n} screen${n === 1 ? '' : 's'}`, tone: 'live' };
    }
    if (p.phase === 'closed') return { text: `PROJECTING · relay unreachable, ${retry()}`, tone: 'warn' };
    return { text: 'PROJECTING · connecting to relay', tone: 'muted' };
  }
  switch (p.phase) {
    case 'live':
      return { text: `LIVE from ${p.sourceLabel}`, tone: 'live' };
    case 'link-lost':
      return { text: `LINK LOST · last heard ${p.lastAt === null ? 'never' : relAgo(p.lastAt)}`, tone: 'warn' };
    case 'offline':
      return {
        text: `${p.sourceLabel} OFFLINE · data as of ${p.lastAt === null ? 'unknown' : clockTime(p.lastAt)}`,
        tone: 'warn',
      };
    case 'relay-unreachable':
      return { text: `RELAY UNREACHABLE · ${retry()}`, tone: 'warn' };
    case 'revoked':
      return { text: 'REMOVED BY THE SOURCE', tone: 'bad' };
    case 'space-closed':
      return { text: 'SOURCE STOPPED PROJECTING', tone: 'bad' };
    case 'key-mismatch':
      return { text: 'CANNOT DECRYPT · pair again', tone: 'bad' };
    default:
      return { text: 'CONNECTING...', tone: 'muted' };
  }
}

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

export function derive(idx: UsageIndex): Derived {
  const now = Date.now();

  const velocity = velocityOf(idx.recent, now);

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
    costUsd: 0, unpricedTokens: 0,
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

  /**
   * Show at a point rather than over an element. The constellation's stars are
   * drawn on a canvas, so there is no element per star to attach to.
   */
  showAt(x: number, y: number, title: string, rows: [string, string][]): void {
    this.node.replaceChildren();
    this.node.appendChild(el('div', 'tip-title', title));
    for (const [k, v] of rows) {
      const r = el('div', 'tip-row');
      r.appendChild(el('span', 'tip-k', k));
      r.appendChild(el('span', 'tip-v', v));
      this.node.appendChild(r);
    }
    this.node.classList.add('is-on');
    this.placeRect({ left: x, right: x, top: y, bottom: y, width: 0 });
  }

  hide(): void {
    this.node.classList.remove('is-on');
  }

  /** Above the target, clamped inside the viewport so it never runs off-screen. */
  private position(target: HTMLElement): void {
    this.placeRect(target.getBoundingClientRect());
  }

  private placeRect(r: { left: number; right: number; top: number; bottom: number; width: number }): void {
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
  private constellation = new ConstellationPanel(this.tip);
  private topPanel: 'constellation' | 'throughput' = 'constellation';
  /** Called when the user flips the top panel, so the choice can be saved. */
  onTopPanel: ((mode: 'constellation' | 'throughput') => void) | null = null;
  private odos: Record<string, Odometer> = {};
  private mounted = false;
  private visible = false;
  private idx: UsageIndex | null = null;
  private lastRenderKey = '';
  private clockTimer = 0;
  private projection: ProjectionStatus = { role: 'off' };
  /** Wall-clock the relay retry is due, fixed when its payload arrived. */
  private retryAt: number | null = null;

  constructor() {
    this.root = el('div', 'stats');
    this.build();
    this.setTopPanel(this.topPanel);
  }

  private build(): void {
    const grid = el('div', 'stats-grid');

    // Hero: total tokens processed.
    const hero = panel('Total tokens processed', 'measured', 'panel-hero');
    const heroBody = el('div', 'hero-body');
    this.odos.total = new Odometer('hero-value', compactPrecise);
    heroBody.appendChild(this.odos.total.node);
    const heroMeta = el('div', 'hero-meta');
    heroMeta.appendChild(el('span', 'hero-exact', ''));
    heroMeta.appendChild(el('span', 'hero-sub', 'across every session on this machine'));
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

    /*
     * The top row's big panel holds two things: the project constellation and
     * the live throughput trace. Gustav asked for the constellation to take the
     * place of the trace without losing it, so the header carries a two-way
     * toggle, remembered in settings.topPanel. Only the visible one does work:
     * the trace's animation loop stops while the sky is showing, and the sky
     * only ever repaints on data or size changes.
     */
    const live = panel('Constellation', 'measured', 'panel-live');
    const switcher = el('div', 'panel-toggle');
    switcher.setAttribute('role', 'tablist');
    for (const [mode, label] of [['constellation', 'Constellation'], ['throughput', 'Live']] as const) {
      const b = el('button', 'panel-toggle-btn', label);
      b.type = 'button';
      b.dataset.mode = mode;
      b.addEventListener('click', () => {
        this.setTopPanel(mode);
        this.onTopPanel?.(mode);
      });
      switcher.appendChild(b);
    }
    live.querySelector('.panel-head')!.insertBefore(switcher, live.querySelector('.panel-head .tag'));
    live.appendChild(this.constellation.node);

    const liveWrap = el('div', 'live-wrap');
    liveWrap.appendChild(this.canvas.node);
    const liveFoot = el('div', 'live-foot');
    liveFoot.appendChild(el('span', 'live-state', ''));
    liveWrap.appendChild(liveFoot);
    liveWrap.appendChild(
      el('div', 'live-explain', 'Tokens per 8sec column over the last 20 minutes'),
    );
    live.appendChild(liveWrap);
    grid.appendChild(live);

    /*
     * Right hand column of the top row: cost above velocity.
     *
     * A wrapper rather than two grid cells, so velocity keeps exactly the width
     * it had and only gives up height. Nothing else on the grid moves.
     */
    const stack = el('div', 'panel-stack');

    const cost = panel('Total cost', 'derived', 'panel-cost');
    const costBody = el('div', 'cost-body');
    const costValue = el('div', 'cost-value', '$0.00');
    costBody.appendChild(costValue);
    costBody.appendChild(el('div', 'cost-note', 'at API list prices, all projects'));
    const costGap = el('div', 'cost-gap');
    costGap.hidden = true;
    costBody.appendChild(costGap);
    cost.appendChild(costBody);

    /*
     * Hours, a small block beside the cost, which keeps most of the row
     * (Gustav, 2026-10-10). Always whole hours, never turned into days. What
     * counts as an hour is defined in src/shared/active-time.ts. Hidden, never
     * shown as 0, when a paired screen's source is too old to send it.
     */
    const costRow = el('div', 'cost-row');
    costRow.dataset.hours = 'off';
    costRow.appendChild(cost);
    const ran = panel('Hours', 'derived', 'panel-ran');
    const ranBody = el('div', 'ran-body');
    ranBody.appendChild(el('div', 'ran-value', '0'));
    ranBody.appendChild(el('div', 'ran-note', ''));
    ran.appendChild(ranBody);
    ran.title = 'Time Claude was working: responses at most five minutes apart, every session together, parallel sessions counted once.';
    costRow.appendChild(ran);
    stack.appendChild(costRow);

    // Velocity + today.
    /*
     * A QUANTITY, not a speed.
     *
     * This was "tokens / min" for a long time and it kept being wrong in a way
     * that was hard to name. Gustav got there in the end: a number labelled per
     * minute that only moves a tenth for each minute of new work, and that
     * still reads 1.8M nine minutes after he stops, does not describe any
     * minute he is looking at. He was objecting to the unit, not the division.
     *
     * The fix is not another window length. His data cannot support a rate at
     * any resolution finer than about ten minutes: Claude Code writes one
     * record per response, so a long thinking turn is a gap, and measured over
     * thirty minutes of real activity a one, two or five minute window reads
     * ZERO repeatedly while work is actively happening. A faster rate would be
     * a lie in the other direction.
     *
     * So the wall shows the window total with the window as its only time unit.
     * One unit, no conversion, and no claim about any individual minute.
     *
     * velocityOf() is untouched and still returns per minute: intensity uses
     * it, the peak is persisted in it, and the projection wire carries it. Only
     * the display multiplies back up.
     */
    const vel = panel('Recent volume', 'derived', 'panel-vel');
    const velBody = el('div', 'vel-body');
    this.odos.velocity = new Odometer('vel-value', (n) => compact(Math.round(n * VELOCITY_WINDOW_MIN)));
    velBody.appendChild(this.odos.velocity.node);
    velBody.appendChild(el('div', 'vel-unit', 'tokens, last 10 min'));
    // Worth saying on the wall itself: 97% of this is context being re-read.
    velBody.appendChild(el('div', 'vel-note', 'everything processed, mostly cache reads'));
    /*
     * The record. Hidden until one exists, because "PEAK 0" on a fresh install
     * reads as a measurement rather than an absence.
     */
    const peak = el('div', 'vel-peak');
    peak.hidden = true;
    peak.appendChild(el('span', 'vel-peak-label', 'peak'));
    peak.appendChild(el('span', 'vel-peak-value', ''));
    peak.appendChild(el('span', 'vel-peak-when', ''));
    velBody.appendChild(peak);
    vel.appendChild(velBody);
    stack.appendChild(vel);
    grid.appendChild(stack);

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
    projects.appendChild(el('div', 'chart-legend proj-foot', ''));
    grid.appendChild(projects);

    this.root.appendChild(grid);

    // Status strip.
    const strip = el('footer', 'status-strip');
    /*
     * Projection pill, first in the strip and hidden while projection is off.
     * On a screen this is the only thing that says whose numbers these are and
     * how old they are, so it leads the strip rather than trailing it.
     */
    const proj = el('span', 'status-item status-proj');
    proj.hidden = true;
    proj.appendChild(el('span', 'proj-dot'));
    proj.appendChild(el('span', 'proj-text', ''));
    strip.appendChild(proj);
    strip.appendChild(el('span', 'status-item status-source', ''));
    strip.appendChild(el('span', 'status-item status-scan', ''));
    strip.appendChild(el('span', 'status-item status-t3', ''));
    strip.appendChild(el('span', 'status-item status-ver', ''));
    strip.appendChild(el('span', 'status-item status-last', ''));
    /*
     * The app version. It reads from app.getVersion(), so every deploy updates
     * it and "which build am I looking at" is never a guess.
     *
     * This slot used to carry the note that no quota or cost data exists
     * locally. That disclosure still matters, so it survives as the hover title
     * rather than being dropped: the strip stays quiet, the reasoning stays
     * one hover away, and ARCHITECTURE.md carries the full version.
     */
    const version = el('span', 'status-item status-version', '');
    version.title = 'No quota, plan limit or cost data exists locally, so none is shown.';
    strip.appendChild(version);
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
    // A course of bricks with the first one knocked loose, which is the app's
    // own mark reduced to one line of CSS shapes.
    const marks = el('div', 'loading-marks');
    for (let i = 0; i < 5; i++) {
      const m = el('span', i === 0 ? 'loading-mark is-loose' : 'loading-mark');
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

    const none = el('div', 'nodata');
    const ni = el('div', 'loading-inner');
    ni.appendChild(el('div', 'nodata-mark', '!'));
    ni.appendChild(el('div', 'loading-title nodata-title', 'No Claude Code data on this machine'));
    ni.appendChild(
      el(
        'div',
        'nodata-body',
        'Claude Stats reads the transcripts Claude Code writes to ~/.claude. Nothing was found there, so there is nothing to report.',
      ),
    );
    ni.appendChild(el('div', 'nodata-path', ''));
    none.appendChild(ni);
    this.root.appendChild(none);
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

  /** Shown bottom-right, straight from the running build. */
  setVersion(v: string | undefined): void {
    const node = this.root.querySelector('.status-version');
    if (node) node.textContent = v ? `v${v}` : '';
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    if (v) {
      if (this.topPanel === 'throughput') this.canvas.start();
      this.constellation.setShown(this.topPanel === 'constellation');
      if (!this.clockTimer) {
        // Only the relative-time labels need a clock, and once every 20s is
        // plenty for "3m ago". Nothing else polls.
        this.clockTimer = window.setInterval(() => {
          this.paintStatus();
          this.paintTimeWindowed();
        }, 20_000);
      }
    } else {
      this.canvas.stop();
      this.constellation.setShown(false);
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

    /*
     * Where these numbers came from. On a SCREEN they are another machine's,
     * delivered over the relay, and every honesty rule below keys off the
     * projection phase instead of the local source, because the local source
     * was never read. The main process attaches the status to every payload.
     */
    const raw = (idx as unknown as { projection?: ProjectionStatus }).projection ?? { role: 'off' as const };
    const projection: ProjectionStatus =
      raw.role === 'screen' ? { ...raw, sourceLabel: cleanLabel(raw.sourceLabel) } : raw;
    this.projection = projection;
    const retryIn = projection.role === 'off' ? undefined : projection.retryIn;
    this.retryAt = typeof retryIn === 'number' ? Date.now() + retryIn * 1000 : null;
    const screen = projection.role === 'screen' ? projection : null;

    /*
     * Nothing to say at all. Locally that is an unreadable source with nothing
     * cached; on a screen it is a pairing that has never produced a frame, in
     * this process or in the cache. Showing zeros in every panel would read as
     * "you have used Claude zero times", which is a claim, not an absence.
     * Say the absence instead.
     *
     * A screen that HAS a frame keeps it through every phase, including
     * revoked: those numbers were real when they arrived, and the pill carries
     * their age.
     */
    const nothing = screen
      ? screen.lastAt === null && (idx.totals.requests === 0 && totalOf(idx.totals) === 0)
      : idx.unavailable && (idx.totals.requests === 0 && totalOf(idx.totals) === 0);
    this.root.classList.toggle('is-nodata', nothing);
    if (nothing) this.paintNoData(screen, idx);

    /*
     * Numbers that are not live are STALE and dimmed, never blanked and never
     * zeroed. Locally: cached figures with an unreadable source. On a screen:
     * any phase but `live`, which the receiver grants only on a frame it
     * decrypted itself within the last 90 s, plus the source's own
     * unavailable flag, since a live link to stale data is still stale data.
     */
    const stale = screen
      ? screen.phase !== 'live' || idx.unavailable
      : idx.unavailable && (idx.totals.requests > 0 || totalOf(idx.totals) > 0);
    this.root.classList.toggle('is-stale-data', stale);

    // "this machine" becomes a lie the moment the data is projected.
    const sub = this.root.querySelector('.hero-sub');
    if (sub) sub.textContent = `across every session on ${screen ? screen.sourceLabel : 'this machine'}`;

    this.root.dataset.intensity = d.intensity > 0.66 ? 'high' : d.intensity > 0.3 ? 'mid' : 'calm';
    this.root.style.setProperty('--intensity', d.intensity.toFixed(3));

    const t = idx.totals;
    const animate = this.mounted;
    this.odos.total.set(totalOf(t), animate);
    this.odos.requests.set(t.requests, animate);
    // Sessions known only as a count from reconstructed history are added, never invented.
    this.odos.sessions.set(Object.keys(idx.sessions).length + (historyOf(idx)?.reconstructedSessions ?? 0), animate);
    this.odos.prompts.set(idx.prompts.total, animate);
    this.odos.days.set(Object.keys(idx.daily).length, animate);
    this.odos.output.set(t.output, animate);
    this.odos.thinking.set(t.thinking, animate);
    this.odos.velocity.set(d.velocity, animate);
    this.paintCost();
    this.paintRan();
    this.paintPeak();
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
      // Record timestamps inside a frame that stopped arriving would still
      // read "active now" for a while. The link decides, not the payload.
      liveState.textContent = screen && screen.phase !== 'live'
        ? 'not live'
        : idx.unavailable
        ? 'source unavailable'
        : d.sinceLast < 90_000
          ? 'active now'
          : d.sinceLast < 3_600_000
            ? `quiet ${Math.round(d.sinceLast / 60000)}m`
            : 'idle';
    }

    this.canvas.update(idx, d.intensity);
    this.constellation.update(idx as never, projection.role === 'screen');

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
    // The map key is lowercased so a path recorded with a different drive-letter
    // case groups as one project. `display` carries the original casing, which
    // is what a person should actually read.
    const entries = Object.entries(idx.projects).map(([key, v]) => ({ path: v.display || key, v }));
    const labels = projectLabels(
      entries.map((e) => e.path),
      this.projection.role === 'screen',
    );
    const projects = entries
      .map(({ path: p, v }) => {
        const label = labels.get(p) ?? p;
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
    // Reconstructed history that could not be tied to a project is stated, not spread.
    const foot = this.root.querySelector('.proj-foot');
    const orphan = historyOf(idx)?.unattributedTokens ?? 0;
    const grand = totalOf(idx.totals);
    if (foot) {
      foot.textContent = orphan > 0 && grand > 0
        ? `${((orphan / grand) * 100).toFixed(orphan / grand < 0.01 ? 2 : 1)}% of tokens are in archived history with no project`
        : '';
    }
  }

  /**
   * Repaint the values whose meaning depends on the CURRENT time, not on new
   * data arriving.
   *
   * Velocity is "tokens per minute over a trailing ten minutes" and intensity
   * is derived from it, so both decay on their own as the window slides past
   * the last record. The dashboard only repainted when a usage push arrived,
   * which meant a machine with Claude Code closed sat there showing the last
   * velocity it ever computed, indefinitely, as though it were current.
   *
   * Gustav caught this by comparing two machines: the projected SCREEN decayed
   * to zero correctly, because a beat every thirty seconds forces it to
   * repaint, while the source froze. The screen was right and the source was
   * presenting a stale derived number as live, which is what rule 12 exists to
   * prevent.
   *
   * Only the time-windowed values are touched here. Totals do not change on
   * their own, and repainting them would restart their odometer animations
   * every twenty seconds for no reason.
   */
  /**
   * The all time high water mark, as sent by the main process.
   *
   * It is only ever displayed, never computed here. The record is decided in
   * one place so that a screen showing a projected dashboard reports the
   * SOURCE's record rather than quietly starting its own.
   */
  /**
   * The running total, floored to a tenth of a dollar.
   *
   * Not animated like the token odometer: an odometer rolling on a money figure
   * reads as a meter running, and this is an estimate of past spend, not a
   * live charge.
   */
  private paintCost(): void {
    const node = this.root.querySelector('.cost-value') as HTMLElement | null;
    const gap = this.root.querySelector('.cost-gap') as HTMLElement | null;
    if (!node || !this.idx) return;
    node.textContent = formatCost(this.idx.totals?.costUsd ?? 0);
    if (!gap) return;
    const unpriced = this.idx.totals?.unpricedTokens ?? 0;
    gap.hidden = unpriced <= 0;
    if (unpriced > 0) gap.textContent = `${compact(unpriced)} tokens from an unpriced model are not counted`;
  }

  /**
   * Whole hours since the first transcript on disk. The reconstructed history
   * before it has totals but no times, so it cannot add hours, and the note
   * says where the count starts rather than letting it pass for all time.
   */
  private paintRan(): void {
    const row = this.root.querySelector('.cost-row') as HTMLElement | null;
    if (!row || !this.idx) return;
    const at = (this.idx as unknown as { activeTime?: { seconds?: number; since?: number | null } }).activeTime;
    // No first stretch means nothing was measured (an empty or unreadable
    // source, or an old one): hide the block rather than paint a 0.
    const since = typeof at?.since === 'number' ? new Date(at.since) : null;
    const measured = !!since && !Number.isNaN(since.getTime());
    row.dataset.hours = measured ? 'on' : 'off';
    if (!measured) return;
    (row.querySelector('.ran-value') as HTMLElement).textContent = formatHours(at?.seconds ?? 0);
    // The year only once it is not this year's, so "since 11 Jul" never means the wrong July.
    const opts: Intl.DateTimeFormatOptions = since.getFullYear() === new Date().getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
    (row.querySelector('.ran-note') as HTMLElement).textContent = `since ${since.toLocaleDateString('en-GB', opts)}`;
  }

  private paintPeak(): void {
    const node = this.root.querySelector('.vel-peak') as HTMLElement | null;
    if (!node) return;
    const p = this.idx?.peak;
    if (!p || !(p.velocity > 0)) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    // Stored per minute, shown over the same window as the value above it.
    (node.querySelector('.vel-peak-value') as HTMLElement).textContent = compact(
      Math.round(p.velocity * VELOCITY_WINDOW_MIN),
    );
    const when = relTime(p.at);
    (node.querySelector('.vel-peak-when') as HTMLElement).textContent = when ? `· ${when}` : '';
  }

  private paintTimeWindowed(): void {
    if (!this.idx) return;

    /*
     * A screen that is not live has already frozen its clock deliberately, so
     * that its trace does not scroll real data off the edge as if time were
     * passing on data that stopped arriving. Do not thaw it here.
     */
    if (this.projection?.role === 'screen' && this.projection.phase !== 'live') return;

    const d = derive(this.idx);
    this.odos.velocity.set(d.velocity, true);
    this.paintPeak();
    this.root.dataset.intensity = d.intensity > 0.66 ? 'high' : d.intensity > 0.3 ? 'mid' : 'calm';
    this.root.style.setProperty('--intensity', d.intensity.toFixed(3));
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
        : archivedCount(idx) > 0
          ? `${full(fileCount)} transcripts on disk, ${full(archivedCount(idx))} archived`
          : `${full(fileCount)} transcripts indexed`,
    );
    const health = (idx as UsageIndex & { sourceHealth?: { checkedAt: string; t3: string; fallbackSessions: number; skippedTurns: number } }).sourceHealth;
    set('.status-scan', health ? `Claude checked ${relTime(health.checkedAt)}` : `scan ${idx.lastScanMs}ms`);
    set('.status-t3', health ? `T3 Claude: ${health.t3 === 'ready' ? 'checked' : health.t3}${health.fallbackSessions ? `, ${health.fallbackSessions} fallback sessions` : ''}` : '');
    const t3Status = this.root.querySelector<HTMLElement>('.status-t3');
    if (t3Status) t3Status.title = health
      ? `Claude transcripts take priority. T3 supplies only missing sessions with complete main-agent usage and no subagents. ${health.skippedTurns} turns lack eligible usage. Fallback tokens are unpriced; API request counts, active hours and live velocity remain transcript-only. Codex is not included.` : '';
    set('.status-ver', idx.latest.version ? `claude code ${idx.latest.version}` : '');
    set('.status-last', `last record ${relTime(idx.latest.ts)}`);
    this.root.classList.toggle('is-stale', idx.unavailable);

    // Repainted on the same 20 s clock as the relative times, so "last heard"
    // and the retry countdown age correctly between payloads.
    const pill = this.root.querySelector<HTMLElement>('.status-proj');
    if (pill) {
      const p = projectionPill(this.projection, this.retryAt);
      pill.hidden = p === null;
      if (p) {
        pill.dataset.tone = p.tone;
        // The pulsing dot belongs to a screen receiving live frames, not to a
        // source that merely has its socket open, so the role is on the node.
        pill.dataset.role = this.projection.role;
        const text = pill.querySelector('.proj-text');
        if (text) text.textContent = p.text;
      }
    }
  }

  /**
   * Wording for the empty panel. Two different absences: a local source with
   * nothing to read, and a paired screen that has never received a frame. The
   * second must not say "no Claude Code data on this machine", because this
   * machine's data was never the subject.
   */
  private paintNoData(screen: ScreenStatus | null, idx: UsageIndex): void {
    const set = (sel: string, text: string) => {
      const n = this.root.querySelector(sel);
      if (n) n.textContent = text;
    };
    if (!screen) {
      set('.nodata-title', 'No Claude Code data on this machine');
      set(
        '.nodata-body',
        'Claude Stats reads the transcripts Claude Code writes to ~/.claude. Nothing was found there, so there is nothing to report.',
      );
      set('.nodata-path', idx.unavailableReason ?? '');
      return;
    }
    const src = screen.sourceLabel;
    switch (screen.phase) {
      case 'revoked':
        set('.nodata-title', `Removed by ${src}`);
        set(
          '.nodata-body',
          `${src} removed this screen from its projection before a single frame arrived, so there is nothing to show. Pair again from the tray to reconnect.`,
        );
        break;
      case 'space-closed':
        set('.nodata-title', `${src} stopped projecting`);
        set(
          '.nodata-body',
          'The source closed its projection before this screen received anything, so there is nothing to show. It needs to start projecting again and pair this screen.',
        );
        break;
      case 'key-mismatch':
        set('.nodata-title', `Cannot decrypt frames from ${src}`);
        set(
          '.nodata-body',
          'Frames are arriving but this screen cannot open them, so nothing is shown rather than something guessed. Pair again to exchange a fresh key.',
        );
        break;
      default:
        // Connecting, or the relay is down. The remaining phases need a frame
        // and cannot occur here.
        set('.nodata-title', `Waiting for ${src}`);
        set(
          '.nodata-body',
          `This screen is paired to ${src} and has not received a frame yet. The dashboard fills in when the first one arrives; nothing is shown before then.`,
        );
    }
    set('.nodata-path', screen.reason ?? '');
  }

  /**
   * Show the constellation or the live trace in the top row's big panel.
   * Idempotent, so a state push repeating the saved choice costs nothing.
   */
  setTopPanel(mode: 'constellation' | 'throughput'): void {
    this.topPanel = mode;
    const live = this.root.querySelector('.panel-live');
    if (!live) return;
    live.setAttribute('data-top', mode);
    const title = live.querySelector('.panel-title');
    if (title) title.textContent = mode === 'constellation' ? 'Constellation' : 'Live throughput';
    for (const b of live.querySelectorAll<HTMLButtonElement>('.panel-toggle-btn')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    }
    const showSky = mode === 'constellation';
    this.constellation.setShown(showSky && this.visible);
    if (showSky || !this.visible) this.canvas.stop();
    else this.canvas.start();
  }

  destroy(): void {
    this.canvas.stop();
    for (const o of Object.values(this.odos)) o.stop();
    if (this.clockTimer) window.clearInterval(this.clockTimer);
  }
}
