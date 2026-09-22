/**
 * The history store: numbers the wall has counted whose transcripts no longer
 * exist.
 *
 * WHY IT EXISTS
 *
 * Claude Code deletes transcripts older than `cleanupPeriodDays`, 30 by
 * default. The usage index is a cache rebuilt from the transcripts, so every
 * rebuild quietly forgot everything that had been deleted. On 2026-09-22 the
 * 0.9.13 index bump rebuilt it, and the wall fell from 39.35B tokens to 19.79B:
 * about 350 transcripts' worth of history, gone from the totals in one launch.
 *
 * The rule this file exists for: a number the wall has shown never falls
 * because a transcript was deleted, a cache was discarded or the index was
 * rebuilt.
 *
 * HOW
 *
 * Every transcript's contribution is kept in the index (usage.ts
 * `FileContribution`). When a transcript is confirmed gone, its contribution is
 * moved here BEFORE the index drops it. A path is in exactly one of the index
 * and this store, so a restored transcript is released back to the index and
 * can never be counted twice.
 *
 * Own file, for the reason peak.ts and milestones.ts give: the usage cache is
 * designed to be thrown away, and this must survive that.
 *
 * THE SEED
 *
 * The ~350 transcripts deleted before this existed could not be archived: there
 * was nothing left to archive. Their numbers came back through a one-off seed,
 * reconstructed from Claude Code's own stats cache and a screenshot of the old
 * wall by a one-off script run by hand (not shipped: it holds one machine's
 * figures), dropped in as `history-seed.json`. It is marked RECONSTRUCTED everywhere it is
 * shown, never passed off as measured (rule 12).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileContribution, HistoryPort, TokenTotals, SessionInfo } from './usage';

export interface HistoryEntry {
  archivedAt: string;
  reason: 'deleted' | 'stale-cache';
  contrib: FileContribution;
}

export interface HistorySeed {
  kind: 'reconstructed';
  /** Human wording for where it came from, shown in the UI. Never a path. */
  source: string;
  createdAt: string;
  notes: string[];
  totals: TokenTotals;
  daily: Record<string, TokenTotals>;
  models: Record<string, TokenTotals>;
  projects: Record<string, TokenTotals & { lastSeen: string; display: string }>;
  activeDays: Record<string, number>;
  sessionCount: number;
  transcriptCount: number;
  prompts: { total: number; daily: Record<string, number> };
}

export interface HistoryStore {
  v: 1;
  entries: Record<string, HistoryEntry>;
  seed: HistorySeed | null;
  prompts: { total: number; daily: Record<string, number> };
}

const emptyStore = (): HistoryStore => ({ v: 1, entries: {}, seed: null, prompts: { total: 0, daily: {} } });

let store: HistoryStore = emptyStore();
let loaded = false;
let dir: string | null = null;
let saving: Promise<boolean> = Promise.resolve(true);
let warnedInvalid = false;

const fileOf = (d: string) => path.join(d, 'usage-history.json');
const seedFileOf = (d: string) => path.join(d, 'history-seed.json');

function valid(raw: unknown): raw is HistoryStore {
  const r = raw as Partial<HistoryStore> | null;
  if (!r || r.v !== 1 || typeof r.entries !== 'object' || r.entries === null) return false;
  if (typeof r.prompts !== 'object' || r.prompts === null) return false;
  // Every entry must carry a contribution the merge can add, or it throws later.
  return Object.values(r.entries).every((e) => !!e && typeof e.contrib?.totals === 'object' && e.contrib.totals !== null);
}

/**
 * Load once at startup, and again from refreshes while not loaded.
 *
 * ONLY a missing file counts as empty. A file that exists but cannot be read,
 * does not parse, or is not a store leaves the store UNLOADED: nothing is
 * archived or released, the index keeps counting deleted transcripts (which
 * loses nothing), and the file is left exactly where it is for a person to
 * look at. Starting empty over it would drop every archived transcript and the
 * seed from the totals, the one thing this file exists to prevent.
 */
