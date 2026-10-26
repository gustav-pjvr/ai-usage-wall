/**
 * Claude and Codex side by side (docs/design/codex-side-by-side.md, section 4,
 * approved by Gustav 2026-10-26; the mock in docs/design/mock is the target).
 *
 * Two things live here:
 *
 *   - the SIMPLE view: one large card per engine and a full-width "Today, side
 *     by side" panel with a lane per provider on one 24-hour axis;
 *   - the small helpers the detailed view shares with it (the plan rows for
 *     Claude and Codex, reset and reading times, model names, the provider
 *     label).
 *
 * Honesty rules carried over from the rest of the wall:
 *   - a number nothing measured is HIDDEN, never painted as 0;
 *   - each engine's chart has its own scale, and says so, because Codex is a
 *     fraction of a percent of Claude and would be invisible on a shared one;
 *   - a plan window whose reset time has passed shows as reset, never the stale
 *     percentage it last read (windowCurrent, src/shared/codex-view.ts);
 *   - the plan reading always shows its age: it is from when Codex last ran,
 *     or, for Claude, from when Claude Code last fetched it (section 5).
 *
 * Repaint cost: everything here is rebuilt only when its own inputs change
 * (a signature per card and per lane), and the clock only moves the now marker
 * and re-reads the plan windows. No animation loop.
 */

import { formatCost } from '../shared/pricing';
import { formatHours } from '../shared/active-time';
import { localDayKey } from '../shared/day';
import { windowCurrent, type CodexLimits, type CodexView } from '../shared/codex-view';
import { cleanClaudeLimits, type ClaudeLimits } from '../shared/claude-limits';
import { compact, compactPrecise } from './stats';

// ── Shared helpers ─────────────────────────────────────────────────────────

interface Tokens {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export const totalOf = (t: Tokens): number => t.input + t.output + t.cacheCreate + t.cacheRead;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string | null): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** A provider label: a coloured dot and the name, uppercase like the panel titles. */
export function who(kind: 'claude' | 'codex', text: string, extra = ''): HTMLElement {
  const w = el('span', `who who-${kind} ${extra}`.trim());
  w.append(el('span', 'who-dot'), el('span', 'who-name', text));
  return w;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const dayMonth = (ms: number, weekday: boolean): string =>
  new Date(ms).toLocaleDateString('en-GB', weekday ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });

/** A time ahead: "16:00" today, "tomorrow 03:00", otherwise "Mon 2 Nov". */
export function whenAhead(ms: number, now: number): string {
  const day = localDayKey(ms);
  if (day === localDayKey(now)) return clock(ms);
  if (day === localDayKey(now + 86_400_000)) return `tomorrow ${clock(ms)}`;
  return dayMonth(ms, true);
}

/** A time behind: "11:39" today, otherwise "Sun 25 Oct 11:39". */
export function whenPast(ms: number, now: number): string {
  return localDayKey(ms) === localDayKey(now) ? clock(ms) : `${dayMonth(ms, true)} ${clock(ms)}`;
}

/** Coarse age, like the status strip's: "just now", "12m ago", "3h ago", "2d ago". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** "claude-opus-5-5" reads "opus 5.5"; Codex ids are already short and stay as they are. */
export function tidyModel(m: string): string {
  return m
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-(\d+)$/, ' $1');
}

/** Top models by tokens, tidied, joined with a middle dot. */
export function topModels(models: Record<string, Tokens>, n = 3): string {
  return Object.entries(models ?? {})
    .map(([m, t]) => [m, totalOf(t)] as const)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([m]) => tidyModel(m))
    .join(' · ');
}

/** Share as text: "0.07%", "4.2%". */
export function shareText(part: number, whole: number): string {
  const pct = whole > 0 ? (part / whole) * 100 : 0;
  return `${pct >= 0.1 ? pct.toFixed(1) : pct.toFixed(2)}%`;
}

