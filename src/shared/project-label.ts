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
    const segs = segsOf(p);
    const leaf = segs.pop() || p;
    const ambiguous = (leafCounts.get(leaf.toLowerCase()) || 0) > 1 && segs.length > 0;
    out.set(p, ambiguous ? `${segs[segs.length - 1]} / ${leaf}` : leaf);
  }
  return out;
}

/** One path, with no set to disambiguate against. */
export function labelOf(path: string): string {
  return segsOf(path).pop() || path;
}
