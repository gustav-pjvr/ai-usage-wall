/**
 * The project constellation: where each project's star goes, and how big and
 * bright it is. Pure, so it is tested without a window and so the local wall
 * and a paired screen lay out the same sky from the same data.
 *
 * WHAT EACH PROPERTY MEANS (the panel caption says the same)
 *
 * - SIZE is the project's total tokens on a fixed log scale: under 10M, 10M,
 *   100M, 1B, 10B and up. Fixed thresholds rather than ranks, so one project
 *   growing never resizes its neighbours. Total means the hero's total, so it
 *   is mostly cache reads; the hover shows generated separately.
 * - BRIGHTNESS is recency: halves every 7 days since the project was last
 *   used, and never drops below 0.12, so a dormant project is dim, not gone.
 * - A LINK joins two projects worked on the same local day, weighted by how
 *   many days they shared. "Same session" is not knowable: a session is one
 *   working directory. A session contributes the local day it started and the
 *   day it ended, never the days in between, because a resumed session keeps
 *   its id and its span can run to weeks.
 * - The ACTIVE star is the project of the latest record, only while that
 *   record is under 15 minutes old.
 *
 * Nothing here is invented. Projects past the cap are counted in `more`, never
 * drawn as filler.
 */

import { localDayKey } from './day';

export interface StarInput {
  key: string;
  label: string;
  total: number;
  output: number;
  requests: number;
  lastSeen: string;
}

/** [labelA, labelB, sharedDays], labelA < labelB. */
export type Link = [string, string, number];

export interface Star extends StarInput {
  x: number;
  y: number;
  /** Side of the rounded square, px. */
  size: number;
  /** 0 to 4, the fixed log bucket. */
  bucket: number;
  brightness: number;
  hue: number;
  active: boolean;
}

export interface Layout {
  stars: Star[];
  links: { a: number; b: number; w: number }[];
  /** Projects that exist but did not fit under the cap. */
  more: number;
  width: number;
  height: number;
}

export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const HALF_LIFE_DAYS = 7;
const BRIGHTNESS_FLOOR = 0.12;
const ITERATIONS = 60;
const MAX_LINK_WEIGHT = 5;

/** 32-bit FNV-1a, the same hash color.ts uses for clients with no colour. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Fixed log bucket: <10M, <100M, <1B, <10B, 10B and up. */
export function bucketOf(total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(4, Math.floor(Math.log10(total)) - 6));
}

export function brightnessOf(lastSeen: string, now: number): number {
  const t = Date.parse(lastSeen);
  if (!Number.isFinite(t)) return BRIGHTNESS_FLOOR;
  const days = Math.max(0, now - t) / 86_400_000;
  return Math.max(BRIGHTNESS_FLOOR, Math.pow(0.5, days / HALF_LIFE_DAYS));
}

/** How many stars a panel of this size can hold legibly. 6 to 40. */
export function maxStarsFor(width: number, height: number): number {
  return Math.max(6, Math.min(40, Math.floor((width * height) / 9000)));
}

/**
 * Links from sessions. `labelOf` maps a session's working directory to the
 * project label, or null to leave it out.
 */
