/**
 * Renderer entry.
 *
 * RENDER MODEL: cards are created once and then only mutated in place. A data
 * change diffs against the existing DOM and touches only what changed, because
 * tearing down and rebuilding forty cards would restart every entrance
 * animation and spike the GPU on a machine that must idle at zero.
 *
 * All positioning is absolute, driven by the layout engine, and applied as
 * `transform: translate3d()` plus explicit width/height. Transform keeps
 * repositioning on the compositor.
 */

import { computeLayout, type PlacedCard } from '../shared/layout';
import { deriveBrandTokens, type BrandTokens } from '../shared/color';
import type { Client } from '../shared/schema';
import type { UsageIndex } from '../main/data/usage';
import { StatsView } from './stats';

// ── Types mirrored from main ───────────────────────────────────────────────

interface WallState {
  clients: Client[];
  problems: { id: string; file: string | null; issues: { field: string; message: string; severity: string }[] }[];
  vault: { available: boolean; reason?: string; scanned: number; matched: number };
  settings: {
    densityScale: number;
    pageRotateSeconds: number;
    debug: boolean;
    layerMode: string;
    clickThrough: boolean;
    opacity: number;
    background: 'none' | 'plain' | 'gradient';
    backgroundOpacity: number;
  };
  capability: { tier: 'low' | 'balanced' | 'high'; cores: number; memoryGb: number; gpuAccelerated: boolean; reasons: string[] };
  focusMode: boolean;
  mode: 'stats' | 'clients';
  appVersion: string;
  display: { id: number; width: number; height: number; scaleFactor: number; isPrimary: boolean; index: number; total: number } | null;
  win32: { available: boolean; reason: string | null };
}

declare global {
  interface Window {
    wall: {
      getState(): Promise<WallState | null>;
      updateSettings(patch: unknown): Promise<void>;
      reload(): Promise<void>;
      toggleFocus(): Promise<void>;
      openExternal(url: string): Promise<void>;
      onState(cb: (state: WallState) => void): () => void;
      onDebugOpenDetail(cb: (id: string) => void): void;
      getUsage(): Promise<UsageIndex | null>;
      setMode(mode: string): Promise<void>;
      onUsage(cb: (usage: UsageIndex) => void): () => void;
    };
  }
}

// ── State ──────────────────────────────────────────────────────────────────

const wallEl = document.getElementById('wall') as HTMLDivElement;
const statsMount = document.getElementById('view-stats') as HTMLDivElement;
const clientsView = document.getElementById('view-clients') as HTMLDivElement;
const switchEl = document.getElementById('mode-switch') as HTMLElement;
const detailEl = document.getElementById('detail') as HTMLDivElement;
const diagEl = document.getElementById('diagnostics') as HTMLPreElement;

let state: WallState | null = null;
const cardEls = new Map<string, HTMLElement>();
const brandCache = new Map<string, { key: string; tokens: BrandTokens }>();
const pageEls: HTMLElement[] = [];
let currentPage = 0;
let pageTimer: number | null = null;
let firstRender = true;
let mode: 'stats' | 'clients' = 'stats';
const statsView = new StatsView();
statsMount.appendChild(statsView.root);

// ── Formatting ─────────────────────────────────────────────────────────────

const CURRENCY_SYMBOL: Record<string, string> = { ZAR: 'R', USD: '$', EUR: '€', GBP: '£' };

