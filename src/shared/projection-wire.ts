/**
 * The ONLY thing that turns a local usage index into bytes for the network.
 *
 * Everything about this file is about what does NOT leave the machine. The
 * index is built from `~/.claude` and is full of things that are perfectly fine
 * on your own desktop and are nobody else's business over a wire:
 *
 *   - `projects` is keyed by ABSOLUTE PATHS, so it carries the Windows
 *     username, the drive layout and every folder name above the project.
 *   - `sessions` carries session UUIDs and a `cwd` each.
 *   - `latest.cwd` and `latest.sessionId` are the same problem, singular.
 *   - `unavailableReason` is an OS error string that names the exact path that
 *     could not be read.
 *   - `files` is a map keyed by every transcript path on disk.
 *
 * So the wire format is built by NAMING each field that goes, never by
 * spreading the index and deleting a few keys. A future field added to
 * UsageIndex is therefore absent from the wire until someone adds it here on
 * purpose, which is the safe direction to fail in. See "Do not break" rule 26.
 *
 * `toWire` is pure and has no imports from the main process, so the test suite
 * can bundle it with esbuild and assert on the output directly.
 */

import { labelProjects } from './project-label';
import { buildLinks, type Link } from './constellation';

export const WIRE_VERSION = 1;

/** The most constellation links a frame carries. See toWire. */
export const MAX_WIRE_LINKS = 300;

export interface WireTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  thinking: number;
  requests: number;
  webSearch: number;
  webFetch: number;
  /** Dollars at API list prices, derived by the source from these same counts. */
  costUsd: number;
  /** Tokens the source's price table could not price, so a gap is visible. */
  unpricedTokens: number;
}

/** A session with its identity removed: only the shape of the work remains. */
export interface WireSession {
  start: string;
  end: string;
  requests: number;
  output: number;
  total: number;
  models: string[];
}

export interface ProjectedUsage {
  v: number;
  /** When the SOURCE sent this, for display only. Staleness is measured locally. */
  sentAt: number;
  sourceLabel: string;
  builtAt: string;
  totals: WireTotals;
  daily: Record<string, WireTotals>;
  hourly: Record<string, WireTotals>;
  models: Record<string, WireTotals>;
  /** Keyed by LABEL, never by path. Empty when the source declines to share. */
  projects: Record<string, WireTotals & { lastSeen: string; display: string }>;
  projectsShared: boolean;
  /** Keyed by index, never by session id. */
  sessions: Record<string, WireSession>;
  recent: [number, number, number][];
  prompts: { total: number; daily: Record<string, number>; lastAt: string | null };
  latest: { ts: string | null; model: string | null; version: string | null; project: string | null };
  fileCount: number;
  lastScanMs: number;
  indexing: boolean;
  unavailable: boolean;
  unavailableReason?: string;
  /**
   * The source's all time peak tokens per minute. Two numbers and a timestamp,
   * nothing about who or where, so it crosses safely. Sent so a screen reports
   * the SOURCE's record rather than quietly starting a record of its own from
   * data it is only displaying.
   */
  peak?: { velocity: number; at: string } | null;
  /**
   * The constellation's links: [labelA, labelB, sharedDays]. LABELS ONLY, the
   * same masked labels as `projects`, and empty whenever project names are not
   * shared. A screen cannot derive these itself, because the sessions it
   * receives have their working directory stripped (rule 26). Computed on the
   * source, so "same day" means the SOURCE's local day.
   *
   * Optional: a screen older than this field ignores it, and a newer screen
   * talking to an older source gets no links rather than an error.
   */
  projectLinks?: Link[];
  /**
   * How much of the totals comes from history rather than transcripts still on
   * disk (docs/design/history-archive.md). Counts and totals only; the phrase
   * naming the reconstruction's source is fixed text, and anything that looks
   * like a path is dropped. Optional like `projectLinks`.
   */
  history?: WireHistory;
}

