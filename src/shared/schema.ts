/**
 * Client record schema, validation and normalisation.
 *
 * DESIGN RULES
 *
 * 1. One JSON file per client, in data/clients/<slug>.json. Not one big array.
 *    A corrupt or half-written file then costs exactly one card, which is the
 *    error-tolerance requirement: A, B, D still render when C is broken.
 *
 * 2. Validation NEVER throws for a recoverable problem. It returns a normalised
 *    record plus a list of issues. A missing logo, a bad date or an unknown
 *    status degrades the card, it does not remove it. Only a record with no
 *    usable id is rejected outright, because it cannot be addressed or updated.
 *
 * 3. Unknown fields are preserved in `extra`. Future-proofing without a rewrite:
 *    a field added to the JSON by hand survives a load/save round trip even if
 *    this version does not render it.
 */

export type ClientState = 'active' | 'prospect' | 'paused' | 'past' | 'archived';

/**
 * What KIND of work this is, which is a different axis from `state`.
 *
 * The wall carries client engagements alongside MuchBetter's own products,
 * shared infrastructure and personal projects. Without this they would all read
 * as clients, which would be a quiet lie about the business. `state` says how
 * alive the work is; `kind` says whose it is.
 */
export type ClientKind = 'client' | 'product' | 'infrastructure' | 'personal';

export const CLIENT_KINDS: ClientKind[] = ['client', 'product', 'infrastructure', 'personal'];

const KIND_ALIASES: Record<string, ClientKind> = {
  client: 'client',
  customer: 'client',
  engagement: 'client',
  product: 'product',
  'own-product': 'product',
  own: 'product',
  internal: 'product',
  flagship: 'product',
  infrastructure: 'infrastructure',
  infra: 'infrastructure',
  ops: 'infrastructure',
  personal: 'personal',
  side: 'personal',
};

/** Short label shown on the card. */
export const KIND_LABEL: Record<ClientKind, string> = {
  client: 'Client',
  product: 'Own product',
  infrastructure: 'Infrastructure',
  personal: 'Personal',
};

export const CLIENT_STATES: ClientState[] = ['active', 'prospect', 'paused', 'past', 'archived'];

/** Aliases accepted on input, so hand-written data and vault values both work. */
const STATE_ALIASES: Record<string, ClientState> = {
  active: 'active',
  current: 'active',
  live: 'active',
  ongoing: 'active',
  prospect: 'prospect',
  lead: 'prospect',
  pitching: 'prospect',
  paused: 'paused',
  onhold: 'paused',
  'on-hold': 'paused',
  past: 'past',
  completed: 'past',
  complete: 'past',
  done: 'past',
  finished: 'past',
  archived: 'archived',
  archive: 'archived',
};

export interface ClientBranding {
  primary: string | null;
  secondary: string | null;
  /** Path relative to the assets root, or null. */
  logo: string | null;
  /** Paths relative to the assets root. */
  images: string[];
  /** Optional per-client visual treatment hint. */
  motif: 'plain' | 'gradient' | 'mesh' | 'grid' | null;
}

export interface Client {
  id: string;
  name: string;
  kind: ClientKind;
  company: string | null;
  state: ClientState;
  /** Free-text status line, e.g. 'Development'. Distinct from `state`. */
  currentPhase: string | null;
  industry: string | null;
  projectType: string | null;
  project: string | null;
  revenue: number | null;
  currency: string;
  hours: number | null;
  deliverables: number | null;
  progress: number | null;
  startDate: string | null;
  endDate: string | null;
  lastInteraction: string | null;
  notes: string | null;
  links: { label: string; url: string }[];
  tags: string[];
  featured: boolean;
  branding: ClientBranding;
  /** Where this record came from, for the health report. */
  source: 'file' | 'vault' | 'merged';
  /** Unrecognised keys, preserved verbatim. */
  extra: Record<string, unknown>;
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'warn' | 'error';
}

