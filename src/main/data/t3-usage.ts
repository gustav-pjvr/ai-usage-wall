import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { emptyContrib, fold, type UsageIndex, type TokenTotals, type FileContribution } from './usage';
import type { HistoryStore } from './history';

export const T3_DATABASE = process.env.MBW_T3_DATABASE || path.join(os.homedir(), '.t3', 'userdata', 'statev2.sqlite');

export interface T3Record {
  id: string;
  session: string;
  model: string;
  ts: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  thinking: number;
}

export interface T3Snapshot {
  records: T3Record[];
  state: 'ready' | 'missing' | 'unavailable';
  checkedAt: string;
  skipped: number;
  cacheReadable?: boolean;
}

const validCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function validRecord(r: T3Record): boolean {
  return !!r && typeof r.id === 'string' && typeof r.session === 'string' &&
    typeof r.model === 'string' && r.model.startsWith('claude-') &&
    Number.isFinite(Date.parse(r.ts)) &&
    [r.input, r.output, r.cacheRead, r.cacheCreate, r.thinking].every(validCount);
}

/** Read only usage columns. No messages, credentials or runtime payloads are selected. */
export function readT3(database = T3_DATABASE): { records: T3Record[]; skipped: number } {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT t.provider_turn_id AS id, t.provider_thread_id AS session,
        t.completed_at AS ts,
        json_extract(t.payload_json, '$.turnTokenUsage') AS usage,
        json_extract(r.payload_json, '$.modelSelection.model') AS model
      FROM orchestration_v2_projection_provider_turns t
      JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id
      JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
      WHERE a.provider = 'claudeAgent' AND t.completed_at IS NOT NULL
      ORDER BY t.completed_at, t.provider_turn_id
    `).all();
    const records: T3Record[] = [];
    let skipped = 0;
    for (const row of rows) {
      const u = typeof row.usage === 'string' ? JSON.parse(row.usage) : null;
      const session = typeof row.session === 'string'
        ? row.session.match(/:native-thread:([a-f0-9-]{36})$/i)?.[1]?.toLowerCase() : null;
      // Partial main-agent usage cannot stand in for a session with subagents.
      if (!session || !u || u.usageStatus !== 'complete' || u.usageScope !== 'main_agent' || u.hasSubagents !== false ||
          ![u.inputTokens, u.outputTokens, u.cachedInputTokens, u.cacheCreationTokens].every(validCount)) {
        skipped++;
        continue;
      }
      // T3 input includes cache reads and writes; Claude transcripts separate them.
      const rec: T3Record = {
        id: String(row.id), session, model: String(row.model), ts: String(row.ts),
        input: u.inputTokens - u.cachedInputTokens - u.cacheCreationTokens,
        output: u.outputTokens, cacheRead: u.cachedInputTokens,
        cacheCreate: u.cacheCreationTokens, thinking: u.reasoningTokens ?? 0,
      };
      if (validRecord(rec)) records.push(rec);
      else skipped++;
    }
    return { records, skipped };
  } finally {
    db.close();
  }
}

/** Keep normalized counts if T3 is removed or its database is temporarily locked. */
export async function refreshT3(userData: string, previous?: T3Snapshot, database = T3_DATABASE): Promise<T3Snapshot> {
  const cache = path.join(userData, 't3-claude-usage.json');
  let records = previous?.records ?? [];
  let cacheReadable = previous?.cacheReadable ?? true;
  if (!previous) {
    try {
      const saved = JSON.parse(await fs.readFile(cache, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.records) || !saved.records.every(validRecord)) throw new Error('invalid cache');
      records = saved.records;
    } catch (err) {
      cacheReadable = (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
  const checkedAt = new Date().toISOString();
  try {
    await fs.access(database);
    const current = readT3(database);
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const r of current.records) byId.set(r.id, r);
    records = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts));
    if (cacheReadable) {
      const data = JSON.stringify({ version: 1, records });
      if (data !== JSON.stringify({ version: 1, records: previous?.records })) {
        await fs.writeFile(cache + '.tmp', data, 'utf8');
        await fs.rename(cache + '.tmp', cache);
      }
    }
    return { records, state: cacheReadable ? 'ready' : 'unavailable', checkedAt, cacheReadable, skipped: current.skipped };
  } catch (err) {
    return { records, state: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable', checkedAt, cacheReadable, skipped: previous?.skipped ?? 0 };
  }
}

/** Recompute the fallback each pass so a late transcript replaces it, never adds to it. */
export function withT3<T extends UsageIndex>(base: T, history: HistoryStore, snapshot: T3Snapshot | undefined,
  pending: Record<string, FileContribution> = {}): T & { sourceHealth: Record<string, unknown> } {
  const known = new Set(Object.keys(base.sessions).map((s) => s.toLowerCase()));
  const remember = (files: Record<string, { contrib: FileContribution }>) => {
    for (const [file, entry] of Object.entries(files)) {
      known.add(path.basename(file, '.jsonl').toLowerCase());
      for (const sid of Object.keys(entry.contrib.sessions)) known.add(sid.toLowerCase());
    }
  };
  remember(base.files);
  remember(history.entries);
  remember(Object.fromEntries(Object.entries(pending).map(([p, contrib]) => [p, { contrib }])));
  const out = { ...base, files: { ...base.files } };
  const selected = new Map<string, T3Record>();
  // A reconstructed seed has no session ids. Do not overlap its historical window.
  for (const r of snapshot?.records ?? []) {
    if (!known.has(r.session) && (!history.seed || r.ts > history.seed.createdAt)) selected.set(r.id, r);
  }
  if (selected.size) {
    Object.assign(out, structuredClone({ totals: base.totals, daily: base.daily, models: base.models,
      projects: base.projects, sessions: base.sessions, activeDays: base.activeDays }));
    for (const r of selected.values()) {
      const total = r.input + r.output + r.cacheRead + r.cacheCreate;
      // T3 reports turns, not individual API requests or cache-write TTLs.
      const rec: TokenTotals = { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreate: r.cacheCreate,
        thinking: r.thinking, requests: 0, webSearch: 0, webFetch: 0, costUsd: 0, unpricedTokens: total };
      const meta = { model: r.model, ts: r.ts, tsMs: Date.parse(r.ts), cwd: null, sid: r.session };
      fold(out, rec, meta);
      const key = `t3:${r.session}`;
      const entry = out.files[key] ??= { size: 0, offset: 0, contrib: emptyContrib() };
      fold(entry.contrib, rec, meta);
      // Completion timestamps do not describe per-request velocity or active hours.
      if (!out.latest.ts || r.ts > out.latest.ts) out.latest = { ts: r.ts, model: r.model, sessionId: r.session, version: null, cwd: null };
    }
  }
  return { ...out, sourceHealth: {
    claude: base.unavailable ? 'unavailable' : 'ready', checkedAt: base.builtAt,
    t3: snapshot?.state ?? 'checking', t3CheckedAt: snapshot?.checkedAt ?? null,
    fallbackSessions: new Set([...selected.values()].map((r) => r.session)).size,
    fallbackTurns: selected.size, skippedTurns: snapshot?.skipped ?? 0,
  } };
}