function formatMoney(value: number | null, currency: string): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const abs = Math.abs(value);
  // Compact above 100k so a hero card never wraps its headline number.
  if (abs >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (abs >= 100_000) return `${symbol}${Math.round(value / 1000)}k`;
  return `${symbol}${value.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(iso: string | null, withDay = false): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return withDay
    ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
    : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDuration(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const a = new Date(start);
  const b = end ? new Date(end) : new Date();
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const months = Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
  if (months < 1) {
    const days = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86_400_000));
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem ? `${years}y ${rem}m` : `${years} year${years === 1 ? '' : 's'}`;
}

function relativeDays(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/**
 * Initials for the logo slot and the watermark.
 *
 * Real client names broke the naive "first two letters" version: B2MX became
 * "B2", PixelPlay became "PI", SnowAndGoBack became "SN". So:
 *   - An existing short acronym is already a monogram. Keep it whole (NVRC, B2MX).
 *   - Multiple words give first and last initials (Grace Allen -> GA).
 *   - A single camelCase word is split on its capitals (PixelPlay -> PP).
 */
function monogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';

  // Already an acronym: all caps, optional digits, short enough to show as is.
  if (/^[A-Z0-9]{2,4}$/.test(trimmed)) return trimmed;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[words.length - 1][0]).toUpperCase();

  // Single word: split on camelCase boundaries.
  const parts = words[0].split(/(?=[A-Z])/).filter((w) => w.length > 0);
  if (parts.length > 1) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}

/** Everything from client data goes through here. Never innerHTML. */
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

// ── Brand tokens ───────────────────────────────────────────────────────────

function tokensFor(client: Client): BrandTokens {
  const key = `${client.branding.primary ?? ''}|${client.branding.secondary ?? ''}`;
  const cached = brandCache.get(client.id);
  if (cached && cached.key === key) return cached.tokens;
  const tokens = deriveBrandTokens(client.id, client.branding);
  brandCache.set(client.id, { key, tokens });
  return tokens;
}

function applyTokens(node: HTMLElement, t: BrandTokens): void {
  node.style.setProperty('--c-surface', t.surface);
  node.style.setProperty('--c-surface-raised', t.surfaceRaised);
  node.style.setProperty('--c-border', t.border);
  node.style.setProperty('--c-fg', t.fg);
  node.style.setProperty('--c-fg-muted', t.fgMuted);
  node.style.setProperty('--c-accent', t.accent);
  node.style.setProperty('--c-accent-fg', t.accentFg);
  node.style.setProperty('--c-glow', t.glow);
  node.style.setProperty('--c-hue', String(t.hue));
}

const KIND_LABEL: Record<string, string> = {
  client: 'Client',
  product: 'Own product',
  infrastructure: 'Infrastructure',
  personal: 'Personal',
};

const STATE_LABEL: Record<string, string> = {
  active: 'Active',
  prospect: 'Prospect',
  paused: 'Paused',
  past: 'Completed',
  archived: 'Archived',
};

// ── Card construction ──────────────────────────────────────────────────────

function buildCard(client: Client): HTMLElement {
  const card = el('div', 'card');
  card.dataset.id = client.id;
  card.tabIndex = -1;

  card.appendChild(el('div', 'edge-light'));
  // Oversized monogram, very low opacity, behind the content. Gives sparse
  // cards (a prospect with three fields) presence instead of a void, and gives
  // every client a second, quieter appearance of its own mark.
  card.appendChild(el('div', 'watermark', monogram(client.name)));
  const inner = el('div', 'card-inner');

  // Header
  const head = el('div', 'card-head');
  const identity = el('div', 'identity');
  identity.appendChild(el('div', 'client-name', client.name));
  const sub = client.company ?? client.industry;
  if (sub) identity.appendChild(el('div', 'client-company', sub));
  head.appendChild(identity);

  const logo = el('div', 'logo');
  if (client.branding.logo) {
    const img = el('img');
    img.alt = '';
    img.src = `mbw-asset://${encodeURI(client.branding.logo)}`;
    // A missing logo file falls back to the monogram rather than a broken icon.
    img.addEventListener('error', () => {
      logo.textContent = '';
      const fb = el('span', 'monogram', monogram(client.name));
      fb.dataset.len = String(monogram(client.name).length);
      logo.appendChild(fb);
    });
    logo.appendChild(img);
  } else {
    const m = el('span', 'monogram', monogram(client.name));
    m.dataset.len = String(monogram(client.name).length);
    logo.appendChild(m);
  }
  head.appendChild(logo);
  inner.appendChild(head);

  // Status, plus what kind of work this is. The kind label is deliberately
  // quiet: it disambiguates without competing with the client's own identity.
  const statusRow = el('div', 'status-row');
  const status = el('div', 'status');
  status.dataset.state = client.state;
  status.appendChild(el('span', 'dot'));
  status.appendChild(el('span', undefined, STATE_LABEL[client.state] ?? client.state));
  statusRow.appendChild(status);
  if (client.kind && client.kind !== 'client') {
    statusRow.appendChild(el('span', 'kind', KIND_LABEL[client.kind] ?? client.kind));
  }
  inner.appendChild(statusRow);

  // Headline. Sits directly under the status so tall cards read as two
  // deliberate blocks (identity, then measurements) rather than one block and
  // a void.
  if (client.project) inner.appendChild(el('div', 'project', client.project));

  // Body: the measurements, pinned to the bottom edge.
  const body = el('div', 'card-body');

  const metrics = el('div', 'metrics');
  const addMetric = (value: string | null, label: string) => {
    if (!value) return;
    const m = el('div', 'metric');
    m.appendChild(el('div', 'value', value));
    m.appendChild(el('div', 'label', label));
    metrics.appendChild(m);
  };
  addMetric(formatMoney(client.revenue, client.currency), 'Value');
  addMetric(formatDuration(client.startDate, client.endDate), 'Duration');
  addMetric(client.hours != null ? `${client.hours}h` : null, 'Hours');
  addMetric(client.deliverables != null ? String(client.deliverables) : null, 'Deliverables');
  if (metrics.childElementCount) body.appendChild(metrics);

  if (client.progress != null) {
    const progress = el('div', 'progress');
    const phead = el('div', 'progress-head');
    phead.appendChild(el('span', 'label', client.currentPhase ?? 'Progress'));
    phead.appendChild(el('span', 'progress-value', `${Math.round(client.progress)}%`));
    progress.appendChild(phead);
    const track = el('div', 'progress-track');
    const fill = el('div', 'progress-fill');
    fill.style.setProperty('--p', String(client.progress / 100));
    track.appendChild(fill);
    progress.appendChild(track);
    body.appendChild(progress);
  } else if (client.currentPhase) {
    // No percentage on file. Show the real phase text instead of nothing: it
    // carries the same meaning honestly, and without it the card has a hole
    // where the progress rule would have been.
    const phase = el('div', 'phase');
    phase.appendChild(el('div', 'label', 'Phase'));
    phase.appendChild(el('div', 'phase-value', client.currentPhase));
    body.appendChild(phase);
  }
  inner.appendChild(body);

  // Footer
  const foot = el('div', 'card-foot');
  const last = relativeDays(client.lastInteraction);
  foot.appendChild(el('span', undefined, last ? `Last activity ${last}` : client.projectType ?? ''));
  if (client.startDate) foot.appendChild(el('span', undefined, formatDate(client.startDate)));
  inner.appendChild(foot);

  card.appendChild(inner);
  return card;
}