/** Ink for a used percentage: red at 90 and over, amber at 70, otherwise the provider's own colour. */
const toneOf = (pct: number): string => (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok');

/**
 * One plan window as the rows paint it, whichever provider it came from.
 * `short` is the detailed panel's label, `long` the simple card's.
 */
export interface PlanRow {
  short: string;
  long: string;
  usedPercent: number;
  /** Epoch ms. Once in the past, the window has reset. */
  resetsAt: number;
}

/** Codex's two windows as rows. */
export function codexRows(limits: CodexLimits): PlanRow[] {
  const rows: PlanRow[] = [];
  if (limits.fiveHour) rows.push({ short: '5 h', long: '5-hour window', usedPercent: limits.fiveHour.usedPercent, resetsAt: limits.fiveHour.resetsAt });
  if (limits.weekly) rows.push({ short: 'week', long: 'This week', usedPercent: limits.weekly.usedPercent, resetsAt: limits.weekly.resetsAt });
  return rows;
}

/** Claude's rows: "5 h" (session), "week", and "week, <model>" per scoped limit, in the words Codex's rows use. */
export function claudeRows(limits: ClaudeLimits): PlanRow[] {
  return limits.rows.map((r) => ({
    short: r.label,
    long: r.label === '5 h' ? '5-hour window' : r.label === 'week' ? 'This week' : `This ${r.label}`,
    usedPercent: r.usedPercent,
    resetsAt: r.resetsAt,
  }));
}

const rowCurrent = (r: PlanRow, now: number): boolean => windowCurrent({ usedPercent: r.usedPercent, windowMinutes: 0, resetsAt: r.resetsAt }, now);

/**
 * The plan rows, into `box`. `long` is the simple view's wording, with a
 * reset-time column; the detailed panel is too narrow for it and states the
 * resets once in its note instead. A window that has reset says so in place
 * of its bar and percent, so the stale reading can never be read as current.
 */
export function paintLimitRows(box: HTMLElement, rows: PlanRow[], now: number, long: boolean): void {
  box.replaceChildren();
  for (const w of rows) {
    const row = el('div', 'lim-row');
    row.append(el('span', 'lim-label', long ? w.long : w.short));
    if (rowCurrent(w, now)) {
      const pct = Math.max(0, Math.min(100, Number(w.usedPercent) || 0));
      row.dataset.tone = toneOf(pct);
      const bar = el('span', 'lim-bar');
      const fill = el('i', 'lim-fill');
      fill.style.width = `${pct.toFixed(1)}%`;
      bar.append(fill);
      row.append(bar, el('span', 'lim-num', `${Math.round(pct)}%`));
      if (long) row.append(el('span', 'lim-note', `resets ${whenAhead(w.resetsAt, now)}`));
    } else {
      row.dataset.tone = 'reset';
      row.append(
        el('span', 'lim-reset', long
          ? `reset at ${whenPast(w.resetsAt, now)}, not read since`
          : `reset at ${whenPast(w.resetsAt, now)}`),
      );
    }
    box.append(row);
  }
}

/** "resets 16:00 and Mon 2 Nov": the windows still current, each time once. Empty when every window has reset. */
export function resetsText(rows: PlanRow[], now: number): string {
  const times = [...new Set(rows.filter((w) => rowCurrent(w, now)).map((w) => whenAhead(w.resetsAt, now)))];
  if (!times.length) return '';
  const list = times.length === 1 ? times[0] : `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`;
  return `resets ${list}`;
}

/** The line under the plan rows: when the windows reset and how old the reading is. */
export function planNote(limits: CodexLimits, now: number, long: boolean): string {
  const at = Date.parse(limits.at);
  const read = Number.isFinite(at) ? at : null;
  if (long) {
    const plan = limits.plan ? `${limits.plan.charAt(0).toUpperCase()}${limits.plan.slice(1)} plan. ` : '';
    return read === null
      ? `${plan}Reading time unknown.`
      : `${plan}Read at ${whenPast(read, now)} (${ago(read, now)}), when Codex last ran.`;
  }
  const resets = resetsText(codexRows(limits), now);
  const head = resets ? `${resets}. ` : '';
  return `${head}Read ${read === null ? 'at an unknown time' : ago(read, now)}`;
}

/** The simple card's line under Claude's rows, worded like Codex's. */
export function claudeNote(limits: ClaudeLimits, now: number): string {
  const read = Date.parse(limits.at);
  return Number.isFinite(read) ? `Read at ${whenPast(read, now)} (${ago(read, now)}), by Claude Code.` : 'Reading time unknown.';
}

/** A reading's age for the detailed panel's group heads: "read 3m ago". */
export function readAgo(at: string, now: number): string {
  const read = Date.parse(at);
  return Number.isFinite(read) ? `read ${ago(read, now)}` : 'read at an unknown time';
}

/** Whether the reading has at least one window to show. */
export const hasLimits = (l: CodexLimits | null | undefined): l is CodexLimits => !!l && (!!l.fiveHour || !!l.weekly);

// ── Small charts ───────────────────────────────────────────────────────────

/** Bars for a short series on its own scale. Zero draws nothing: no sliver pretending to be a value. */
function bars(values: number[]): SVGSVGElement {
  const w = 1000;
  const h = 100;
  const n = Math.max(1, values.length);
  const gap = 6;
  const bw = (w - gap * (n - 1)) / n;
  const max = Math.max(1, ...values);
  const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  values.forEach((v, i) => {
    if (!(v > 0)) return;
    const bh = Math.max(2, (v / max) * (h - 2));
    root.append(svg('rect', { x: (i * (bw + gap)).toFixed(2), y: (h - bh).toFixed(2), width: bw.toFixed(2), height: bh.toFixed(2), rx: 2, class: i === n - 1 ? 'is-today' : '' }));
  });
  return root;
}

/** Slot of the day `now` is in, 0 to 287, as a fraction for the lane's x axis. */
const nowSlot = (now: number): number => {
  const d = new Date(now);
  return (d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60) / 5;
};

/** One provider's day: a mark for every five minutes it was working, sized by tokens (square root, so quiet slots stay visible). */
function lane(slots: number[], now: number): { node: SVGSVGElement; marker: SVGRectElement } {
  const root = svg('svg', { viewBox: '0 0 288 10', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  root.append(svg('rect', { x: 0, y: 4.5, width: 288, height: 1, class: 'lane-base' }));
  const max = Math.max(1, ...slots);
  slots.forEach((v, i) => {
    if (!(v > 0)) return;
    const k = Math.max(0.25, Math.sqrt(v / max));
    root.append(svg('rect', { x: i, y: (5 - 5 * k).toFixed(3), width: 0.9, height: (10 * k).toFixed(3), class: 'lane-mark' }));
  });
  const marker = svg('rect', { x: nowSlot(now).toFixed(2), y: 0, width: 0.6, height: 10, class: 'lane-now' });
  root.append(marker);
  return { node: root, marker };
}

const validSlots = (s: unknown): s is number[] => Array.isArray(s) && s.length === 288 && s.every((v) => typeof v === 'number' && Number.isFinite(v));

/** The last 14 UTC days, oldest first, keyed like `daily` (Gustav's standing choice for the daily chart). */
function last14(now: number): string[] {
  const out: string[] = [];
  for (let i = 13; i >= 0; i--) out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}
const keyLabel = (key: string): string => dayMonth(Date.parse(`${key}T12:00:00Z`), false);

// ── The simple view ────────────────────────────────────────────────────────

/** What the simple view reads off Claude's usage payload. Structural, so this file imports nothing from main. */
export interface ClaudeUsage {
  totals: Tokens & { requests: number; costUsd: number; unpricedTokens?: number };
  daily: Record<string, Tokens>;
  models: Record<string, Tokens>;
  activeDays?: Record<string, number>;
  activeTime?: { seconds?: number; since?: number | null };
  todaySlots?: number[];
  /** Claude's plan reading (src/shared/claude-limits.ts). Re-validated here; absent or malformed hides the rows. */
  claudeLimits?: unknown;
}

interface EngineNodes {
  root: HTMLElement;
  models: HTMLElement;
  big: HTMLElement;
  bigsub: HTMLElement;
  cost: HTMLElement;
  costStat: HTMLElement;
  /** The unpriced-tokens caveat, the same words as the detailed view's `.cost-gap`. */
  gap: HTMLElement;
  hours: HTMLElement;
  hoursStat: HTMLElement;
  today: HTMLElement;
  todayStat: HTMLElement;
  spark: HTMLElement;
  first: HTMLElement;
  /** The plan rows and the reading line, for either provider. */
  limits: HTMLElement;
  limitRows: HTMLElement;
  limitNote: HTMLElement;
  /** Claude only: which period the hours and the tokens count from, when they differ. */
  since: HTMLElement | null;
}

/**
 * The cost stat and its caveat. Tokens of a model with no published price are
 * not in the cost, and the caveat says so in the detailed view's words; when
 * EVERY token is unpriced the cost is hidden, never shown as $0.00.
 */
function paintCost(card: EngineNodes, t: Tokens & { costUsd: number; unpricedTokens?: number }, prefix: string): void {
  const unpriced = t.unpricedTokens ?? 0;
  const none = unpriced > 0 && unpriced >= totalOf(t);
  card.costStat.dataset.on = none ? 'off' : 'on';
  if (!none) card.cost.textContent = formatCost(t.costUsd ?? 0);
  card.gap.dataset.on = unpriced > 0 ? 'on' : 'off';
  card.gap.textContent = unpriced > 0 ? `${prefix}${compact(unpriced)} tokens from an unpriced model are not counted` : '';
}

function engine(kind: 'claude' | 'codex'): EngineNodes {
  const isCx = kind === 'codex';
  const root = el('section', `panel engine engine-${isCx ? 'cx' : 'cl'}`);
  const top = el('div', 'eng-top');
  const name = el('h2', 'eng-name');
  name.append(el('span', 'eng-dot'), el('span', undefined, isCx ? 'Codex' : 'Claude Code'));
  const models = el('span', 'eng-models', '');
  top.append(name, models);

  const big = el('div', 'eng-big', '');
  const bigsub = el('div', 'eng-bigsub', '');

  const row = el('div', 'eng-row');
  const stat = (cls: string, label: string): [HTMLElement, HTMLElement] => {
    const s = el('div', `eng-stat ${cls}`);
    const v = el('div', 'eng-num', '');
    s.append(v, el('div', 'eng-label', label));
    row.append(s);
    return [s, v];
  };
  const [costStat, cost] = stat('eng-cost', 'cost at API list prices');
  const [hoursStat, hours] = stat('eng-hours', 'hours');
  const [todayStat, today] = stat('eng-today', 'requests today');

  const gap = el('div', 'cost-gap eng-gap');
  gap.dataset.on = 'off';

  const spark = el('div', 'eng-spark');
  const foot = el('div', 'eng-sparkfoot');
  const first = el('span', undefined, '');
  foot.append(first, el('span', undefined, 'last 14 days, its own scale'), el('span', undefined, 'today'));

  // Both cards show their plan the same way; Claude's rows in its teal, Codex's in violet.
  const limits = el('div', 'eng-limits');
  limits.dataset.on = 'off';
  const limitRows = el('div', `lim-rows ${isCx ? 'lim-cx' : 'lim-cl'}`);
  const limitNote = el('div', 'eng-asof', '');
  limits.append(limitRows, limitNote);
  const since = isCx ? null : el('div', 'eng-since', '');

  root.append(top, big, bigsub, row, gap, spark, foot, limits);
  if (since) root.append(since);
  return { root, models, big, bigsub, cost, costStat, gap, hours, hoursStat, today, todayStat, spark, first, limits, limitRows, limitNote, since };
}

export class SimpleView {
  readonly root: HTMLElement;
  private readonly cl = engine('claude');
  private readonly cx = engine('codex');
  private readonly todayPanel: HTMLElement;
  private readonly handoff: HTMLElement;
  private readonly laneCl: HTMLElement;
  private readonly laneCx: HTMLElement;
  private markers: SVGRectElement[] = [];
  private sparkSig = { cl: '', cx: '' };
  private laneSig = { cl: '', cx: '' };
  private codex: CodexView | null = null;
  private plan: ClaudeLimits | null = null;

  constructor() {
    this.root = el('div', 'simple');
    const engines = el('div', 'engines');
    engines.append(this.cl.root, this.cx.root);

    this.todayPanel = el('section', 'panel today-panel');
    // Off until a lane has something to draw: with no lane at all the panel stays hidden.
    this.todayPanel.dataset.on = 'off';
    const head = el('header', 'panel-head');
    head.append(el('h2', 'panel-title', 'Today, side by side'));
    this.handoff = el('span', 'today-handoff cx');
    head.append(this.handoff);
    this.todayPanel.append(head);

    const lanes = el('div', 'lanes');
    const clLabel = who('claude', 'Claude', 'lane-who lane-cl-who');
    this.laneCl = el('div', 'lane lane-cl');
    const cxLabel = who('codex', 'Codex', 'lane-who lane-cx-who cx');
    this.laneCx = el('div', 'lane lane-cx cx');
    const axis = el('div', 'lane-axis');
    for (const t of ['00:00', '06:00', '12:00', '18:00', '24:00']) axis.append(el('span', undefined, t));
    lanes.append(clLabel, this.laneCl, cxLabel, this.laneCx, axis);
    this.todayPanel.append(lanes);

    this.root.append(engines, this.todayPanel);
  }

  /** New data. `codex` is null when it is absent or still being indexed for the first time. */
  update(u: ClaudeUsage, codex: CodexView | null, now = Date.now()): void {
    this.codex = codex;
    this.plan = cleanClaudeLimits(u.claudeLimits);
    const today = localDayKey(now);
    const days = last14(now);

    // ── Claude ──
    const ct = u.totals;
    this.cl.models.textContent = topModels(u.models);
    this.cl.big.textContent = compactPrecise(totalOf(ct));
    const dailyKeys = Object.keys(u.daily ?? {}).sort();
    const since = dailyKeys.length ? keyLabel(dailyKeys[0]) : null;
    this.cl.bigsub.textContent = since ? `tokens processed since ${since}` : 'tokens processed';
    paintCost(this.cl, ct, '');
    const at = u.activeTime;
    const hoursOn = typeof at?.since === 'number' && Number.isFinite(at.since);
    this.cl.hoursStat.dataset.on = hoursOn ? 'on' : 'off';
    if (hoursOn) this.cl.hours.textContent = formatHours(at?.seconds ?? 0);
    const reqOn = !!u.activeDays && typeof u.activeDays === 'object';
    this.cl.todayStat.dataset.on = reqOn ? 'on' : 'off';
    if (reqOn) this.cl.today.textContent = (u.activeDays![today] ?? 0).toLocaleString('en-US');
    this.paintSpark('cl', days.map((k) => (u.daily?.[k] ? totalOf(u.daily[k]) : 0)), days);
    const hoursSince = hoursOn ? dayMonth(at!.since as number, false) : null;
    const sinceText = hoursSince && since ? `Hours count since ${hoursSince}; tokens and cost since ${since}.` : '';
    if (this.cl.since) {
      this.cl.since.textContent = sinceText;
      this.cl.since.dataset.on = sinceText ? 'on' : 'off';
    }

    // ── Codex ──
    if (codex) {
      const t = codex.totals;
      this.cx.models.textContent = topModels(codex.models);
      this.cx.big.textContent = compactPrecise(totalOf(t));
      const first = codex.firstAt ? Date.parse(codex.firstAt) : NaN;
      this.cx.bigsub.textContent = Number.isFinite(first) ? `tokens processed since ${dayMonth(first, false)}` : 'tokens processed';
      paintCost(this.cx, t, 'Codex: ');
      const cat = codex.activeTime;
      const cxHours = typeof cat?.since === 'number' && Number.isFinite(cat.since);
      this.cx.hoursStat.dataset.on = cxHours ? 'on' : 'off';
      if (cxHours) this.cx.hours.textContent = formatHours(cat.seconds ?? 0);
      const cxReq = !!codex.activeDays && typeof codex.activeDays === 'object';
      this.cx.todayStat.dataset.on = cxReq ? 'on' : 'off';
      if (cxReq) this.cx.today.textContent = (codex.activeDays[today] ?? 0).toLocaleString('en-US');
      this.paintSpark('cx', days.map((k) => (codex.daily?.[k] ? totalOf(codex.daily[k]) : 0)), days);

      const s = codex.sessions;
      const showHandoff = !!s && s.total > 0;
      this.handoff.dataset.on = showHandoff ? 'on' : 'off';
      if (showHandoff) {
        this.handoff.replaceChildren(
          document.createTextNode('Claude started '),
          el('b', undefined, `${s.byClaude} of ${s.total}`),
          document.createTextNode(' Codex sessions'),
        );
      }
    }

    // ── Today's lanes ──
    this.paintLane('cl', this.laneCl, u.todaySlots, now);
    this.paintLane('cx', this.laneCx, codex?.todaySlots, now);
    this.tick(now);
  }

  /** The clock: the now marker, the plan windows (one may have just reset) and the readings' age. */
  tick(now = Date.now()): void {
    const x = nowSlot(now).toFixed(2);
    for (const m of this.markers) m.setAttribute('x', x);
    const lim = this.codex?.limits;
    this.cx.limits.dataset.on = hasLimits(lim) ? 'on' : 'off';
    if (hasLimits(lim)) {
      paintLimitRows(this.cx.limitRows, codexRows(lim), now, true);
      this.cx.limitNote.textContent = planNote(lim, now, true);
    }
    const plan = this.plan;
    this.cl.limits.dataset.on = plan ? 'on' : 'off';
    if (plan) {
      paintLimitRows(this.cl.limitRows, claudeRows(plan), now, true);
      this.cl.limitNote.textContent = claudeNote(plan, now);
    }
  }

  private paintSpark(which: 'cl' | 'cx', values: number[], days: string[]): void {
    const sig = values.join(',');
    const card = which === 'cl' ? this.cl : this.cx;
    card.first.textContent = keyLabel(days[0]);
    if (sig === this.sparkSig[which]) return;
    this.sparkSig[which] = sig;
    card.spark.replaceChildren(bars(values));
  }

  private paintLane(which: 'cl' | 'cx', box: HTMLElement, slots: unknown, now: number): void {
    const ok = validSlots(slots);
    box.dataset.on = ok ? 'on' : 'off';
    // Decided before the unchanged-signature return below, so a payload with no lane at all still says so.
    const other = this.laneSig[which === 'cl' ? 'cx' : 'cl'];
    this.todayPanel.dataset.on = ok || other !== '' ? 'on' : 'off';
    const label = this.todayPanel.querySelector<HTMLElement>(`.lane-${which}-who`);
    if (label) label.dataset.on = ok ? 'on' : 'off';
    const sig = ok ? (slots as number[]).join(',') : '';
    if (sig === this.laneSig[which]) return;
    this.laneSig[which] = sig;
    box.replaceChildren();
    if (ok) box.append(lane(slots as number[], now).node);
    this.markers = [...this.todayPanel.querySelectorAll<SVGRectElement>('.lane-now')];
  }
}
