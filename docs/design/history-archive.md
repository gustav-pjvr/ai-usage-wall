# History archive: totals must never drop

**Status:** design, 2026-09-22. Requested by Gustav after the 0.9.13 cache bump halved the wall (39.35B to 19.79B tokens, 812 to 463 transcripts).
**Rule:** a number the wall has shown never falls because a transcript was deleted, a cache was discarded or the index was rebuilt.

## 1. The store

`src/main/data/history.ts`, file `<userData>/usage-history.json`, the peak.ts / milestones.ts pattern: loaded once, chained atomic save, never touched by `INDEX_VERSION`.

```ts
interface FileContribution {           // everything one transcript put into the index
  cv: 1;                               // contribution schema, append-only, independent of INDEX_VERSION
  totals: TokenTotals;                 // incl. costUsd and unpricedTokens
  daily: Record<string, TokenTotals>;  // UTC day, as `index.daily`
  models: Record<string, TokenTotals>;
  projects: Record<string, TokenTotals & { lastSeen: string; display: string }>;
  sessions: Record<string, SessionInfo>;
  activeDays: Record<string, number>;  // LOCAL day, as `index.activeDays`
}
interface HistoryEntry { archivedAt: string; reason: 'deleted' | 'stale-cache'; contrib: FileContribution }
interface HistorySeed { kind: 'reconstructed'; source: string; createdAt: string; notes: string[];
  totals: TokenTotals; daily: Record<string, TokenTotals>; models: Record<string, TokenTotals>;
  projects: FileContribution['projects']; activeDays: Record<string, number>;
  sessionCount: number; transcriptCount: number; prompts: { total: number; daily: Record<string, number> } }
interface HistoryStore { v: 1; entries: Record<string /* transcript path */, HistoryEntry>;
  seed: HistorySeed | null; prompts: { total: number; daily: Record<string, number> } }
```

Not held, on purpose: `hourly`, `projectHourly`, `recent` (14 day and 600 record windows, history is older by definition), `latest`, `files` offsets.

**Merge.** A pure `mergeHistory(live, history)` in `src/shared/usage-merge.ts` returns a new index (never mutates `live`, rule 15) with: `totals`, `daily`, `models`, `projects`, `activeDays`, `prompts` added key by key; `sessions` unioned by id (live wins on a collision, requests added); plus one explicit block:

```ts
interface HistorySummary { archivedFiles: number; archivedSessions: number; reconstructedSessions: number;
  archived: TokenTotals; reconstructed: TokenTotals; reconstructedFrom: string | null }
```

Every consumer reads the merged index: `usageForRenderer`, `pushUsage` (so `projection.offerUsage` gets it), `evaluateMilestones`. `offerPeak` stays on live `recent`. The session tile shows `keys(sessions) + history.reconstructedSessions`; "days" keeps reading `keys(daily)`, which the merge extends; only `fileCount` stays live. Every panel derives from the same merged maps, so hit rate, tokens per request, model split and the daily chart agree with the hero.

## 2. Capture: per-file contributions, moved on disappearance

**Chosen: (a), per-file contributions in the cache, orphans moved to history.** `files[path]` becomes `{ size, offset, contrib: FileContribution }`; `ingestFile` folds each record into the index AND into `contrib` (same `addInto`, second target). A path new to the index starts a fresh `contrib` before ingest, never adds onto a stale one.

Invariant: **a transcript path is in exactly one of `index.files` and `history.entries`.** History is therefore never a running sum that must be carefully corrected; it is the set of contributions whose file is gone.

`refreshIndex` gains a step between listing and the shrink check:

1. For every path in `index.files` (plus `staleFiles`, below) `fs.stat` it. Only `ENOENT` / `ENOTDIR` counts as gone; `EPERM`, `EBUSY` or a failed `readdir` of a whole folder (which `listTranscripts` already swallows per subtree) must not orphan anything, or an antivirus lock would archive a project for a minute and then rebuild twice.
2. Gone paths: `archive(orphans)` writes history to disk first. Only when that write succeeded are they removed from `index.files` and a **full rebuild** run (the shrink path), because live aggregates cannot subtract. Deletions are batch events at Claude Code startup, so 5.5 s once beats a subtraction that has to half-delete sessions.
3. Paths on disk that history holds (a **restore** from backup) are released from history, then ingested from offset 0 as unknown files: measured live, no longer archived, so never counted twice.
4. If history is not loaded (unreadable at launch, the milestones.ts `EPERM` case), skip the step and stay incremental: today's behaviour, retried next scan.

`loadIndex` changes shape: `loadIndex(file): Promise<{ index: UsageIndex; staleFiles: Record<string, FileContribution> }>`. On a version mismatch it still returns `emptyIndex()` but hands back the old cache's contributions. The first refresh treats them as candidates: gone from disk means archived as `stale-cache`, present means dropped and rebuilt. A future `INDEX_VERSION` bump therefore costs nothing; a change to `FileContribution` itself must ship a `cv` migration, guarded by a `cv: 1` fixture test.

**Write order:** history is saved before the cache in every path (archive, rebuild, then `saveIndex`). The reverse could leave a contribution in neither file after a crash.

**Rejected (b), old minus rebuilt per key.** It attributes every old measurement bug (the append double count, fixed 2026-09-03) to "history", cannot tell a deleted file from a restored one, and cannot key sessions. **Switch condition:** if per-file `contrib` makes the cache too large (estimate 0.6 to 1.5 MB for 800 files, written at most once a minute; measure it), first shrink `contrib.daily` to totals per day; only then consider (b). The diff rule is used in one place, `history.jsonl` prompts (section 7), which has no per-file unit.