/** Rebuild a card's contents in place, preserving the element and its position. */
function updateCard(card: HTMLElement, client: Client): void {
  const fresh = buildCard(client);
  card.replaceChildren(...Array.from(fresh.childNodes));
}

// ── Hover edge light ───────────────────────────────────────────────────────

/**
 * Cursor tracking for the edge glow.
 *
 * One rAF for the whole wall, not one per card, and it only runs while a card
 * is hovered. Two custom properties are written per frame; nothing reads back
 * from layout, so this never forces a synchronous reflow.
 */
let hoveredCard: HTMLElement | null = null;
let pointerX = 0;
let pointerY = 0;
let rafId = 0;

function pumpEdgeLight(): void {
  rafId = 0;
  const card = hoveredCard;
  if (!card) return;
  const r = card.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const angle = (Math.atan2(pointerY - cy, pointerX - cx) * 180) / Math.PI + 90;

  // Proximity to the nearest edge, 0 at centre and 100 at the border.
  const nx = Math.abs((pointerX - cx) / (r.width / 2));
  const ny = Math.abs((pointerY - cy) / (r.height / 2));
  const proximity = Math.min(100, Math.max(nx, ny) * 100);

  card.style.setProperty('--cursor-angle', `${angle.toFixed(1)}deg`);
  card.style.setProperty('--edge-proximity', proximity.toFixed(1));
}

function onPointerMove(e: PointerEvent): void {
  pointerX = e.clientX;
  pointerY = e.clientY;
  const card = (e.target as HTMLElement | null)?.closest?.('.card') as HTMLElement | null;
  if (card !== hoveredCard) {
    hoveredCard?.style.removeProperty('--edge-proximity');
    hoveredCard = card;
  }
  if (hoveredCard && !rafId) rafId = requestAnimationFrame(pumpEdgeLight);
}

