/**
 * Turn absolute project paths into the short labels a person reads.
 *
 * This used to live inside the stats renderer. It moved here because
 * projection needs the SAME labels: the wire format sends labels instead of
 * paths (paths carry the Windows username and the whole folder structure), and
 * a screen must show exactly what the source's own wall shows. Two
 * implementations would drift, and the drift would be invisible until someone
 * compared two machines side by side.
 *
 * The rule, unchanged from the renderer: the folder name alone, unless two
 * projects share a folder name, in which case the parent is prefixed. Real data
 * broke the naive version by listing "Travel Game" twice with different numbers
 * because two different paths ended in the same segment.
 */

const segsOf = (p: string): string[] => p.split(/[\\/]/).filter(Boolean);

/**
 * Map each input path to its label. Input order is irrelevant; the result
 * depends only on the SET of paths, so a source and a screen agree.
 */
export function labelProjects(paths: string[]): Map<string, string> {
  const leafCounts = new Map<string, number>();
  for (const p of paths) {
    const leaf = (segsOf(p).pop() || p).toLowerCase();
    leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
  }

  const out = new Map<string, string>();
  for (const p of paths) {
    const scratch = scratchLabel(p);
    if (scratch) {
      out.set(p, scratch);
      continue;
    }
    const segs = segsOf(p);
    const leaf = segs.pop() || p;
    const ambiguous = (leafCounts.get(leaf.toLowerCase()) || 0) > 1 && segs.length > 0;
    out.set(p, ambiguous ? `${segs[segs.length - 1]} / ${leaf}` : leaf);
  }
  return out;
}

/**
 * T3 Code runs a thread with no project in a scratch folder named after the
 * date and the first words of the prompt (`.t3\scratch\2026-10-23-these-are-...`).
 * That name is a fragment of a prompt, not a project, so it is shown as
 * "T3 scratch, 23 Oct" (Gustav saw the raw folder name in the design check,
 * 2026-10-26). Null for any other path.
 */
function scratchLabel(p: string): string | null {
  const segs = segsOf(p);
  const i = segs.findIndex((s, k) => s.toLowerCase() === '.t3' && (segs[k + 1] ?? '').toLowerCase() === 'scratch');
  if (i < 0) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(segs[i + 2] ?? '');
  if (!m) return 'T3 scratch';
  const when = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(when.getTime()) ? 'T3 scratch' : `T3 scratch, ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

/** One path, with no set to disambiguate against. */
export function labelOf(path: string): string {
  return scratchLabel(path) ?? (segsOf(path).pop() || path);
}
