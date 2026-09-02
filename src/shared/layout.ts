/**
 * The wall layout engine.
 *
 * GOAL: cards that look intentionally composed, never a uniform grid and never
 * a ragged scatter, at any client count from 5 to 40 and any resolution from a
 * 1920x1080 laptop to a 4K workstation.
 *
 * APPROACH: justified row packing on a discrete column grid, which is the same
 * family as a photo gallery's justified layout but snapped to grid units so the
 * result reads as a bento composition rather than a photo strip.
 *
 * Rejected alternatives, and why:
 *
 *  - Uniform CSS grid. Trivially stable, but it is exactly the "spreadsheet on
 *    the desktop" the wall must not be. No visual hierarchy.
 *  - Masonry / column-flow. Produces ragged bottoms and orphaned columns, and
 *    reading order becomes vertical which fights the importance ordering.
 *  - Skyline / MaxRects bin packing. Genuinely packs tighter, but leaves
 *    awkward tall slivers and its output changes discontinuously when one item
 *    resizes, which breaks the stability requirement below.
 *  - Force-directed or random placement. Looks scattered, is not deterministic,
 *    and reshuffles on every launch.
 *
 * STABILITY is a first-class requirement: editing one client must not reshuffle
 * the wall. Two mechanisms deliver it:
 *   1. Size comes from a TIER (a bucket), not from the raw score. A revenue
 *      nudge moves the score continuously but the tier, and therefore the
 *      layout, only changes when it crosses a bucket boundary.
 *   2. Ordering is a total order with an immutable tie-break (the client id),
 *      so equal scores never swap between runs.
 */

export type Tier = 'hero' | 'large' | 'medium' | 'small';

/** Tile footprint in grid units. Height only sets the row height floor. */
export const TILE: Record<Tier, { w: number; h: number }> = {
  hero: { w: 6, h: 4 },
  large: { w: 4, h: 3 },
  medium: { w: 3, h: 2 },
  small: { w: 2, h: 2 },
};

export type Density = 'comfortable' | 'compact' | 'dense';

export interface LayoutInput {
  id: string;
  /** 'active' | 'prospect' | 'past' | 'archived' etc. See schema.ts. */
  state: string;
  revenue: number | null;
  progress: number | null;
  /** ISO date of last interaction, or null. */
  lastInteraction: string | null;
  /** Forces the top tier regardless of score. */
  featured?: boolean;
}

export interface PlacedCard {
  id: string;
  tier: Tier;
  score: number;
  /** Grid coordinates, in columns and row units. */
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  /** Resolved pixel box, relative to the wall container. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Deterministic 0..n index, used to stagger entrance animation. */
  order: number;
  /** Which ambient page this card lives on. 0 when everything fits at once. */
  page: number;
}

export interface LayoutResult {
  cards: PlacedCard[];
  cols: number;
  rowUnit: number;
  density: Density;
  totalHeight: number;
  /** Number of ambient pages. 1 means the whole wall fits on screen. */
  pageCount: number;
  /** Set when cards had to shrink past the comfortable legibility floor. */
  overflowed: boolean;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Multiplier on the target column width. Lower packs more cards in. */
  densityScale?: number;
  gap?: number;
  padding?: number;
  /** Reference date for recency scoring. Injected so tests are deterministic. */
  now?: Date;
}

// Scoring weights. They sum to 1.0.
const W_STATUS = 0.42;
const W_REVENUE = 0.24;
const W_RECENCY = 0.22;
const W_PROGRESS = 0.12;

const STATUS_WEIGHT: Record<string, number> = {
  active: 1.0,
  current: 0.9,
  prospect: 0.55,
  paused: 0.5,
  past: 0.35,
  completed: 0.35,
  archived: 0.12,
};

/** Recency half-life in days. A client untouched for 45 days is worth half. */
const RECENCY_HALF_LIFE = 45;

const TARGET_COL_PX = 200;
const MIN_COLS = 6;
const MAX_COLS = 16;

// Below these card heights the full card composition stops being readable and
// the renderer switches to a reduced one.
const COMPACT_BELOW_PX = 190;
const DENSE_BELOW_PX = 130;

/**
 * Legibility floor for one grid row unit. A 'small' tile is 2 units, so this
 * keeps the smallest card at roughly 124px tall, below which the composition
 * (name, status, metric, progress) stops fitting honestly.
 */
const MIN_ROW_UNIT = 62;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Importance score in 0..1. Quantised to 4 decimals so floating point noise can
 * never reorder two otherwise-equal clients between runs.
 */