// ── Detail view ────────────────────────────────────────────────────────────

function openDetail(client: Client): void {
  const tokens = tokensFor(client);
  detailEl.replaceChildren();
  applyTokens(detailEl, tokens);

  const scrim = el('div', 'detail-scrim');
  scrim.addEventListener('click', closeDetail);
  detailEl.appendChild(scrim);

  const panel = el('div', 'detail-panel');

  const close = el('button', 'detail-close', '×');
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeDetail);
  panel.appendChild(close);

  // Left: identity and headline stats.
  const main = el('div', 'detail-main');
  main.appendChild(el('div', 'detail-watermark', monogram(client.name)));
  const status = el('div', 'status');
  status.dataset.state = client.state;
  status.appendChild(el('span', 'dot'));
  status.appendChild(el('span', undefined, STATE_LABEL[client.state] ?? client.state));
  status.style.position = 'relative';
  status.style.zIndex = '1';
  main.appendChild(status);

  const nameEl = el('h1', 'detail-name', client.name);
  nameEl.style.zIndex = '1';
  main.appendChild(nameEl);
  const subtitle = [client.company, client.industry].filter(Boolean).join('  ·  ');
  if (subtitle) main.appendChild(el('div', 'detail-company', subtitle));

  const spacer = el('div');
  spacer.style.flex = '1';
  main.appendChild(spacer);

  const stats = el('div', 'detail-stats');
  const addStat = (value: string | null, label: string) => {
    if (!value) return;
    const s = el('div', 'detail-stat');
    s.appendChild(el('div', 'value', value));
    s.appendChild(el('div', 'label', label));
    stats.appendChild(s);
  };
  addStat(formatMoney(client.revenue, client.currency), 'Project value');
  addStat(client.progress != null ? `${Math.round(client.progress)}%` : null, 'Progress');
  addStat(formatDuration(client.startDate, client.endDate), 'Duration');
  addStat(client.hours != null ? `${client.hours}` : null, 'Hours logged');
  addStat(client.deliverables != null ? String(client.deliverables) : null, 'Deliverables');
  stats.style.position = 'relative';
  stats.style.zIndex = '1';
  main.appendChild(stats);
  panel.appendChild(main);

  // Right: the narrative column.
  const side = el('div', 'detail-side');
  const addBlock = (label: string, value: string | null) => {
    if (!value) return;
    const b = el('div');
    b.appendChild(el('div', 'label', label));
    const v = el('div', 'detail-notes', value);
    v.style.marginTop = '7px';
    v.style.color = 'var(--c-fg)';
    b.appendChild(v);
    side.appendChild(b);
  };
  addBlock('Project', client.project);
  addBlock('Type', client.projectType);
  addBlock('Current phase', client.currentPhase);
  addBlock(
    'Timeline',
    [formatDate(client.startDate, true), client.endDate ? formatDate(client.endDate, true) : 'ongoing']
      .filter(Boolean)
      .join('  →  ') || null,
  );
  addBlock('Last activity', formatDate(client.lastInteraction, true));

  if (client.notes) {
    const b = el('div');
    b.appendChild(el('div', 'label', 'Notes'));
    const n = el('div', 'detail-notes', client.notes);
    n.style.marginTop = '7px';
    b.appendChild(n);
    side.appendChild(b);
  }

  if (client.tags.length) {
    const b = el('div');
    b.appendChild(el('div', 'label', 'Tags'));
    const wrap = el('div', 'detail-links');
    wrap.style.marginTop = '9px';
    for (const tag of client.tags) wrap.appendChild(el('span', 'detail-link', tag));
    b.appendChild(wrap);
    side.appendChild(b);
  }

  if (client.links.length) {
    const b = el('div');
    b.appendChild(el('div', 'label', 'Links'));
    const wrap = el('div', 'detail-links');
    wrap.style.marginTop = '9px';
    for (const link of client.links) {
      const a = el('button', 'detail-link', link.label || link.url);
      a.addEventListener('click', () => void window.wall.openExternal(link.url));
      wrap.appendChild(a);
    }
    b.appendChild(wrap);
    side.appendChild(b);
  }

  panel.appendChild(side);
  detailEl.appendChild(panel);
  detailEl.setAttribute('data-open', '');
  detailEl.setAttribute('aria-hidden', 'false');
  stopPageRotation();
}