export interface WireHistory {
  archivedFiles: number;
  archivedSessions: number;
  reconstructedSessions: number;
  reconstructedFiles: number;
  archived: WireTotals;
  reconstructed: WireTotals;
  reconstructedFrom: string | null;
  unattributedTokens: number;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** A human phrase, never a path: it is shown on the wall and crosses the wire. */
const phrase = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 80 && !/[\\/:]/.test(v) ? v : null;

function wireHistory(h: any): WireHistory | undefined {
  if (!h || typeof h !== 'object') return undefined;
  return {
    archivedFiles: count(h.archivedFiles),
    archivedSessions: count(h.archivedSessions),
    reconstructedSessions: count(h.reconstructedSessions),
    reconstructedFiles: count(h.reconstructedFiles),
    archived: totals(h.archived),
    reconstructed: totals(h.reconstructed),
    reconstructedFrom: phrase(h.reconstructedFrom),
    unattributedTokens: count(h.unattributedTokens),
  };
}

/**
 * Copy the numeric fields explicitly. A spread would carry extras.
 *
 * costUsd and unpricedTokens were added here deliberately when the cost stat
 * shipped: naming fields means a new one does NOT cross until someone decides
 * it should, and this is that decision. Both are aggregates of the source's own
 * token counts, so they say nothing the totals beside them do not.
 */
function totals(t: Record<string, unknown> | undefined): WireTotals {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: n(t?.input),
    output: n(t?.output),
    cacheCreate: n(t?.cacheCreate),
    cacheRead: n(t?.cacheRead),
    thinking: n(t?.thinking),
    requests: n(t?.requests),
    webSearch: n(t?.webSearch),
    webFetch: n(t?.webFetch),
    costUsd: n(t?.costUsd),
    unpricedTokens: n(t?.unpricedTokens),
  };
}

const mapTotals = (src: Record<string, unknown> | undefined): Record<string, WireTotals> => {
  const out: Record<string, WireTotals> = {};
  for (const [k, v] of Object.entries(src ?? {})) out[k] = totals(v as Record<string, unknown>);
  return out;
};

export interface WireOptions {
  /** Off means the projects panel is empty and says so, rather than guessing. */
  shareProjectNames: boolean;
  /**
   * What the screen calls this machine. In practice this IS the hostname:
   * enableSource() passes os.hostname() and there is no UI to change it. This
   * comment previously claimed the opposite, which is why it now says what the
   * caller actually does rather than what would be preferable.
   */
  sourceLabel: string;
  indexing: boolean;
  sentAt?: number;
  /**
   * The leaf of the home directory, which on Windows is the username. Any
   * label segment equal to it (case-insensitively) is replaced with "home":
   * a project run from the home folder would otherwise be labelled with the
   * username, and two same-named folders directly under it would carry it as
   * the parent prefix. The consent dialog promises the username is never sent.
   */
  homeDirName?: string;
}

const HOME_LABEL = 'home';