export function scoreClient(input: LayoutInput, now: Date, maxRevenue: number): number {
  const status = STATUS_WEIGHT[input.state] ?? 0.4;

  const revenue =
    maxRevenue > 0 && typeof input.revenue === 'number' && input.revenue > 0
      ? Math.log1p(input.revenue) / Math.log1p(maxRevenue)
      : 0;

  let recency = 0;
  if (input.lastInteraction) {
    const then = Date.parse(input.lastInteraction);
    if (!Number.isNaN(then)) {
      const days = Math.max(0, (now.getTime() - then) / 86_400_000);
      recency = Math.pow(0.5, days / RECENCY_HALF_LIFE);
    }
  }

  // Work visibly in flight is more interesting than work at 0% or 100%.
  let progress = 0;
  if (typeof input.progress === 'number') {
    const p = clamp(input.progress, 0, 100);
    progress = p > 5 && p < 98 ? 1 : 0.25;
  }

  const raw = W_STATUS * status + W_REVENUE * revenue + W_RECENCY * recency + W_PROGRESS * progress;
  return Math.round(raw * 10_000) / 10_000;
}

/**
 * Assign tiers by RANK, not by absolute score threshold.
 *
 * Rank-based assignment guarantees the wall always has visual variety: with
 * absolute thresholds, a set of uniformly dormant clients would render as 40
 * identical small tiles, and a set of uniformly hot ones as 40 heroes.
 */
export function assignTiers(ordered: { id: string; score: number; featured?: boolean }[]): Map<string, Tier> {
  const n = ordered.length;
  const tiers = new Map<string, Tier>();
  if (n === 0) return tiers;

  const heroCount = clamp(Math.round(n * 0.1), 1, 3);
  const largeCount = clamp(Math.round(n * 0.22), 1, 8);
  const mediumCount = Math.round(n * 0.38);

  ordered.forEach((c, i) => {
    let tier: Tier;
    if (i < heroCount) tier = 'hero';
    else if (i < heroCount + largeCount) tier = 'large';
    else if (i < heroCount + largeCount + mediumCount) tier = 'medium';
    else tier = 'small';
    // An explicitly featured client is never demoted below 'large'.
    if (c.featured && tier !== 'hero') tier = 'large';
    tiers.set(c.id, tier);
  });

  return tiers;
}

interface Row {
  items: { id: string; tier: Tier; score: number; span: number }[];
  height: number;
}

/**
 * Pack ordered cards into justified rows.
 *
 * Greedy fill, then distribute leftover columns so every row ends flush. A card
 * may grow by at most 100% of its natural width; if a short trailing row cannot
 * absorb the slack within that cap it is centred instead of stretched, which
 * avoids the one-tiny-card-stretched-across-the-whole-wall failure.
 */
function packRows(items: { id: string; tier: Tier; score: number }[], cols: number): Row[] {
  const rows: Row[] = [];
  let current: Row = { items: [], height: 0 };
  let used = 0;

  const flush = () => {
    if (current.items.length === 0) return;
    rows.push(current);
    current = { items: [], height: 0 };
    used = 0;
  };

  for (const item of items) {
    const tile = TILE[item.tier];
    const span = Math.min(tile.w, cols);
    if (used + span > cols) flush();
    current.items.push({ ...item, span });
    current.height = Math.max(current.height, tile.h);
    used += span;
  }
  flush();

  // Justify each row.
  for (const row of rows) {
    let slack = cols - row.items.reduce((s, i) => s + i.span, 0);
    if (slack <= 0) continue;

    // Widest first, so the composition keeps its emphasis.
    const growable = [...row.items].sort((a, b) => b.span - a.span || a.id.localeCompare(b.id));
    const cap = new Map(growable.map((i) => [i.id, TILE[i.tier].w]));

    let progressed = true;
    while (slack > 0 && progressed) {
      progressed = false;
      for (const item of growable) {
        if (slack === 0) break;
        if (item.span - TILE[item.tier].w >= (cap.get(item.id) ?? 0)) continue; // hit +100%
        item.span += 1;
        slack -= 1;
        progressed = true;
      }
    }
    // Anything still left is handled by centring at render time.
    row.items.forEach((i) => {
      const grown = growable.find((g) => g.id === i.id);
      if (grown) i.span = grown.span;
    });
  }

  return rows;
}