function closeDetail(): void {
  detailEl.removeAttribute('data-open');
  detailEl.setAttribute('aria-hidden', 'true');
  window.setTimeout(() => detailEl.replaceChildren(), 400);
  startPageRotation();
}

// ── Pagination ─────────────────────────────────────────────────────────────

function stopPageRotation(): void {
  if (pageTimer !== null) {
    window.clearInterval(pageTimer);
    pageTimer = null;
  }
}

function startPageRotation(): void {
  stopPageRotation();
  if (pageEls.length <= 1 || !state) return;
  const seconds = Math.max(10, state.settings.pageRotateSeconds || 45);
  pageTimer = window.setInterval(() => {
    currentPage = (currentPage + 1) % pageEls.length;
    pageEls.forEach((p, i) => {
      if (i === currentPage) p.setAttribute('data-active', '');
      else p.removeAttribute('data-active');
    });
  }, seconds * 1000);
}

// ── Render ─────────────────────────────────────────────────────────────────

function render(): void {
  if (!state) return;

  document.body.dataset.perf = state.capability.tier;
  // The backdrop is what stops the desktop wallpaper and icons showing through
  // the gaps between cards.
  document.body.dataset.background = state.settings.background ?? 'gradient';
  document.body.style.setProperty('--backdrop-opacity', String(state.settings.backgroundOpacity ?? 1));
  document.body.classList.toggle('wall-interactive', !state.settings.clickThrough || state.focusMode);

  const width = window.innerWidth;
  const height = window.innerHeight;

  const layout = computeLayout(
    state.clients.map((c) => ({
      id: c.id,
      state: c.state,
      revenue: c.revenue,
      progress: c.progress,
      lastInteraction: c.lastInteraction,
      featured: c.featured,
      kind: c.kind,
    })),
    { width, height, densityScale: state.settings.densityScale },
  );

  // Empty state.
  if (state.clients.length === 0) {
    wallEl.replaceChildren();
    cardEls.clear();
    pageEls.length = 0;
    const empty = el('div', 'empty');
    empty.appendChild(el('h1', undefined, 'No clients yet'));
    empty.appendChild(
      el('p', undefined, 'Add a JSON file to data/clients, or ask Claude to add a client for you.'),
    );
    wallEl.appendChild(empty);
    renderDiagnostics(layout.pageCount);
    return;
  }

  // Page containers.
  if (pageEls.length !== layout.pageCount) {
    wallEl.replaceChildren();
    cardEls.clear();
    pageEls.length = 0;
    for (let i = 0; i < layout.pageCount; i++) {
      const page = el('div', 'page');
      if (i === 0) page.setAttribute('data-active', '');
      pageEls.push(page);
      wallEl.appendChild(page);
    }
    currentPage = 0;
  }

  const byId = new Map(state.clients.map((c) => [c.id, c]));
  const seen = new Set<string>();

  for (const placed of layout.cards) {
    const client = byId.get(placed.id);
    if (!client) continue;
    seen.add(placed.id);

    let card = cardEls.get(placed.id);
    if (!card) {
      card = buildCard(client);
      cardEls.set(placed.id, card);
      if (firstRender) {
        card.setAttribute('data-enter', '');
        card.style.setProperty('--i', String(placed.order));
      }
      card.addEventListener('click', () => {
        const c = state?.clients.find((x) => x.id === placed.id);
        if (c) openDetail(c);
      });
    } else {
      updateCard(card, client);
    }

    positionCard(card, placed, client);

    const page = pageEls[placed.page] ?? pageEls[0];
    if (card.parentElement !== page) page.appendChild(card);
  }

  // Remove cards whose client is gone.
  for (const [id, node] of cardEls) {
    if (!seen.has(id)) {
      node.remove();
      cardEls.delete(id);
      brandCache.delete(id);
    }
  }

  // Broken clients still get a card, on the last page.
  renderBrokenCards(layout, seen);

  firstRender = false;
  startPageRotation();
  renderDiagnostics(layout.pageCount);
}

