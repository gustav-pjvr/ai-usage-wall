# Milestones

A button at the top right with a small badge counting milestones not yet seen.
Clicking it opens the list: what is next on each ladder, and what has been
achieved. Nothing announces itself anywhere else. Gustav asked for exactly that:
on demand, with the badge as the only notification.

## What counts

| Ladder | Rungs |
|---|---|
| Tokens processed | 1B, 5B, 10B, 25B, 50B, 100B, 250B, 500B, 1T |
| Tokens generated | 10M, 25M, 50M, 100M, 250M, 500M, 1B |
| Requests | 10K, 25K, 50K, 100K, 250K, 500K, 1M |
| Streak of active local days | 7, 14, 30, 60, 100, 365 |
| First use of a model | any new model id |
| Biggest session | most requests in one session, most output in one session |

Fixed and round, so a number on the badge is never surprising.

## What deliberately does not count

- **No duration record.** A resumed session keeps its id, so start to end reads
  1107 hours on this machine. That is not how long anyone worked.
- **No money.** The badge lives on the desktop, and rule 24 keeps dollar figures
  off surfaces anyone walking past can read.
- **`<synthetic>` and `unknown`** are not models.

## The rules that keep it honest

1. **The first evaluation is silent.** Everything already crossed is recorded as
   seeded and nothing is announced, or a fresh install would light the badge with
   a year of history. The list shows those as "earlier", not with the date they
   happened to be noticed.
2. **Once, ever.** The ledger (`milestones.json`) lives outside the usage cache,
   like `peak.ts`, because the cache is thrown away on every index version bump.
3. **Only on a complete index.** Evaluation runs after `refreshIndex` resolves,
   never while indexing and never when the source is unreadable. A threshold
   announced from a half-built index could not be taken back.
4. **A record announces when a DIFFERENT session takes it.** The session holding
   a record grows on every refresh while it runs; announcing each step would
   turn the badge into a counter. Growth updates the value quietly.
5. **Tokens are counted as the headline counts them**, so "50B processed" agrees
   with the big number to the token.

## When the ledger cannot be read

A missing file is a first run and seeds silently. A file that exists but cannot
be READ (on Windows, a scanner holding it for a moment is enough) is different:
the ledger stays unloaded, nothing is evaluated or written, and the read is
retried on the next scan. Treating it as missing would reseed over the real file,
turning every honest date into "earlier" and emptying the badge, from a read that
would have worked a second later. Saves are serialised, so a scan and a click
marking the list seen can never race on the same temporary file.

## While the index is being rebuilt

"Next up" is measured against the index, so it is withheld while indexing, when
the source is unavailable, or when the index is still empty, and the list says
it is still reading. After an index version bump the index starts empty while
the ledger already holds "25B processed", and without this the list would have
offered "1B tokens processed, 1.0B to go" for the whole reindex.

## Streaks use local days

`daily` is keyed by the UTC date, and Gustav chose to keep it that way. The
streak reads `activeDays` instead: local days, filled at ingest (index version
4). Sessions could not stand in, for the same resumed-session reason as above.

## Where it lives

Local only. A paired screen does not index while paired and gets no ledger, so
its button is hidden. The ledger's session ids (the record holders) stay in the
main process; the renderer receives titles, dates and the badge count only.

## Verified by

- `test/milestones.test.mjs`: silent seeding, one announcement per crossing, a
  jump across two rungs, a smaller total after a rebuild taking nothing back,
  new models, streaks across a month end, quiet record growth against a takeover,
  next-up progress, and no money anywhere in the ledger. Checked by reverting:
  making the first run announce, or making record growth announce, both fail it.
- `test/render-fit.cjs`: the button and badge at all eight sizes, and a real click
  opening the list inside the window, marking it seen, and closing on a click
  outside.