/** Compute the full wall layout. Pure and deterministic. */
export function computeLayout(inputs: LayoutInput[], opts: LayoutOptions): LayoutResult {
  const now = opts.now ?? new Date();
  const gap = opts.gap ?? 14;
  const padding = opts.padding ?? 28;
  const densityScale = opts.densityScale ?? 1;

  if (inputs.length === 0) {
    return {
      cards: [],
      cols: MIN_COLS,
      rowUnit: 0,
      density: 'comfortable',
      totalHeight: 0,
      pageCount: 0,
      overflowed: false,
    };
  }

  const maxRevenue = inputs.reduce((m, i) => Math.max(m, i.revenue ?? 0), 0);

  const scored = inputs.map((i) => ({
    id: i.id,
    score: scoreClient(i, now, maxRevenue),
    featured: i.featured,
  }));

  // Total order: score desc, then id asc. The id tie-break is what makes the
  // layout byte-identical across launches.
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const tiers = assignTiers(scored);
  const items = scored.map((s) => ({ id: s.id, tier: tiers.get(s.id) as Tier, score: s.score }));

  // Column count follows physical width, so a card is roughly the same physical
  // size on a 1080p laptop and a 4K monitor rather than being scaled up.
  const rawCols = Math.round(opts.width / (TARGET_COL_PX * densityScale));
  const cols = clamp(rawCols % 2 === 0 ? rawCols : rawCols + 1, MIN_COLS, MAX_COLS);

  const allRows = packRows(items, cols);

  const availableW = opts.width - padding * 2;
  const availableH = opts.height - padding * 2;
  const colWidth = (availableW - gap * (cols - 1)) / cols;

  // PAGINATION. Squeezing 40 clients onto one 1080p screen yields 41px cards:
  // it technically fits and is completely unreadable. Past a legibility floor
  // the wall stops shrinking and instead becomes a slow ambient rotation
  // between full-size pages, which suits a wall that is looked at rather than
  // scrolled. Each page is then re-justified to fill the screen exactly.
  const maxRowUnitsPerPage = Math.max(
    TILE.hero.h,
    Math.floor((availableH + gap) / (MIN_ROW_UNIT + gap)),
  );

  const pages: Row[][] = [];
  let page: Row[] = [];
  let pageUnits = 0;
  for (const row of allRows) {
    if (page.length > 0 && pageUnits + row.height > maxRowUnitsPerPage) {
      pages.push(page);
      page = [];
      pageUnits = 0;
    }
    page.push(row);
    pageUnits += row.height;
  }
  if (page.length > 0) pages.push(page);
  if (pages.length === 0) pages.push([]);

  const cards: PlacedCard[] = [];
  let order = 0;
  let rowUnitOut = 0;
  let maxPageHeight = 0;

  pages.forEach((pageRows, pageIndex) => {
    const pageUnitTotal = pageRows.reduce((s, r) => s + r.height, 0);
    const rowUnit = pageUnitTotal > 0 ? (availableH - gap * (pageRows.length - 1)) / pageUnitTotal : 0;
    if (pageIndex === 0) rowUnitOut = rowUnit;

    let y = padding;
    let rowStart = 0;

    for (const row of pageRows) {
      const usedCols = row.items.reduce((s, i) => s + i.span, 0);
      // Centre a row that could not be justified within the growth cap.
      const rowOffset = ((cols - usedCols) * (colWidth + gap)) / 2;
      const rowHeightPx = row.height * rowUnit;
      let col = 0;

      for (const item of row.items) {
        cards.push({
          id: item.id,
          tier: item.tier,
          score: item.score,
          page: pageIndex,
          col,
          row: rowStart,
          colSpan: item.span,
          rowSpan: row.height,
          x: padding + rowOffset + col * (colWidth + gap),
          y,
          width: item.span * colWidth + (item.span - 1) * gap,
          height: rowHeightPx,
          order: order++,
        });
        col += item.span;
      }

      y += rowHeightPx + gap;
      rowStart += row.height;
    }
    maxPageHeight = Math.max(maxPageHeight, y - gap - padding);
  });

  const shortest = cards.reduce((m, c) => Math.min(m, c.height), Infinity);
  const density: Density =
    shortest < DENSE_BELOW_PX ? 'dense' : shortest < COMPACT_BELOW_PX ? 'compact' : 'comfortable';

  return {
    cards,
    cols,
    rowUnit: rowUnitOut,
    density,
    totalHeight: maxPageHeight,
    pageCount: pages.length,
    overflowed: false,
  };
}
