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

export const WIRE_VERSION = 1;

export interface WireTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  thinking: number;
  requests: number;
  webSearch: number;
  webFetch: number;
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
}

/** Copy the eight numeric fields explicitly. A spread would carry extras. */
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
  if (opts.shareProjectNames) {
    const raw = Object.entries(idx.projects ?? {}) as [string, any][];
    const paths = raw.map(([key, v]) => (typeof v?.display === 'string' && v.display) || key);
    const labels = labelProjects(paths);
    raw.forEach(([key, v], i) => {
      const label = maskHome(labels.get(paths[i]) ?? `project ${i + 1}`, opts.homeDirName);
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
  };
}

/**
 * Rebuild the shape the renderer expects. The renderer is unchanged and does
 * not know whether it is showing local or projected data; only the chrome
 * around it changes.
 */
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
    ...(w.unavailableReason ? { unavailableReason: w.unavailableReason } : {}),
  };
}