function positionCard(card: HTMLElement, placed: PlacedCard, client: Client): void {
  card.style.setProperty('--x', `${Math.round(placed.x)}px`);
  card.style.setProperty('--y', `${Math.round(placed.y)}px`);
  card.style.width = `${Math.round(placed.width)}px`;
  card.style.height = `${Math.round(placed.height)}px`;
  // Type scale is driven off card height so a hero and a small tile share a
  // ratio rather than needing separate breakpoints. The unit is required:
  // calc(var(--card-h) * 0.088) on a unitless value yields an invalid length
  // and silently voids the whole font-size declaration.
  card.style.setProperty('--card-h', `${Math.round(placed.height)}px`);
  card.dataset.tier = placed.tier;
  card.dataset.state = client.state;
  // Density is decided per card, from that card's own height. It deliberately
  // does NOT consult the layout-wide density, which is derived from the
  // shortest card and would strip detail from the biggest tiles.
  card.dataset.density = placed.height < 168 ? 'dense' : placed.height < 248 ? 'compact' : 'comfortable';
  applyTokens(card, tokensFor(client));
}

/**
 * A client whose file failed to parse gets a visible, dashed card naming the
 * problem. Silently dropping it would mean a typo makes a client vanish with no
 * signal, which is the worst possible failure for data you maintain by hand.
 */
function renderBrokenCards(layout: ReturnType<typeof computeLayout>, seen: Set<string>): void {
  if (!state) return;
  const broken = state.problems.filter(
    (p) => p.issues.some((i) => i.severity === 'error') && !seen.has(p.id),
  );
  for (const [id, node] of cardEls) {
    if (id.startsWith('__broken__') && !broken.some((b) => `__broken__${b.id}` === id)) {
      node.remove();
      cardEls.delete(id);
    }
  }
  if (broken.length === 0) return;

  const page = pageEls[pageEls.length - 1] ?? pageEls[0];
  if (!page) return;

  const w = 240;
  const h = 128;
  broken.forEach((problem, i) => {
    const key = `__broken__${problem.id}`;
    let card = cardEls.get(key);
    if (!card) {
      card = el('div', 'card');
      card.setAttribute('data-broken', '');
      const inner = el('div', 'card-inner');
      inner.appendChild(el('div', 'label', 'Could not load'));
      const name = el('div', 'client-name', problem.id);
      name.style.fontSize = '16px';
      name.style.marginTop = '4px';
      inner.appendChild(name);
      const msg = problem.issues
        .filter((x) => x.severity === 'error')
        .map((x) => `${x.field}: ${x.message}`)
        .join('\n');
      const m = el('div', 'broken-msg', msg);
      m.style.marginTop = '8px';
      inner.appendChild(m);
      card.appendChild(inner);
      cardEls.set(key, card);
    }
    card.style.setProperty('--card-h', String(h));
    card.style.width = `${w}px`;
    card.style.height = `${h}px`;
    card.style.setProperty('--x', `${window.innerWidth - w - 24}px`);
    card.style.setProperty('--y', `${window.innerHeight - (h + 12) * (i + 1) - 12}px`);
    if (card.parentElement !== page) page.appendChild(card);
  });
}