**Cost of (a):** the store starts empty, so the ~350 transcripts already deleted come back only through the seed.

## 3. The seed

One `HistorySeed`, written once by a one-off script that the main thread runs by hand, not by the app, and keeps out of the repo because it holds one machine's figures:

1. Fold the current transcripts with a timestamp cutoff of 2026-09-22 18:23 local (the indexer with an `until` option): what today's files contributed to the screenshot.
2. Seed = screenshot minus that slice, per key: totals and cost exact; per-model requests exact, tokens rounded; top-5 projects mapped by Gustav to their lowercased `cwd` keys (so `labelProjects` and `maskHome` treat them like any project); per-day values from the chart bars, the 22 Sep bar split at the cutoff hour.
3. Negative remainders are clamped to 0 and recorded in `notes`. The difference between `totals` and the sum of `models` or `projects` stays **unattributed**: it counts in `totals` and `daily` and appears in no model or project. Session count and transcript count (812 minus 463) are numbers only, never placeholder sessions.
4. `activeDays`: 1 per local day whose bar is non-zero; the streak only needs "worked that day".

Sequencing: set `cleanupPeriodDays` **first**, then run the seed script, then ship the archiving code. A file deleted between the script and the first archiving scan would be in neither. If old transcripts are ever restored from a backup, delete `seed` (one JSON key): they are measured again.

**UI.** Rule 12 is met by saying what it is. The hero keeps `MEASURED` and gains one caption when `history.reconstructed.requests > 0`: "includes 19.6B tokens reconstructed from a 22 Sep 2026 snapshot". The status strip reads "463 transcripts on disk, 349 archived". The projects panel adds a footer only when unattributed tokens exist: "x% of tokens are in archived history with no project". Nothing else changes.

## 4. The wire

Yes, explicitly. `toWire(mergedIndex, opts)` already names every field, so merged `totals`, `daily`, `models`, `projects`, `sessions` cross as they do now (paths labelled and masked, session ids dropped). One new optional field, like `projectLinks`:

```ts
history?: { archivedFiles: number; archivedSessions: number; reconstructedSessions: number;
  archived: WireTotals; reconstructed: WireTotals; reconstructedFrom: string | null }
```

`reconstructedFrom` is a fixed human string ("snapshot of 22 Sep 2026"), never a path. `fromWire` re-inserts it; `frameKey` includes it. `WIRE_VERSION` stays 1.

## 5. Milestones

History counts. `milestoneInput(merged)`: the hero and the ladder must not disagree. Two rules keep rule 37:

- An archive never changes merged totals, so it can never announce anything.
- The seed can: 39B satisfies "25B processed" that the rebuilt index never reached. Thresholds satisfied at the moment a seed is first loaded are recorded silently with the ledger's existing `earlier` date, never announced. The gate is "first evaluation after `history.seed` appears", stored in the ledger as `seededHistoryAt`.

## 6. Tests the main thread must write

`test/usage-history.test.mjs`, synthetic `MBW_CLAUDE_HOME`, same harness as `usage-append.test.mjs`:

1. **The regression.** Index three transcripts, record every merged map. Delete one, refresh. Write the cache with `version: INDEX_VERSION - 1`, `loadIndex`, refresh. Merged `totals`, `daily`, `models`, `projects`, `activeDays` and session count are **deep-equal to the originals**; `history.archivedFiles === 1`; live `fileCount === 2`.
2. Delete then restore: merged totals equal the originals and `history.entries` is empty (no double count).
3. Shrink-triggered rebuild with a deleted file: unchanged.
4. Locked, not deleted: a `stat` that fails with `EPERM` archives nothing and writes nothing.
5. History unreadable at launch: refresh stays incremental, history file untouched, totals unchanged.
6. Write order: an injected failing history save leaves `index.files` intact and the cache unsaved with the contribution still present.
7. Seed merge: totals add, unattributed remainder is in `totals` and in no `projects` key, `reconstructedSessions` carries the count, `mergeHistory` does not mutate `live`.
8. Wire: `history` crosses named, `fromWire(toWire(x))` round-trips it, no key of `projects` or `history` contains a path separator (extend `projection.test.mjs`).
9. Milestones: a threshold satisfied only by the seed is achieved with `earlier` and `fresh` is empty; one crossed live afterwards announces once.
10. `cv: 1` fixture archives under a bumped `INDEX_VERSION`.
11. `history.jsonl` rewritten shorter: prompt total and per-day counts do not fall.

## 7. Other places that also lose history today

- **`ingestHistory` resets prompts to zero when `history.jsonl` shrinks** ("Rewritten, start over"). Fix with the per-day diff rule into `history.prompts`: per day, `max(0, old - reread)`. A rewrite removes whole old days, and prompts have no per-file unit.
- **`listTranscripts` swallows a subtree `readdir` failure**, which is why orphaning is confirmed by a per-path `ENOENT`, never by absence from the listing.
- **`loadIndex` returns `emptyIndex()` on any parse failure**, so a corrupt cache loses live contributions with no archive step. History is a separate file and the cache write is atomic. Accepted.
- **The cache is saved once a minute and on quit.** A crash costs a minute of offsets, and those bytes are re-read. Not a loss; noted so nobody "fixes" it.
- **`hourly`, `projectHourly`, `recent` are pruned by design.** Windows, not history.
- **`fileCount` drops** from 812 to 463 the moment orphans are archived. Ship the "349 archived" strip text in the same release, or it reads as a second loss.
