/**
 * Claude's plan limits, read from `~/.claude.json` (docs/design/codex-side-by-side.md,
 * section 5).
 *
 * SECURITY. That file is Claude Code's global config: it also holds the
 * account's email, its UUID and OAuth state. This module parses it, takes the
 * ONE key `cachedUsageUtilization`, and hands it to claudeLimitsFromCache,
 * which builds a fresh object of plain numbers and short validated strings.
 * The parsed file is never kept, logged, cached to disk, pushed or sent, and
 * neither is anything else from it. Errors are swallowed without their
 * message, because an error from JSON.parse can quote the file's contents.
 *
 * Cost. Claude Code rewrites the file often, so it is not watched. The caller
 * polls `refresh()` (at most once every 60 s); each call is one stat, and the
 * file is read again only when its mtime or size changed. A push never touches
 * the disk: it uses `current()`.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeLimitsFromCache, type ClaudeLimits } from '../../shared/claude-limits';

/** The file, overridable for tests. Read on each call so a test can point it anywhere. */
export function claudeJsonPath(): string {
  return process.env.MBW_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
}

/** Far larger than a real config (about 250 KB); a file past this is not read, so a parse never stalls the main thread. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * One read. `readable` is false when the file exists but could not be read or
 * parsed, most often because Claude Code is rewriting it: the keeper then keeps
 * its last reading and tries again on the next poll.
 */
async function readFileOnce(file: string): Promise<{ readable: boolean; value: ClaudeLimits | null }> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_BYTES) return { readable: false, value: null };
    const text = await fs.readFile(file, 'utf8');
    // Only the one key survives this function; the rest is garbage the moment it returns.
    const parsed: unknown = JSON.parse(text);
    const cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).cachedUsageUtilization : null;
    return { readable: true, value: claudeLimitsFromCache(cache) };
  } catch {
    return { readable: false, value: null };
  }
}

/** One read: the reading, or null for a missing, unreadable, oversized or malformed file. */
export async function readClaudeLimits(file: string = claudeJsonPath()): Promise<ClaudeLimits | null> {
  return (await readFileOnce(file)).value;
}

export interface ClaudeLimitsKeeper {
  /** Stat the file and re-read it only if it changed. Resolves true when the reading changed. */
  refresh(): Promise<boolean>;
  /** The last reading, no disk access. */
  current(): ClaudeLimits | null;
}

export function createClaudeLimitsKeeper(file: () => string = claudeJsonPath): ClaudeLimitsKeeper {
  let value: ClaudeLimits | null = null;
  let sig = '';
  let busy = false;
  return {
    async refresh(): Promise<boolean> {
      if (busy) return false;
      busy = true;
      try {
        const f = file();
        let stamp: string;
        try {
          const st = await fs.stat(f);
          stamp = `${f}|${st.mtimeMs}|${st.size}`;
        } catch {
          stamp = `${f}|missing`;
        }
        if (stamp === sig) return false;
        let next: ClaudeLimits | null = null;
        if (!stamp.endsWith('|missing')) {
          const read = await readFileOnce(f);
          // Half-written or unreadable: keep the last reading, and leave the stamp so the next poll retries.
          if (!read.readable) return false;
          next = read.value;
        }
        sig = stamp;
        const changed = JSON.stringify(next) !== JSON.stringify(value);
        value = next;
        return changed;
      } finally {
        busy = false;
      }
    },
    current: () => value,
  };
}
