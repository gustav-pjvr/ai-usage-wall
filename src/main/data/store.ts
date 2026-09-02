/**
 * Client data store.
 *
 * ERROR ISOLATION is the governing requirement. Every file is parsed, validated
 * and merged inside its own try/catch. One malformed client costs one card and
 * produces a health-report entry; it never takes down the wall or blocks the
 * other clients from loading.
 *
 * WATCHING uses chokidar with a debounce rather than polling, so an idle wall
 * does no filesystem work at all.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

import { validateClient, type Client, type ValidationIssue } from '../../shared/schema';
import { readVaultClients, vaultClientToRaw } from './obsidian';

export interface LoadProblem {
  id: string;
  file: string | null;
  issues: ValidationIssue[];
}

export interface StoreSnapshot {
  clients: Client[];
  problems: LoadProblem[];
  vault: { available: boolean; reason?: string; scanned: number; matched: number };
  loadedAt: string;
  durationMs: number;
}

export interface StoreOptions {
  clientsDir: string;
  vaultPath: string | null;
  /** Merge vault frontmatter into file records. */
  useVault: boolean;
}

/**
 * Merge a vault record into a file record.
 *
 * POLICY: the local JSON file wins wherever it has a value. The vault only
 * fills gaps. Rationale: the JSON files are what Claude edits on request and
 * what carries presentation choices (branding, motif, featured), while the
 * vault carries slower-moving business truth. A vault edit should enrich the
 * wall, never silently overwrite a deliberate presentation decision.
 */
function mergeVaultIntoClient(file: Client, vaultRaw: Record<string, unknown>): Client {
  const merged: Client = { ...file, source: 'merged' };
  const v = validateClient({ ...vaultRaw, id: file.id }, file.id).client;
  if (!v) return file;

  const fillable: (keyof Client)[] = [
    'company',
    'currentPhase',
    'industry',
    'projectType',
    'project',
    'revenue',
    'hours',
    'deliverables',
    'progress',
    'startDate',
    'endDate',
    'lastInteraction',
  ];
  for (const key of fillable) {
    if (merged[key] === null || merged[key] === undefined) {
      (merged as unknown as Record<string, unknown>)[key] = v[key];
    }
  }
  if (merged.branding.primary === null && v.branding.primary) {
    merged.branding = { ...merged.branding, primary: v.branding.primary };
  }
  if (merged.tags.length === 0 && v.tags.length) merged.tags = v.tags;
  return merged;
}

export async function loadClients(opts: StoreOptions): Promise<StoreSnapshot> {
  const started = Date.now();
  const clients: Client[] = [];
  const problems: LoadProblem[] = [];

  let files: string[] = [];
  try {
    files = (await fs.readdir(opts.clientsDir)).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  } catch (err) {
    problems.push({
      id: '(clients directory)',
      file: opts.clientsDir,
      issues: [{ field: 'dir', message: (err as Error).message, severity: 'error' }],
    });
  }

  for (const file of files) {
    const full = path.join(opts.clientsDir, file);
    const fallbackId = path.basename(file, '.json');
    try {
      const text = await fs.readFile(full, 'utf8');
      let raw: unknown;
      try {
        // Strip a UTF-8 BOM. Notepad, PowerShell's Out-File -Encoding utf8 and
        // several editors all write one on Windows, and JSON.parse rejects it,
        // so a hand-edited client file would fail for an invisible reason.
        raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      } catch (err) {
        problems.push({
          id: fallbackId,
          file: full,
          issues: [{ field: '(json)', message: `parse error: ${(err as Error).message}`, severity: 'error' }],
        });
        continue;
      }

      const { client, issues } = validateClient(raw, fallbackId);
      if (!client) {
        problems.push({ id: fallbackId, file: full, issues });
        continue;
      }
      if (issues.length) problems.push({ id: client.id, file: full, issues });

      if (clients.some((c) => c.id === client.id)) {
        problems.push({
          id: client.id,
          file: full,
          issues: [{ field: 'id', message: 'duplicate id, later file ignored', severity: 'error' }],
        });
        continue;
      }
      clients.push(client);
    } catch (err) {
      // One unreadable file must not stop the rest.
      problems.push({
        id: fallbackId,
        file: full,
        issues: [{ field: '(io)', message: (err as Error).message, severity: 'error' }],
      });
    }
  }

  // Vault enrichment. Entirely optional and entirely non-fatal.
  let vaultInfo = { available: false, reason: 'disabled' as string | undefined, scanned: 0, matched: 0 };
  if (opts.useVault) {
    try {
      const result = await readVaultClients(opts.vaultPath);
      let matched = 0;
      if (result.available) {
        const bySlug = new Map(result.clients.map((v) => [v.slug, v]));
        for (let i = 0; i < clients.length; i++) {
          const v = bySlug.get(clients[i].id);
          if (!v) continue;
          try {
            clients[i] = mergeVaultIntoClient(clients[i], vaultClientToRaw(v));
            matched++;
          } catch (err) {
            problems.push({
              id: clients[i].id,
              file: v.sourcePath,
              issues: [{ field: '(vault)', message: (err as Error).message, severity: 'warn' }],
            });
          }
        }
      }
      vaultInfo = {
        available: result.available,
        reason: result.reason,
        scanned: result.scanned,
        matched,
      };
    } catch (err) {
      vaultInfo = { available: false, reason: (err as Error).message, scanned: 0, matched: 0 };
    }
  }

  return {
    clients,
    problems,
    vault: vaultInfo,
    loadedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

/**
 * Watch the client directory (and optionally the vault client folder) and call
 * back with a fresh snapshot. Debounced, because editors write in bursts and a
 * half-written JSON file would otherwise produce a spurious error card.
 */
export function watchClients(opts: StoreOptions, onChange: (snap: StoreSnapshot) => void): () => void {
  const paths = [opts.clientsDir];
  if (opts.useVault && opts.vaultPath) paths.push(path.join(opts.vaultPath, '02-Clients'));

  let timer: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      loadClients(opts)
        .then(onChange)
        .catch((err) => console.error('[store] reload failed:', err));
    }, 350);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      depth: 1,
    });
    watcher.on('add', schedule).on('change', schedule).on('unlink', schedule);
    watcher.on('error', (err) => console.error('[store] watcher error:', err));
  } catch (err) {
    console.error('[store] could not start watcher:', (err as Error).message);
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close().catch(() => undefined);
  };
}