export interface ValidationResult {
  client: Client | null;
  issues: ValidationIssue[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const KNOWN_KEYS = new Set([
  'id',
  'name',
  'company',
  'state',
  'status',
  'type',
  'currentPhase',
  'phase',
  'kind',
  'industry',
  'projectType',
  'project',
  'revenue',
  'currency',
  'hours',
  'deliverables',
  'progress',
  'startDate',
  'endDate',
  'lastInteraction',
  'notes',
  'links',
  'tags',
  'featured',
  'branding',
]);

/** Slugify a name into a stable id. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    // Tolerate 'R45,000', '45 000', 'R 45000.50'
    const cleaned = v.replace(/[^\d.-]/g, '');
    if (cleaned === '' || cleaned === '-') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Accepts ISO, 'YYYY-MM', 'YYYY/MM/DD' and Date. Returns ISO date or null. */
function toIsoDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  const norm = s.replace(/\//g, '-');
  const t = Date.parse(norm);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function toHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(s) ? (s.startsWith('#') ? s : `#${s}`) : null;
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length ? s : null;
  }
  if (typeof v === 'number') return String(v);
  return null;
}

/**
 * Validate and normalise a raw record.
 *
 * Returns `client: null` only when there is no usable identity, since a record
 * we cannot name or address is not a degraded card, it is not a card.
 */
export function validateClient(raw: unknown, fallbackId?: string): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isObj(raw)) {
    return { client: null, issues: [{ field: '(root)', message: 'not a JSON object', severity: 'error' }] };
  }

  const name = toStringOrNull(raw.name) ?? toStringOrNull(raw.title);
  const rawId = toStringOrNull(raw.id) ?? fallbackId ?? (name ? slugify(name) : null);

  if (!rawId) {
    return {
      client: null,
      issues: [{ field: 'id', message: 'no id and no name to derive one from', severity: 'error' }],
    };
  }

  const id = slugify(rawId);
  if (!name) {
    issues.push({ field: 'name', message: 'missing; using id as display name', severity: 'warn' });
  }

  // State. Unknown values degrade to 'active' with a warning rather than
  // dropping the card, because a typo in a status should not hide a client.
  const rawState = (toStringOrNull(raw.state) ?? toStringOrNull(raw.status) ?? toStringOrNull(raw.type) ?? '')
    .toLowerCase()
    .trim();
  let state: ClientState = 'active';
  if (rawState) {
    const mapped = STATE_ALIASES[rawState];
    if (mapped) state = mapped;
    else issues.push({ field: 'state', message: `unknown state '${rawState}', treated as active`, severity: 'warn' });
  } else {
    issues.push({ field: 'state', message: 'missing; defaulted to active', severity: 'warn' });
  }

  // Progress, clamped with a warning when out of range.
  let progress = toNumber(raw.progress);
  if (progress !== null && (progress < 0 || progress > 100)) {
    issues.push({ field: 'progress', message: `${progress} out of 0..100, clamped`, severity: 'warn' });
    progress = Math.max(0, Math.min(100, progress));
  }

  const startDate = toIsoDate(raw.startDate);
  if (raw.startDate != null && startDate === null) {
    issues.push({ field: 'startDate', message: `unparseable date '${String(raw.startDate)}'`, severity: 'warn' });
  }
  const endDate = toIsoDate(raw.endDate);
  if (raw.endDate != null && endDate === null) {
    issues.push({ field: 'endDate', message: `unparseable date '${String(raw.endDate)}'`, severity: 'warn' });
  }
  if (startDate && endDate && endDate < startDate) {
    issues.push({ field: 'endDate', message: 'end date precedes start date', severity: 'warn' });
  }

  const lastInteraction = toIsoDate(raw.lastInteraction) ?? endDate ?? startDate;

  // Branding.
  const rawBrand = isObj(raw.branding) ? raw.branding : {};
  const primary = toHex(rawBrand.primary);
  if (rawBrand.primary != null && primary === null) {
    issues.push({
      field: 'branding.primary',
      message: `invalid colour '${String(rawBrand.primary)}', falling back to generated hue`,
      severity: 'warn',
    });
  }
  const images = Array.isArray(rawBrand.images)
    ? rawBrand.images.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
    : [];

  const motifRaw = toStringOrNull(rawBrand.motif);
  const motif =
    motifRaw && ['plain', 'gradient', 'mesh', 'grid'].includes(motifRaw)
      ? (motifRaw as ClientBranding['motif'])
      : null;

  const links = Array.isArray(raw.links)
    ? raw.links
        .filter(isObj)
        .map((l) => ({ label: toStringOrNull(l.label) ?? '', url: toStringOrNull(l.url) ?? '' }))
        .filter((l) => l.url.length > 0)
    : [];

  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = v;
  }

  // Kind defaults to 'client', which keeps every existing record valid.
  const rawKind = (toStringOrNull(raw.kind) ?? '').toLowerCase().trim();
  let kind: ClientKind = 'client';
  if (rawKind) {
    const mappedKind = KIND_ALIASES[rawKind];
    if (mappedKind) kind = mappedKind;
    else issues.push({ field: 'kind', message: `unknown kind '${rawKind}', treated as client`, severity: 'warn' });
  }

  const client: Client = {
    id,
    name: name ?? id,
    kind,
    company: toStringOrNull(raw.company),
    state,
    currentPhase: toStringOrNull(raw.currentPhase) ?? toStringOrNull(raw.phase),
    industry: toStringOrNull(raw.industry),
    projectType: toStringOrNull(raw.projectType),
    project: toStringOrNull(raw.project),
    revenue: toNumber(raw.revenue),
    currency: toStringOrNull(raw.currency) ?? 'ZAR',
    hours: toNumber(raw.hours),
    deliverables: toNumber(raw.deliverables),
    progress,
    startDate,
    endDate,
    lastInteraction,
    notes: toStringOrNull(raw.notes),
    links,
    tags,
    featured: raw.featured === true,
    branding: {
      primary,
      secondary: toHex(rawBrand.secondary),
      logo: toStringOrNull(rawBrand.logo),
      images,
      motif,
    },
    source: 'file',
    extra,
  };

  return { client, issues };
}
