/**
 * Obsidian vault adapter. STRICTLY READ-ONLY.
 *
 * SECURITY, and this is not theoretical:
 * The vault's own conventions file records that `02-Clients/r4tw.md` holds
 * client banking details, deliberately vault-only. This wall is an ambient
 * display that anyone walking past the desk can read. Therefore:
 *
 *   - We parse ONLY YAML frontmatter. Note bodies are never read into memory,
 *     never returned, and never rendered. That is a structural guarantee, not
 *     a filtering one: the body is discarded at the parse boundary.
 *   - Frontmatter keys are ALLOWLISTED. A new key someone adds to a note does
 *     not automatically appear on the wall.
 *   - Anything free-text and potentially sensitive (notes, contacts) is not on
 *     the allowlist. Numbers and statuses are.
 *
 * The vault is treated as a SOURCE, never a destination. Nothing here writes,
 * renames, moves or deletes. If the vault is missing or unreadable, the wall
 * runs on its own JSON files with no loss of function.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Frontmatter keys the wall is allowed to consume. Everything else is dropped. */
const ALLOWED_KEYS = new Set([
  'title',
  'type',
  'status',
  'client',
  'tags',
  'created',
  'updated',
  // Wall-specific opt-in fields. Namespaced so they are obviously for this app.
  'wall_revenue',
  'wall_progress',
  'wall_project',
  'wall_project_type',
  'wall_industry',
  'wall_phase',
  'wall_hours',
  'wall_deliverables',
  'wall_start',
  'wall_end',
  'wall_primary',
  'wall_secondary',
  'wall_logo',
  'wall_featured',
  'wall_company',
]);

export interface VaultClient {
  slug: string;
  fields: Record<string, string | string[]>;
  sourcePath: string;
}

export interface VaultReadResult {
  clients: VaultClient[];
  available: boolean;
  reason?: string;
  scanned: number;
}

/**
 * Minimal YAML frontmatter parser, limited on purpose.
 *
 * Supports exactly what the vault's documented schema uses: `key: value`,
 * `key: [a, b]` inline arrays, and `- item` block lists. It cannot construct
 * objects, resolve tags, or reference anchors, so a hostile or malformed note
 * can at worst produce junk strings, never code execution or resource
 * exhaustion. That is a deliberate trade against pulling in a full YAML engine.
 */
function parseFrontmatter(text: string): Record<string, string | string[]> | null {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;

  const block = text.slice(3, end);
  const out: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  let listBuffer: string[] = [];

  const commit = () => {
    if (currentKey && listBuffer.length) out[currentKey] = listBuffer;
    listBuffer = [];
  };

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentKey) {
      listBuffer.push(stripQuotes(listItem[1]));
      continue;
    }

    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;

    commit();
    currentKey = kv[1];
    const value = kv[2].trim();

    if (value === '') {
      // Either an empty value or the header of a block list.
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      out[currentKey] = value
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
      currentKey = null;
    } else {
      out[currentKey] = stripQuotes(value);
      currentKey = null;
    }
  }
  commit();
  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Read a single note's frontmatter without loading the whole file.
 *
 * Frontmatter is at the top, so we read a bounded prefix (16 KB). This both
 * bounds memory on a large note and makes it structurally impossible to pull a
 * body paragraph from further down the file.
 */
async function readFrontmatterOnly(file: string): Promise<Record<string, string | string[]> | null> {
  const MAX_PREFIX = 16 * 1024;
  let handle: import('node:fs').promises.FileHandle | null = null;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(MAX_PREFIX);
    const { bytesRead } = await handle.read(buf, 0, MAX_PREFIX, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    return parseFrontmatter(text);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Scan the vault's client notes.
 *
 * Only `<vault>/02-Clients/*.md` is read, matching the vault's documented
 * "one master record per relationship" convention. Project notes are not read:
 * they are longer, more free-text, and more likely to contain something that
 * should not be on a wall.
 */
export async function readVaultClients(vaultPath: string | null): Promise<VaultReadResult> {
  if (!vaultPath) return { clients: [], available: false, reason: 'no vault path configured', scanned: 0 };

  const dir = path.join(vaultPath, '02-Clients');
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch (err) {
    return {
      clients: [],
      available: false,
      reason: `cannot read ${dir}: ${(err as Error).message}`,
      scanned: 0,
    };
  }

  const clients: VaultClient[] = [];
  for (const file of entries) {
    const full = path.join(dir, file);
    const fm = await readFrontmatterOnly(full);
    if (!fm) continue;

    // Only notes that actually declare themselves as client records.
    if (fm.type !== 'client') continue;

    const fields: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (ALLOWED_KEYS.has(k)) fields[k] = v;
    }

    const slug =
      (typeof fields.client === 'string' && fields.client) || path.basename(file, path.extname(file));

    clients.push({ slug, fields, sourcePath: full });
  }

  return { clients, available: true, scanned: entries.length };
}

/** Map allowlisted vault frontmatter onto the wall's raw client shape. */
export function vaultClientToRaw(v: VaultClient): Record<string, unknown> {
  const f = v.fields;
  const str = (k: string): string | undefined => (typeof f[k] === 'string' ? (f[k] as string) : undefined);

  return {
    id: v.slug,
    name: str('title') ?? v.slug,
    company: str('wall_company'),
    status: str('status'),
    project: str('wall_project'),
    projectType: str('wall_project_type'),
    industry: str('wall_industry'),
    currentPhase: str('wall_phase'),
    revenue: str('wall_revenue'),
    progress: str('wall_progress'),
    hours: str('wall_hours'),
    deliverables: str('wall_deliverables'),
    startDate: str('wall_start') ?? str('created'),
    endDate: str('wall_end'),
    lastInteraction: str('updated'),
    featured: str('wall_featured') === 'true',
    tags: Array.isArray(f.tags) ? f.tags : [],
    branding: {
      primary: str('wall_primary'),
      secondary: str('wall_secondary'),
      logo: str('wall_logo'),
    },
  };
}
