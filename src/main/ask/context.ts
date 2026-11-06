/**
 * What Gemini is told: a short preamble and the wall's own numbers as plain
 * text, built from the same payload the renderer gets (`usageForRenderer`).
 *
 * Gemini cannot call back into the wall (the CLI route has no function
 * calling), so the wall decides what it sees. The rules for that choice:
 *
 *   - Only numbers the wall already shows, under the names it shows them by.
 *     Nothing estimated (rule 12): cost is labelled as list prices, quota is a
 *     plan reading with its age, and a missing reading is simply absent.
 *   - Project LABELS only, made by the same `labelProjects` the renderer and
 *     the projection wire use, and then checked: anything still shaped like a
 *     path, a drive letter or a home folder is dropped rather than sent.
 *     `cwd`, session ids, file names and the per-file map never enter.
 *   - `daily` is keyed by the UTC date (rule 38), so those days are labelled
 *     UTC. "Today" comes from the local five-minute slots instead.
 *   - Capped at CONTEXT_MAX characters. Sections are added in order of
 *     usefulness and the last ones are cut first, so a large history cannot
 *     push out the totals.
 *
 * Pure: no electron, no disk. Tested in test/ask.test.mjs.
 */

import { labelProjects } from '../../shared/project-label';

export const CONTEXT_MAX = 6000;

interface Totals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  requests: number;
  costUsd: number;
  unpricedTokens?: number;
}

/** The fields of the renderer payload this reads. Structural, so it stays in step without importing main. */
export interface AskUsage {
  totals?: Totals;
  daily?: Record<string, Totals>;
  models?: Record<string, Totals>;
  projects?: Record<string, Totals & { display?: string; lastSeen?: string }>;
  activeDays?: Record<string, number>;
  todaySlots?: number[];
  activeTime?: { seconds: number; since: number | null } | null;
  claudeLimits?: { at: string; rows: { label: string; usedPercent: number; resetsAt: number }[] } | null;
  codex?: {
    totals: Totals;
    daily?: Record<string, Totals>;
    models?: Record<string, Totals>;
    projects?: Record<string, Totals & { display?: string }>;
    todaySlots?: number[];
    activeTime?: { seconds: number; since: number | null } | null;
    limits?: {
      at: string;
      plan: string | null;
      fiveHour: { usedPercent: number; resetsAt: number } | null;
      weekly: { usedPercent: number; resetsAt: number } | null;
    } | null;
    indexing?: boolean;
  } | null;
  indexing?: boolean;
  unavailable?: boolean;
}

const tokens = (t: Totals): number => (t.input || 0) + (t.output || 0) + (t.cacheCreate || 0) + (t.cacheRead || 0);
const num = (n: number): string => Math.round(n).toLocaleString('en-US');
/** Floored to the cent, like the wall (rule 12). */
const usd = (n: number): string => `$${(Math.floor((n || 0) * 100) / 100).toFixed(2)}`;
const hours = (s: number): string => `${(s / 3600).toFixed(1)} h`;

/**
 * A label is sent only if it cannot be a path or carry a username. `private`
 * holds names that must never leave the machine (the Windows user name and the
 * home folder's name): a project started in the home folder itself is labelled
 * with that folder's name, which is the user's name.
 */
export function safeLabel(label: string, privateNames: readonly string[] = []): string | null {
  const s = String(label ?? '').trim();
  if (!s || s.length > 60) return null;
  const lower = s.toLowerCase();
  for (const n of privateNames) {
    const name = String(n ?? '').trim().toLowerCase();
    if (name && lower.includes(name)) return null;
  }
  if (/[\\]|^[a-z]:|^\/|~|\.\.|appdata/i.test(s)) return null;
  // The labeller's own " / " join for ambiguous names is fine; any other slash is not.
  if (/\//.test(s.replace(/ \/ /g, ''))) return null;
  return s.replace(/[\x00-\x1f\x7f]/g, '');
}

function topProjects(projects: Record<string, Totals & { display?: string }> | undefined, n: number, privateNames: readonly string[]): string[] {
  const entries = Object.entries(projects ?? {});
  if (!entries.length) return [];
  const labels = labelProjects(entries.map(([k, v]) => v.display || k));
  return entries
    .sort((a, b) => tokens(b[1]) - tokens(a[1]))
    .slice(0, n * 2)
    .map(([k, v]) => {
      const label = safeLabel(labels.get(v.display || k) ?? '', privateNames);
      return label ? `  ${label}: ${num(tokens(v))} tokens, ${usd(v.costUsd)}` : null;
    })
    .filter((x): x is string => !!x)
    .slice(0, n);
}

function modelLines(models: Record<string, Totals> | undefined, n: number): string[] {
  return Object.entries(models ?? {})
    .sort((a, b) => tokens(b[1]) - tokens(a[1]))
    .slice(0, n)
    .map(([m, t]) => `  ${String(m).replace(/[^A-Za-z0-9 ._:-]/g, '').slice(0, 48)}: ${num(tokens(t))} tokens, ${num(t.requests)} requests, ${usd(t.costUsd)}`);
}

function dayLines(daily: Record<string, Totals> | undefined, n: number): string[] {
  return Object.keys(daily ?? {})
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .slice(-n)
    .map((d) => `  ${d}: ${num(tokens(daily![d]))} tokens, ${num(daily![d].requests)} requests, ${usd(daily![d].costUsd)}`);
}

const sumSlots = (s: number[] | undefined): number | null =>
  Array.isArray(s) && s.length ? s.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) : null;