export async function loadHistory(userData: string): Promise<void> {
  dir = userData;
  let text: string;
  try {
    text = await fs.readFile(fileOf(userData), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[history] could not read the store (${code}), will retry:`, (err as Error).message);
      return;
    }
    store = emptyStore();
    loaded = true;
    await importSeed();
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    raw = null;
  }
  if (!valid(raw)) {
    // Retried every scan, so said once rather than every few seconds.
    if (!warnedInvalid) console.warn(`[history] ${fileOf(userData)} is not a valid store; left untouched and not used until it is fixed`);
    warnedInvalid = true;
    return;
  }
  store = { ...emptyStore(), ...raw };
  loaded = true;
  await importSeed();
}

/**
 * A reconstructed seed dropped next to the store as `history-seed.json` is
 * taken in once, then renamed so it is never imported twice.
 */
async function importSeed(): Promise<void> {
  if (!dir) return;
  const f = seedFileOf(dir);
  let seed: HistorySeed;
  try {
    seed = JSON.parse(await fs.readFile(f, 'utf8')) as HistorySeed;
  } catch {
    return;
  }
  if (seed?.kind !== 'reconstructed' || !seed.totals) {
    console.warn('[history] ignoring a seed file that is not a reconstructed seed');
    return;
  }
  if (store.seed) {
    console.warn('[history] a seed is already in the store; the new one was NOT imported');
    return;
  }
  store = { ...store, seed };
  if (await save()) {
    await fs.rename(f, `${f}.imported-${Date.now()}`).catch(() => undefined);
    console.log(`[history] seed imported: ${seed.source}`);
  }
}

function save(): Promise<boolean> {
  saving = saving.then(async () => {
    if (!dir || !loaded) return false;
    const target = fileOf(dir);
    const tmp = `${target}.tmp`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(store), 'utf8');
      await fs.rename(tmp, target);
      return true;
    } catch (err) {
      console.warn('[history] could not save:', (err as Error).message);
      return false;
    }
  });
  return saving;
}

/** The store as the merge sees it. Read-only by convention; never mutate. */
export const currentHistory = (): HistoryStore => store;

/** The port the indexer archives through. */
export function historyPort(): HistoryPort {
  return {
    get ready() {
      return loaded;
    },
    has: (p) => loaded && Object.prototype.hasOwnProperty.call(store.entries, p),
    async archive(entries) {
      if (!loaded || !entries.length) return false;
      const at = new Date().toISOString();
      const next = { ...store.entries };
      for (const e of entries) next[e.path] = { archivedAt: at, reason: e.reason, contrib: e.contrib };
      const before = store;
      store = { ...store, entries: next };
      if (await save()) {
        console.log(`[history] archived ${entries.length} transcript(s) no longer on disk`);
        return true;
      }
      store = before; // not on disk, so not archived: the index keeps them
      return false;
    },
    async release(paths) {
      if (!loaded) return false;
      const next = { ...store.entries };
      for (const p of paths) delete next[p];
      const before = store;
      store = { ...store, entries: next };
      if (await save()) {
        console.log(`[history] ${paths.length} transcript(s) back on disk, measured live again`);
        return true;
      }
      store = before;
      return false;
    },
    async archivePrompts(lost) {
      if (!loaded) return false;
      const daily = { ...store.prompts.daily };
      let add = 0;
      for (const [d, n] of Object.entries(lost)) {
        daily[d] = (daily[d] || 0) + n;
        add += n;
      }
      const before = store;
      store = { ...store, prompts: { total: store.prompts.total + add, daily } };
      if (await save()) return true;
      store = before;
      return false;
    },
  };
}

/** Sessions held in archived contributions, for callers that need them by id. */
export function archivedSessions(): Record<string, SessionInfo> {
  const out: Record<string, SessionInfo> = {};
  for (const e of Object.values(store.entries)) Object.assign(out, e.contrib.sessions);
  return out;
}