function renderDiagnostics(pageCount: number): void {
  if (!state) return;
  const on = state.settings.debug;
  diagEl.toggleAttribute('data-on', on);
  if (!on) return;

  const errs = state.problems.filter((p) => p.issues.some((i) => i.severity === 'error')).length;
  const warns = state.problems.reduce(
    (n, p) => n + p.issues.filter((i) => i.severity === 'warn').length,
    0,
  );
  const d = state.display;

  diagEl.replaceChildren();
  const line = (text: string, cls?: string) => {
    const s = el('span', cls, `${text}\n`);
    diagEl.appendChild(s);
  };

  line('MuchBetter Client Wall  ::  diagnostics');
  line(
    `display   ${d ? `${d.index + 1}/${d.total}  ${d.width}x${d.height} @${d.scaleFactor}x${d.isPrimary ? '  primary' : ''}` : 'unknown'}`,
  );
  line(`viewport  ${window.innerWidth}x${window.innerHeight}   pages ${pageCount}`);
  line(
    `perf      ${state.capability.tier}  (${state.capability.cores} cores, ${state.capability.memoryGb} GB, GPU ${
      state.capability.gpuAccelerated ? 'on' : 'OFF'
    })`,
  );
  line(`layer     ${state.settings.layerMode}${state.focusMode ? '  [FOCUS]' : ''}   clickThrough ${state.settings.clickThrough}`);
  line(
    `win32     ${state.win32.available ? 'available' : `UNAVAILABLE (${state.win32.reason})`}`,
    state.win32.available ? 'diag-ok' : 'diag-err',
  );
  line(
    `vault     ${state.vault.available ? `matched ${state.vault.matched}/${state.vault.scanned}` : `off (${state.vault.reason ?? 'n/a'})`}`,
    state.vault.available ? 'diag-ok' : 'diag-warn',
  );
  line(`clients   ${state.clients.length} loaded`, 'diag-ok');
  if (errs) line(`errors    ${errs} client(s) failed to load`, 'diag-err');
  if (warns) line(`warnings  ${warns}`, 'diag-warn');
}

// ── Modes ──────────────────────────────────────────────────────────────────

/**
 * Cross-fade between the two views.
 *
 * Both stay mounted: the client wall keeps its DOM and its card positions, so
 * switching back does not rebuild it or restart its entrance animation. Only
 * the stats canvas is actually stopped, because it is the one thing that costs
 * CPU while nobody is looking at it.
 */
function applyMode(next: 'stats' | 'clients', animate = true): void {
  mode = next;
  document.body.dataset.mode = next;
  clientsView.classList.toggle('is-active', next === 'clients');
  statsMount.classList.toggle('is-active', next === 'stats');
  if (!animate) {
    clientsView.style.transition = 'none';
    statsMount.style.transition = 'none';
    requestAnimationFrame(() => {
      clientsView.style.transition = '';
      statsMount.style.transition = '';
    });
  }
  statsView.setVisible(next === 'stats');
  renderSwitcher();
}

function renderSwitcher(): void {
  if (switchEl.childElementCount === 0) {
    for (const [id, label] of [
      ['stats', 'Claude Stats'],
      ['clients', 'Clients'],
    ] as const) {
      const b = el('button', 'mode-btn', label);
      b.dataset.mode = id;
      b.addEventListener('click', () => {
        if (mode === id) return;
        applyMode(id);
        void window.wall.setMode(id);
      });
      switchEl.appendChild(b);
    }
    const thumb = el('span', 'mode-thumb');
    switchEl.appendChild(thumb);
  }
  switchEl.querySelectorAll<HTMLElement>('.mode-btn').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.mode === mode);
  });
  switchEl.dataset.mode = mode;
}

// ── Wiring ─────────────────────────────────────────────────────────────────

document.addEventListener('pointermove', onPointerMove, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDetail();
  // Tab flips views without reaching for the mouse.
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const next = mode === 'stats' ? 'clients' : 'stats';
    applyMode(next);
    void window.wall.setMode(next);
  }
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(render, 160);
});

window.wall.onDebugOpenDetail?.((id) => {
  const c = state?.clients.find((x) => x.id === id) ?? state?.clients[0];
  if (c) openDetail(c);
});

window.wall.onState((next) => {
  const modeChanged = state?.settings && next.mode !== mode;
  state = next;
  statsView.setPerfTier(next.capability.tier);
  if (modeChanged) applyMode(next.mode);
  render();
});

window.wall.onUsage?.((usage) => statsView.update(usage));

window.wall
  .getState()
  .then((initial) => {
    if (initial) {
      state = initial;
      statsView.setPerfTier(initial.capability.tier);
      // No animation on the very first paint: the view should already be there.
      applyMode(initial.mode ?? 'stats', false);
      render();
    }
  })
  .catch((err) => console.error('[renderer] initial state failed:', err));

window.wall
  .getUsage?.()
  .then((u) => {
    if (u) statsView.update(u);
  })
  .catch((err) => console.error('[renderer] initial usage failed:', err));