const when = (ms: number): string => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The plain-text block of the wall's numbers. Sections in priority order; the
 * whole is cut at a section boundary to stay under `max`.
 */
export function usageContext(u: AskUsage | null | undefined, now = Date.now(), max = CONTEXT_MAX, privateNames: readonly string[] = []): string {
  if (!u || u.unavailable) return 'No usage data is available on the wall right now.';
  const sections: string[][] = [];
  const head = [`Local time on the wall: ${new Date(now).toLocaleString('en-GB')}.`];
  if (u.indexing) head.push('The wall is still reading transcripts, so these numbers are partial.');
  sections.push(head);

  if (u.totals) {
    const t = u.totals;
    const s = [
      'CLAUDE CODE, all time:',
      `  ${num(tokens(t))} tokens (input ${num(t.input)}, output ${num(t.output)}, cache write ${num(t.cacheCreate)}, cache read ${num(t.cacheRead)})`,
      `  ${num(t.requests)} requests; cost ${usd(t.costUsd)} at API list prices (derived, not a bill)`,
    ];
    const today = sumSlots(u.todaySlots);
    if (today !== null) s.push(`  Today so far (local day): ${num(today)} tokens`);
    if (u.activeTime && u.activeTime.seconds > 0) {
      s.push(`  Hours Claude has been working: ${hours(u.activeTime.seconds)}${u.activeTime.since ? ` since ${new Date(u.activeTime.since).toLocaleDateString('en-GB')}` : ''}`);
    }
    sections.push(s);
  }

  if (u.claudeLimits?.rows?.length) {
    const s = [`CLAUDE PLAN LIMITS (reading from ${when(Date.parse(u.claudeLimits.at))}):`];
    for (const r of u.claudeLimits.rows) {
      s.push(r.resetsAt > now ? `  ${r.label}: ${Math.round(r.usedPercent)}% used, resets ${when(r.resetsAt)}` : `  ${r.label}: reset at ${when(r.resetsAt)}, not read since`);
    }
    sections.push(s);
  }

  if (u.codex?.totals) {
    const c = u.codex;
    const s = [
      `CODEX, all time${c.indexing ? ' (still reading, partial)' : ''}:`,
      `  ${num(tokens(c.totals))} tokens, ${num(c.totals.requests)} responses, cost ${usd(c.totals.costUsd)} at API list prices`,
    ];
    const today = sumSlots(c.todaySlots);
    if (today !== null) s.push(`  Today so far (local day): ${num(today)} tokens`);
    if (c.activeTime && c.activeTime.seconds > 0) s.push(`  Hours Codex has been working: ${hours(c.activeTime.seconds)}`);
    const l = c.limits;
    if (l) {
      const w = (name: string, x: { usedPercent: number; resetsAt: number } | null) =>
        x ? (x.resetsAt > now ? `  ${name}: ${Math.round(x.usedPercent)}% used, resets ${when(x.resetsAt)}` : `  ${name}: has reset`) : null;
      s.push(`  Plan${l.plan ? ` (${String(l.plan).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20)})` : ''} reading from ${when(Date.parse(l.at))}:`);
      for (const line of [w('5 h', l.fiveHour), w('week', l.weekly)]) if (line) s.push(line);
    }
    sections.push(s);
  }

  const days = dayLines(u.daily, 14);
  if (days.length) sections.push(['CLAUDE, last 14 days (UTC dates):', ...days]);
  const models = modelLines(u.models, 8);
  if (models.length) sections.push(['CLAUDE by model, all time:', ...models]);
  const projects = topProjects(u.projects, 10, privateNames);
  if (projects.length) sections.push(['CLAUDE top projects, all time (labels only):', ...projects]);
  if (u.codex) {
    const cd = dayLines(u.codex.daily, 14);
    if (cd.length) sections.push(['CODEX, last 14 days (UTC dates):', ...cd]);
    const cm = modelLines(u.codex.models, 6);
    if (cm.length) sections.push(['CODEX by model:', ...cm]);
    const cp = topProjects(u.codex.projects, 8, privateNames);
    if (cp.length) sections.push(['CODEX top projects (labels only):', ...cp]);
  }

  let out = '';
  for (const s of sections) {
    const block = s.join('\n');
    const next = out ? `${out}\n\n${block}` : block;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/**
 * The whole prompt: preamble, data, then the question, every line of it quoted
 * (src/main/ask/agy.ts, quoteQuestion) so it can never pass for the wall's own
 * instructions or start a slash command.
 */
export function buildPrompt(quotedQuestion: string, data: string): string {
  return [
    "You are answering a question typed on Gustav's desktop stats wall, an app that shows his own Claude Code and Codex usage.",
    'The numbers below are his, read from his own machine just now. Answer briefly, in plain text, with short paragraphs or "-" bullets. No tables, no headings, no code blocks unless asked.',
    'Use web search only if the question needs current outside facts. Do not create plans, files or artifacts, and do not run commands: just answer.',
    'If the numbers below cannot answer the question, say so instead of guessing.',
    '',
    '=== WALL DATA ===',
    data,
    '=== END WALL DATA ===',
    '',
    'Question (quoted):',
    quotedQuestion,
  ].join('\n');
}