/** Labels are "leaf" or "parent / leaf"; mask either segment when it is the home directory. */
function maskHome(label: string, homeDirName: string | undefined): string {
  if (!homeDirName) return label;
  const home = homeDirName.toLowerCase();
  return label
    .split(' / ')
    .map((segment) => (segment.toLowerCase() === home ? HOME_LABEL : segment))
    .join(' / ');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toWire(index: any, opts: WireOptions): ProjectedUsage {
  const idx = index ?? {};

  /*
   * Projects: the raw keys are paths. Label them with exactly the function the
   * renderer uses, then key the output by label. `display` is set to the label
   * too, because the renderer reads `display` and must never see a path.
   */
  const projects: ProjectedUsage['projects'] = {};
  /** Project key (the lowercased cwd) to the label that goes on the wire. */
  const labelOfKey = new Map<string, string>();
  if (opts.shareProjectNames) {
    const raw = Object.entries(idx.projects ?? {}) as [string, any][];
    const paths = raw.map(([key, v]) => (typeof v?.display === 'string' && v.display) || key);
    const labels = labelProjects(paths);
    raw.forEach(([key, v], i) => {
      const label = maskHome(labels.get(paths[i]) ?? `project ${i + 1}`, opts.homeDirName);
      labelOfKey.set(key, label);
      // Two paths can label the same only if they are genuinely the same
      // folder name in the same parent, so fold rather than overwrite.
      const existing = projects[label];
      const t = totals(v);
      const merged = existing ? totals({
        input: existing.input + t.input,
        output: existing.output + t.output,
        cacheCreate: existing.cacheCreate + t.cacheCreate,
        cacheRead: existing.cacheRead + t.cacheRead,
        thinking: existing.thinking + t.thinking,
        requests: existing.requests + t.requests,
        webSearch: existing.webSearch + t.webSearch,
        webFetch: existing.webFetch + t.webFetch,
      }) : t;
      const lastSeen = typeof v?.lastSeen === 'string' ? v.lastSeen : '';
      projects[label] = {
        ...merged,
        lastSeen: existing && existing.lastSeen > lastSeen ? existing.lastSeen : lastSeen,
        display: label,
      };
      void key;
    });
  }

  /*
   * Sessions: re-keyed by index. The renderer only ever uses the COUNT and the
   * start, end and request fields, so the id and cwd have no reader and no
   * business travelling.
   */
  const sessions: Record<string, WireSession> = {};
  Object.values(idx.sessions ?? {}).forEach((s: any, i) => {
    sessions[String(i)] = {
      start: typeof s?.start === 'string' ? s.start : '',
      end: typeof s?.end === 'string' ? s.end : '',
      requests: typeof s?.requests === 'number' ? s.requests : 0,
      output: typeof s?.output === 'number' ? s.output : 0,
      total: typeof s?.total === 'number' ? s.total : 0,
      models: Array.isArray(s?.models) ? s.models.filter((m: unknown) => typeof m === 'string') : [],
    };
  });

  // latest.cwd becomes a label, or nothing. Never the path, and nothing at all
  // when project names are not shared: this is the folder the user is in RIGHT
  // NOW, and it used to go out regardless of the toggle.
  const latestCwd = opts.shareProjectNames && typeof idx.latest?.cwd === 'string' ? idx.latest.cwd : null;
  const latestLabel = latestCwd ? (labelProjects([latestCwd]).get(latestCwd) ?? null) : null;
  const latestProject = latestLabel ? maskHome(latestLabel, opts.homeDirName) : null;

  return {
    v: WIRE_VERSION,
    sentAt: opts.sentAt ?? Date.now(),
    sourceLabel: opts.sourceLabel ?? '',
    builtAt: typeof idx.builtAt === 'string' ? idx.builtAt : '',
    totals: totals(idx.totals),
    daily: mapTotals(idx.daily),
    hourly: mapTotals(idx.hourly),
    models: mapTotals(idx.models),
    projects,
    projectsShared: opts.shareProjectNames,
    sessions,
    recent: Array.isArray(idx.recent)
      ? idx.recent
          .filter((r: unknown) => Array.isArray(r) && r.length >= 3)
          .map((r: number[]) => [Number(r[0]) || 0, Number(r[1]) || 0, Number(r[2]) || 0] as [number, number, number])
      : [],
    prompts: {
      total: Number(idx.prompts?.total) || 0,
      daily: Object.fromEntries(
        Object.entries(idx.prompts?.daily ?? {}).map(([k, v]) => [k, Number(v) || 0]),
      ),
      lastAt: typeof idx.prompts?.lastAt === 'string' ? idx.prompts.lastAt : null,
      // `offset` and `size` are file bookkeeping and are deliberately dropped.
    },
    latest: {
      ts: typeof idx.latest?.ts === 'string' ? idx.latest.ts : null,
      model: typeof idx.latest?.model === 'string' ? idx.latest.model : null,
      version: typeof idx.latest?.version === 'string' ? idx.latest.version : null,
      project: latestProject,
      // sessionId and cwd are deliberately dropped.
    },
    fileCount: Object.keys(idx.files ?? {}).length,
    lastScanMs: Number(idx.lastScanMs) || 0,
    // Rule 15 has to cross the wire: a screen must not present a cold-indexing
    // source's partial totals as final.
    indexing: Boolean(opts.indexing),
    unavailable: Boolean(idx.unavailable),
    peak:
      idx.peak && Number.isFinite(Number(idx.peak.velocity)) && Number(idx.peak.velocity) > 0
        ? { velocity: Number(idx.peak.velocity), at: String(idx.peak.at) }
        : null,
    // The real reason names the path that failed to read. It is replaced with a
    // fixed string rather than omitted, so the screen can still say something.
    ...(idx.unavailable ? { unavailableReason: 'the source cannot read its transcripts' } : {}),
    // Only ever built from labelOfKey, which is empty when names are not
    // shared, so an unshared source sends an empty list and never a path.
    // Capped: a busy source with years of history could otherwise put tens of
    // thousands of pairs in every frame. The screen draws at most 40 stars, and
    // buildLinks returns the strongest first, so the cap loses nothing drawn.
    projectLinks: opts.shareProjectNames
      ? buildLinks(Object.values(idx.sessions ?? {}) as any[], (cwd) => labelOfKey.get(cwd.toLowerCase()) ?? null).slice(0, MAX_WIRE_LINKS)
      : [],
    ...(idx.history ? { history: wireHistory(idx.history) } : {}),
  };
}

/**
 * Rebuild the shape the renderer expects. The renderer is unchanged and does
 * not know whether it is showing local or projected data; only the chrome
 * around it changes.
 */
/**
 * What a screen would actually see change, as a string to compare.
 *
 * The source skips a send when this is identical to the last one sent. Two
 * things were wrong with how it used to decide that, and they cancelled out,
 * which is why nobody noticed:
 *
 * 1. It hashed the whole frame, and `sentAt` is `Date.now()`, written into the
 *    first forty characters. The frames were never equal, so the skip never
 *    fired and every refresh, including the periodic sweep that finds nothing
 *    new, went out to every screen.
 * 2. The "hash" was the length plus the first and last 256 characters. Fixing
 *    only (1) would have switched on a check that misses any change in the
 *    middle of the frame that keeps the same length, a daily bucket going from
 *    1234 to 1235 for instance, and the screen would quietly stop updating.
 *
 * So this drops the fields that change on every call without meaning anything
 * a screen should react to, and returns the rest IN FULL. No hash: a frame is
 * tens of kilobytes, one copy is kept, and a string compare cannot collide.
 *
 * Dropped: `sentAt` (the moment of building, not of any event), `builtAt` (set
 * when the index is rebuilt, never displayed), and `lastScanMs` (how long the
 * last scan took, which varies on every scan). The last one IS displayed, in
 * the screen's status strip, so a screen can show a scan time a sweep or two
 * old. That is the price of the skip working at all, and it is a diagnostic,
 * not a number anyone reads the dashboard for.
 *
 * Liveness does not depend on frames: the source sends a beat every 30 s when
 * nothing else has gone out, and the screen counts any message it decrypted.
 */
export function frameKey(w: ProjectedUsage): string {
  const { sentAt: _sentAt, builtAt: _builtAt, lastScanMs: _lastScanMs, ...seen } = w;
  void _sentAt;
  void _builtAt;
  void _lastScanMs;
  return JSON.stringify(seen);
}

export function fromWire(w: ProjectedUsage): Record<string, unknown> {
  return {
    version: 0,
    builtAt: w.builtAt,
    totals: w.totals,
    daily: w.daily,
    hourly: w.hourly,
    models: w.models,
    projects: w.projects,
    sessions: w.sessions,
    recent: w.recent,
    prompts: { ...w.prompts, offset: 0, size: 0 },
    latest: { ...w.latest, sessionId: null, cwd: null },
    fileCount: w.fileCount,
    lastScanMs: w.lastScanMs,
    indexing: w.indexing,
    unavailable: w.unavailable,
    peak: w.peak ?? null,
    // Re-validated on arrival: the frame decrypted, but a source on another
    // version could still send a malformed list, and the renderer draws from it.
    projectLinks: Array.isArray(w.projectLinks)
      ? w.projectLinks.filter(
          (l): l is Link =>
            Array.isArray(l) && typeof l[0] === 'string' && typeof l[1] === 'string' && Number.isFinite(l[2]),
        )
      : [],
    ...(w.unavailableReason ? { unavailableReason: w.unavailableReason } : {}),
    // Re-validated on arrival, like the links.
    ...(w.history ? { history: wireHistory(w.history) } : {}),
  };
}
