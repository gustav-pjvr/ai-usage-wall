# Usage history: totals that never drop

**The rule (ARCHITECTURE rule 41):** a number the wall has shown never falls
because a transcript was deleted, a cache was discarded or the index was rebuilt.

Built 2026-09-22 after 0.9.13 halved Gustav's wall. Design:
[design/history-archive.md](design/history-archive.md).

## What happened

Claude Code deletes transcripts older than `cleanupPeriodDays`, 30 by default.
The usage index is a cache built from those transcripts, and its incremental scan
never subtracts, so the cache quietly went on counting files that no longer
existed. That was luck, not design. 0.9.13 bumped `INDEX_VERSION`, the cache was
discarded, the rebuild could only see the 463 transcripts still on disk, and the
wall fell from 39.35B tokens to 19.79B, from 812 transcripts to 463.

Three fixes:

1. **`cleanupPeriodDays: 36500`** in `~/.claude/settings.json`, so Claude Code
   stops deleting transcripts on this machine.
2. **A one-off seed** putting back what was lost, marked as reconstructed.
3. **The history store**, so it cannot happen again on any machine.

## How the store works

- Each transcript's contribution (`FileContribution`: totals, daily, models,
  projects, sessions, active days) is kept beside its offset in the index. The
  index and the contribution are filled by one function, `fold`, so they cannot
  disagree.
- When a transcript is **confirmed gone** (`stat` fails with `ENOENT` or
  `ENOTDIR`; a lock or a folder the listing skipped never counts), its
  contribution is written to `<userData>/usage-history.json` first. Only once
  that save succeeds is the path dropped and the index rebuilt from the files
  that remain.
- **A path is in exactly one of the index and the store.** A file restored from a
  backup is released from the store and measured live again, never counted twice.
- A cache from an older `INDEX_VERSION` is still discarded, but `loadIndex` hands
  back its contributions as `staleFiles`, and the first refresh archives the ones
  whose file is gone. A future version bump costs a reindex and nothing else.
- If the store cannot be read at launch, nothing is archived and nothing removed:
  the index keeps counting a deleted file, which is the old behaviour and loses
  nothing. The read is retried on every scan.
- `history.jsonl` rewritten shorter no longer resets the prompt count: the prompts
  it no longer holds are moved to the store per day.

Every consumer (the renderer, the projector, milestones) reads
`mergeHistory(live, store)` from `src/shared/usage-merge.ts`. It is pure: the live
index is updated in place by the indexer, and history written into it would be
counted again on the next pass.

## The seed

The ~350 transcripts deleted before the store existed had nothing left to
archive. They came back through a seed, built by hand from:

- **Claude Code's own `~/.claude/stats-cache.json`**, which kept per-day and
  per-model token counts to 2 Sep 2026. Its per-day numbers match the index's
  exactly for days where nothing was deleted, which is why it was trusted.
- **A screenshot of the 0.9.12 wall at 18:23 on 22 Sep**, for the exact totals,
  cost, per-model requests and the top five projects.
- **What the transcripts still on disk contributed up to 18:23**, subtracted from
  both.

| Recovered | Value | How exact |
|---|---|---|
| Tokens | 19,578,055,747 | exact (screenshot minus disk) |
| Cost | $16,480.82 | exact (screenshot minus disk) |
| Per model token split | stats cache | exact to 2 Sep; 43,007,573 tokens (0.2%) in no model |
| Requests | 54,217 | exact for five models; sonnet-4-6 and haiku estimated |
| Days | 41 with losses, 28 of them entirely lost | from the stats cache |
| Sessions, transcripts | 52, 349 | counts only, never placeholder sessions |
| Projects | Travel Game, polytrack-analysis, B2MX web, Physics Game | screenshot top five to 3 significant figures; the rest is shown as unattributed |

The seed file's own `notes` list every approximation. It is imported once from
`<userData>/history-seed.json` and the file is renamed afterwards. If the deleted
transcripts are ever restored from a backup, remove the `seed` key from the store,
or they will be counted in both.

## What the wall shows

- The status strip: *463 transcripts on disk, 349 archived*. Without it, the drop
  in the transcript count reads as a second loss. With the hero caption gone
  (below), this and the projects footnote are what disclose the reconstruction.
- **No caption under the headline.** A first version said *includes 19.6B tokens
  reconstructed from a snapshot of 22 Sep 2026* under the total. Gustav removed
  it on 2026-09-22 as unnecessary. Rule 12 is still met: the strip and the
  footnote say what is archived and what is unattributed, and the seed's own
  notes record every approximation.
- The sessions tile adds the reconstructed session count.
- The projects panel: *x% of tokens are in archived history with no project*,
  only when that is true.
- Milestones crossed only because the seed arrived are recorded as "earlier" and
  never announced (`seededHistoryAt` in the ledger).
- Over projection, `history` crosses as counts and totals only. The source phrase
  is dropped if it looks like a path.

## Verified by

- `test/usage-history.test.mjs` (40 checks, each fix revert-checked). The first block is the regression:
  index three transcripts, delete one, then relaunch with an older-version cache.
  Every merged map equals the original. Its control runs the same sequence
  without the store and shows the loss.
- `test/render-fit.cjs`: the footnote and the strip are present and inside their
  panels at all eight sizes.
