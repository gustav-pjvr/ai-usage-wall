/**
 * Live index plus history: what the wall actually shows.
 *
 * The usage index only knows transcripts that are still on disk. The history
 * store (src/main/data/history.ts) holds what deleted transcripts contributed,
 * plus one reconstructed seed for the ones deleted before the store existed.
 * Every consumer (the renderer, the projector, milestones) reads the MERGE, so
 * the hero, the daily chart, the model split and the ladder always agree.
 *
 * Pure and non-mutating (rule 15): `live` is the index refreshIndex is still
 * updating in place, and writing history into it would count history twice on
 * the next refresh.
 *
 * Shared rather than main-only so the tests can run it without Electron. The
 * shapes are declared structurally here because src/shared must not import
 * from src/main.
 */

export interface MergeTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  thinking: number;
  requests: number;
  webSearch: number;
  webFetch: number;
  costUsd: number;
  unpricedTokens: number;
}

export type MergeProject = MergeTotals & { lastSeen: string; display: string };

export interface MergeSession {
  id: string;
  start: string;
  end: string;
  requests: number;
  output: number;
  total: number;
  cwd: string | null;
  models: string[];
}

export interface MergeContribution {
  totals: MergeTotals;
  daily: Record<string, MergeTotals>;
  models: Record<string, MergeTotals>;
  projects: Record<string, MergeProject>;
  sessions: Record<string, MergeSession>;
  activeDays: Record<string, number>;
}

export interface MergeSeed {
  source: string;
  totals: MergeTotals;
  daily: Record<string, MergeTotals>;
  models: Record<string, MergeTotals>;
  projects: Record<string, MergeProject>;
  activeDays: Record<string, number>;
  sessionCount: number;
  transcriptCount: number;
  prompts: { total: number; daily: Record<string, number> };
}

export interface MergeHistoryInput {
  entries: Record<string, { contrib: MergeContribution }>;
  seed: MergeSeed | null;
  prompts: { total: number; daily: Record<string, number> };
}

export interface MergeLive {
  totals: MergeTotals;
  daily: Record<string, MergeTotals>;
  models: Record<string, MergeTotals>;
  projects: Record<string, MergeProject>;
  sessions: Record<string, MergeSession>;
  activeDays: Record<string, number>;
  prompts: { total: number; daily: Record<string, number> };
}

/** What the wall says about history, so nothing reconstructed passes as measured (rule 12). */
export interface HistorySummary {
  /** Transcripts deleted from disk whose numbers the store kept exactly. */
  archivedFiles: number;
  archivedSessions: number;
  /** Sessions known only as a count, from the seed. Never placeholder sessions. */
  reconstructedSessions: number;
  /** Transcripts known only as a count, from the seed. */
  reconstructedFiles: number;
  archived: MergeTotals;
  reconstructed: MergeTotals;
  /** A fixed human phrase, never a path. Null when there is no seed. */
  reconstructedFrom: string | null;
  /** Tokens in history that belong to no project (the seed's unattributed remainder). */
  unattributedTokens: number;
}

export const zeroTotals = (): MergeTotals => ({
  input: 0,
  output: 0,
  cacheCreate: 0,
  cacheRead: 0,
  thinking: 0,
  requests: 0,
  webSearch: 0,
  webFetch: 0,
  costUsd: 0,
  unpricedTokens: 0,
});

const sum = (a: MergeTotals, b: MergeTotals): MergeTotals => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheCreate: a.cacheCreate + b.cacheCreate,
  cacheRead: a.cacheRead + b.cacheRead,
  thinking: a.thinking + b.thinking,
  requests: a.requests + b.requests,
  webSearch: a.webSearch + b.webSearch,
  webFetch: a.webFetch + b.webFetch,
  costUsd: a.costUsd + b.costUsd,
  unpricedTokens: a.unpricedTokens + b.unpricedTokens,
});

/** The hero's number: every token processed. */
export const tokensOf = (t: MergeTotals): number => t.input + t.output + t.cacheCreate + t.cacheRead;

function addMap(into: Record<string, MergeTotals>, from: Record<string, MergeTotals>): void {
  for (const [k, v] of Object.entries(from)) into[k] = into[k] ? sum(into[k], v) : { ...v };
}

function addProjects(into: Record<string, MergeProject>, from: Record<string, MergeProject>): void {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k];
    if (!cur) {
      into[k] = { ...v };
      continue;
    }
    // The live entry's display wins: it is how the folder is spelled today.
    into[k] = { ...sum(cur, v), display: cur.display || v.display, lastSeen: cur.lastSeen > v.lastSeen ? cur.lastSeen : v.lastSeen };
  }
}

function addCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] || 0) + n;
}

/**
 * One session id can span a live file and an archived one (a resumed session
 * whose first transcript was deleted), so a collision is a union, not a pick.
 */
function addSessions(into: Record<string, MergeSession>, from: Record<string, MergeSession>): void {
  for (const [id, s] of Object.entries(from)) {
    const cur = into[id];
    if (!cur) {
      into[id] = { ...s, models: [...s.models] };
      continue;
    }
    into[id] = {
      ...cur,
      start: s.start < cur.start ? s.start : cur.start,
      end: s.end > cur.end ? s.end : cur.end,
      requests: cur.requests + s.requests,
      output: cur.output + s.output,
      total: cur.total + s.total,
      cwd: cur.cwd ?? s.cwd,
      models: [...new Set([...cur.models, ...s.models])],
    };
  }
}

export function mergeHistory<T extends MergeLive>(live: T, h: MergeHistoryInput | null): T & { history: HistorySummary } {
  const out = {
    ...live,
    totals: { ...live.totals },
    daily: { ...live.daily },
    models: { ...live.models },
    projects: { ...live.projects },
    sessions: { ...live.sessions },
    activeDays: { ...live.activeDays },
    prompts: { ...live.prompts, daily: { ...live.prompts.daily } },
  };
  let archived = zeroTotals();
  const archivedIds = new Set<string>();
  const entries = h ? Object.values(h.entries) : [];

  for (const { contrib: c } of entries) {
    out.totals = sum(out.totals, c.totals);
    archived = sum(archived, c.totals);
    addMap(out.daily, c.daily);
    addMap(out.models, c.models);
    addProjects(out.projects, c.projects);
    for (const id of Object.keys(c.sessions)) archivedIds.add(id);
    addSessions(out.sessions, c.sessions);
    addCounts(out.activeDays, c.activeDays);
  }

  const seed = h?.seed ?? null;
  let unattributed = 0;
  if (seed) {
    out.totals = sum(out.totals, seed.totals);
    addMap(out.daily, seed.daily);
    addMap(out.models, seed.models);
    addProjects(out.projects, seed.projects);
    addCounts(out.activeDays, seed.activeDays);
    out.prompts.total += seed.prompts.total;
    addCounts(out.prompts.daily, seed.prompts.daily);
    const inProjects = Object.values(seed.projects).reduce((n, p) => n + tokensOf(p), 0);
    unattributed = Math.max(0, tokensOf(seed.totals) - inProjects);
  }

  if (h) {
    out.prompts.total += h.prompts.total;
    addCounts(out.prompts.daily, h.prompts.daily);
  }

  return {
    ...out,
    history: {
      archivedFiles: entries.length,
      archivedSessions: archivedIds.size,
      reconstructedSessions: seed?.sessionCount ?? 0,
      reconstructedFiles: seed?.transcriptCount ?? 0,
      archived,
      reconstructed: seed ? { ...seed.totals } : zeroTotals(),
      reconstructedFrom: seed?.source ?? null,
      unattributedTokens: unattributed,
    },
  };
}