export function buildLinks(
  sessions: Iterable<{ start?: string; end?: string; cwd?: string | null }>,
  labelOf: (cwd: string) => string | null,
): Link[] {
  const byDay = new Map<string, Set<string>>();
  for (const s of sessions) {
    if (!s?.cwd) continue;
    const label = labelOf(s.cwd);
    if (!label) continue;
    for (const ts of [s.start, s.end]) {
      const ms = ts ? Date.parse(ts) : NaN;
      if (!Number.isFinite(ms)) continue;
      const day = localDayKey(ms);
      let set = byDay.get(day);
      if (!set) byDay.set(day, (set = new Set()));
      set.add(label);
    }
  }
  const counts = new Map<string, number>();
  for (const set of byDay.values()) {
    const labels = [...set].sort();
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const k = `${labels[i]}\u0000${labels[j]}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  return [...counts]
    .map(([k, n]) => {
      const [a, b] = k.split('\u0000');
      return [a, b, n] as Link;
    })
    .sort((x, y) => y[2] - x[2] || (x[0] + x[1]).localeCompare(y[0] + y[1]));
}

/**
 * Lay the sky out in a box of `width` x `height` px.
 *
 * Deterministic: the same input gives the same positions to the pixel, like
 * the client wall's layout engine. Starting points come from a hash of each
 * label; a short, fixed simulation then pushes stars apart and pulls linked
 * ones together. Everything iterates in label order so input order is
 * irrelevant.
 */
export function layoutConstellation(input: {
  stars: StarInput[];
  links: Link[];
  activeLabel: string | null;
  now: number;
  width: number;
  height: number;
  maxStars?: number;
}): Layout {
  const { width, height, now } = input;
  const cap = input.maxStars ?? maxStarsFor(width, height);
  const ranked = input.stars
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  const shown = ranked.slice(0, cap).sort((a, b) => a.label.localeCompare(b.label));
  const more = ranked.length - shown.length;
  if (!shown.length || width <= 0 || height <= 0) {
    return { stars: [], links: [], more, width, height };
  }

  const index = new Map(shown.map((s, i) => [s.label, i]));
  const links = input.links
    .filter(([a, b]) => index.has(a) && index.has(b) && a !== b)
    .map(([a, b, n]) => ({ a: index.get(a)!, b: index.get(b)!, w: Math.min(MAX_LINK_WEIGHT, n) }));

  // Unit space stretched to the box's aspect, so a wide panel gets a wide sky.
  const aspect = width / height;
  const n = shown.length;
  const pos = shown.map((s) => {
    const h = fnv1a(s.label);
    const angle = ((h & 0xffff) / 0xffff) * Math.PI * 2;
    const radius = 0.25 + (((h >>> 16) & 0xffff) / 0xffff) * 0.75;
    return { x: Math.cos(angle) * radius * aspect, y: Math.sin(angle) * radius };
  });

  if (n > 1) {
    const ideal = Math.sqrt((4 * aspect) / n) * 0.9;
    for (let it = 0; it < ITERATIONS; it++) {
      const cool = 1 - it / ITERATIONS;
      const dx = new Array(n).fill(0);
      const dy = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let ex = pos[i].x - pos[j].x;
          let ey = pos[i].y - pos[j].y;
          let d = Math.hypot(ex, ey);
          if (d < 1e-6) {
            // Identical points: separate along a direction fixed by the pair.
            const a = (fnv1a(shown[i].label + shown[j].label) / 0xffffffff) * Math.PI * 2;
            ex = Math.cos(a);
            ey = Math.sin(a);
            d = 1e-3;
          }
          const f = (ideal * ideal) / d;
          dx[i] += (ex / d) * f;
          dy[i] += (ey / d) * f;
          dx[j] -= (ex / d) * f;
          dy[j] -= (ey / d) * f;
        }
      }
      for (const l of links) {
        const ex = pos[l.a].x - pos[l.b].x;
        const ey = pos[l.a].y - pos[l.b].y;
        const d = Math.max(1e-6, Math.hypot(ex, ey));
        const f = ((d * d) / ideal) * (0.3 + 0.14 * l.w);
        dx[l.a] -= (ex / d) * f;
        dy[l.a] -= (ey / d) * f;
        dx[l.b] += (ex / d) * f;
        dy[l.b] += (ey / d) * f;
      }
      const step = 0.1 * cool * ideal;
      for (let i = 0; i < n; i++) {
        // A gentle pull to the centre keeps unlinked stars from drifting off.
        dx[i] -= pos[i].x * 0.4;
        dy[i] -= pos[i].y * 0.4;
        const m = Math.hypot(dx[i], dy[i]);
        if (m > 0) {
          pos[i].x += (dx[i] / m) * Math.min(m, step);
          pos[i].y += (dy[i] / m) * Math.min(m, step);
        }
      }
    }
  }

  // Fit into the box, leaving room for a label under the lowest star and for
  // the biggest star at the edges.
  const base = Math.min(width, height);
  const sizes = [0.034, 0.045, 0.058, 0.072, 0.09].map((f) => Math.max(6, base * f));
  const padX = Math.max(sizes[4], width * 0.08);
  const padTop = sizes[4] * 0.6 + 4;
  const padBottom = sizes[4] * 0.6 + Math.max(12, base * 0.09);
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  // A few stars stretched to the corners leave an empty middle and read as a
  // layout fault, so a small sky only uses part of the box, centred. It grows
  // to the full box by about seven stars.
  const fill = Math.min(1, 0.35 + n * 0.095);
  const fullW = Math.max(1, width - padX * 2);
  const fullH = Math.max(1, height - padTop - padBottom);
  const innerW = fullW * fill;
  const innerH = fullH * fill;
  const offX = padX + (fullW - innerW) / 2;
  const offY = padTop + (fullH - innerH) / 2;

  const activeOk = input.activeLabel !== null;
  const stars: Star[] = shown.map((s, i) => {
    const bucket = bucketOf(s.total);
    return {
      ...s,
      x: n === 1 ? width / 2 : offX + ((pos[i].x - minX) / spanX) * innerW,
      y: n === 1 ? height / 2 : offY + ((pos[i].y - minY) / spanY) * innerH,
      size: sizes[bucket],
      bucket,
      brightness: brightnessOf(s.lastSeen, now),
      hue: (fnv1a(s.key || s.label) * 137.508) % 360,
      active: activeOk && s.label === input.activeLabel,
    };
  });

  return { stars, links, more, width, height };
}

/** The star under a point, preferring the smallest if two overlap. */
export function hitTest(layout: Layout, x: number, y: number): Star | null {
  let best: Star | null = null;
  for (const s of layout.stars) {
    const half = s.size / 2 + 4;
    if (Math.abs(x - s.x) <= half && Math.abs(y - s.y) <= half) {
      if (!best || s.size < best.size) best = s;
    }
  }
  return best;
}

/**
 * Which stars get a text label: biggest first, skipping any whose label would
 * overlap one already placed or leave the box. `measure` returns a label's
 * width in px at the drawing font. Returns label boxes, so the render test can
 * check them without a canvas.
 */
export function placeLabels(
  layout: Layout,
  measure: (text: string) => number,
  fontPx: number,
  maxLabels: number,
): { star: number; x: number; y: number; w: number; h: number }[] {
  const order = layout.stars
    .map((s, i) => i)
    .sort((a, b) => layout.stars[b].size - layout.stars[a].size || layout.stars[a].label.localeCompare(layout.stars[b].label));
  const placed: { star: number; x: number; y: number; w: number; h: number }[] = [];
  const h = Math.ceil(fontPx * 1.25);
  for (const i of order) {
    if (placed.length >= maxLabels) break;
    const s = layout.stars[i];
    const w = Math.ceil(measure(s.label));
    // Centred under the star, then slid inside the box if it would run off an
    // edge. Skipping it instead lost exactly the stars at the edges of the sky.
    const x = Math.round(Math.max(0, Math.min(s.x - w / 2, layout.width - w)));
    const y = Math.round(s.y + s.size / 2 + 3);
    if (w > layout.width || y + h > layout.height) continue;
    const hitsLabel = placed.some((p) => x < p.x + p.w + 4 && x + w + 4 > p.x && y < p.y + p.h && y + h > p.y);
    const hitsStar = layout.stars.some(
      (o, k) => k !== i && x < o.x + o.size / 2 && x + w > o.x - o.size / 2 && y < o.y + o.size / 2 && y + h > o.y - o.size / 2,
    );
    if (hitsLabel || hitsStar) continue;
    placed.push({ star: i, x, y, w, h });
  }
  return placed;
}
