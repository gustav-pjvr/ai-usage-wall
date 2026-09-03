# Usage indexing

**Last updated:** 2026-09-03
**Code snapshot:** commit `a696f5d`. Every line reference below is against that
commit, because the working tree was being edited while this was written (see
[Drift at the time of writing](#drift-at-the-time-of-writing)).
**Primary sources:** `src/main/data/usage.ts`, `src/main/index.ts`,
`src/shared/project-label.ts`, `src/shared/projection-wire.ts`,
`src/renderer/stats.ts`

## Summary

Claude Stats reads Claude Code's own append-only JSONL transcripts out of
`~/.claude` and folds them into a single in-memory aggregate. There is no API and
no network on this path, so the design problems are not throughput or rate
limits: they are **not counting the same bytes twice**, **not presenting a
half-built index as a finished one**, and **not inventing a number the
transcripts cannot support**. This document covers where the data is, how the
incremental scan works, what the index holds, how a folder path becomes a label a
person can read, when a scan is triggered, and how an unreadable source is
reported rather than papered over.

Two things below were measured rather than read, and both contradict something
the repository currently claims: the offset invariant does not hold when a
transcript is appended to during a scan ([Bytes appended during a
scan](#bytes-appended-during-a-scan-are-counted-twice-measured)), and the project
labelling rule exists in two places ([Two implementations of the same
rule](#two-implementations-of-the-same-rule)).

---

## Where the transcripts live

Claude Code writes one append-only JSONL file per session:

```
~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl
~/.claude/history.jsonl
```

The root is resolved once at module load (`usage.ts:54`):

```
CLAUDE_HOME = process.env.MBW_CLAUDE_HOME || path.join(os.homedir(), ".claude")
```

The environment override exists so the "no Claude Code on this machine" path can
actually be exercised instead of reasoned about, and so a non-default location
can be pointed at without a rebuild. It is read at import time, so anything that
sets it has to set it before the module is required.

`listTranscripts` (`usage.ts:151`) walks the tree recursively and takes only
`.jsonl` files. A `readdir` failure at any level returns an empty list **for that
subtree** rather than throwing, so one unreadable folder costs its own contents
and nothing else.

**Measured on this machine on 2026-09-03:** 433 transcripts, 1011.6 MB, across 21
project folders. `ARCHITECTURE.md` records 419 transcripts and 961 MB from an
earlier measurement. Both are right for their date, and neither should be quoted
as a constant.

### The folder name is never parsed

The project folders are the working directory with its separators flattened, so
they look like `C--Users-...-muchbetter-client-wall`. Nothing in this codebase
decodes that. Project grouping comes from the `cwd` field **inside each record**
(`usage.ts:230`). That matters twice over: a slug this app cannot reverse costs
nothing, and the displayed path keeps its original casing and separators because
it was never mangled in the first place.

### What a record looks like, and what is actually read

The indexer reads seven things and ignores the rest of the record
(`usage.ts:208-226`, `usage.ts:264-266`):

| Read | From | Becomes |
|---|---|---|
| `message.usage.input_tokens` | assistant record | `totals.input` |
| `message.usage.output_tokens` | assistant record | `totals.output` |
| `message.usage.cache_creation_input_tokens` | assistant record | `totals.cacheCreate` |
| `message.usage.cache_read_input_tokens` | assistant record | `totals.cacheRead` |
| `message.usage.output_tokens_details.thinking_tokens` | assistant record | `totals.thinking` |
| `message.usage.server_tool_use.web_search_requests` and `web_fetch_requests` | assistant record | `totals.webSearch`, `totals.webFetch` |
| `timestamp`, `cwd`, `sessionId`, `version`, `message.model` | assistant record | buckets, sessions, projects, `latest` |

Every one of them is defaulted with `|| 0` or reached through `?.`, and that is
not defensive habit. **Sampled from a real record on this machine on 2026-09-03**,
the usage block carried `input_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, `cache_creation`, `output_tokens`, `service_tier` and
`inference_geo`, with **no `output_tokens_details` and no `server_tool_use` at
all**. Thinking tokens and server tool counts are therefore genuinely optional in
the corpus, and a zero in those panels can mean "none" or "not reported by that
model version". The top-level keys on the same record were `parentUuid`,
`isSidechain`, `agentId`, `message`, `requestId`, `attributionAgent`, `type`,
`uuid`, `timestamp`, `effort`, `userType`, `entrypoint`, `cwd`, `sessionId`,
`version` and `gitBranch`.

`message.content` is never touched. The line is parsed by `JSON.parse`, seven
fields are copied out, and the object is dropped on the next loop iteration.

### `history.jsonl` is prompts, and only their count survives

Keys observed on this machine: `display`, `pastedContents`, `timestamp`,
`project`, `sessionId`. `display` is the prompt text.

`ingestHistory` (`usage.ts:301`) reads `o.timestamp` and nothing else. It keeps a
running total, a per-day count and the latest timestamp (`usage.ts:322-326`). The
prompt text is parsed into a throwaway object and never stored, never cached and
never serialised: `projection-wire.ts:206-213` puts prompt **counts** on the wire
and drops even the file bookkeeping.

### What cannot be read at all

Recorded here because the absence is a decision, not an oversight
(`usage.ts:18-28`, `usage.ts:167-175`):

- **Quota, plan limits and reset times.** A limit appears only as free text inside
  a transcript, which is indistinguishable from an assistant message discussing
  rate limiting. A first attempt counted 200 events, which turned out to be its
  own cap: it had matched conversations about building rate limiters.
- **Money.** On a subscription, per-token pricing is not what is billed, so a
  currency figure would be invented.
- **The Anthropic Usage and Cost Admin API** needs an organisation admin key,
  does not cover subscription usage, and no such key exists here.

---

## The incremental scan

`refreshIndex(index, onProgress)` (`usage.ts:366`) mutates the index in place and
returns `{ index, rebuilt }`. One pass does five things:

1. **Reachability.** `fs.access(PROJECTS_DIR)` then list. A failure here is the
   only route into the unavailable state (`usage.ts:374-381`).
2. **Shrink check.** For every already-known file, compare the current size
   against the recorded size (`usage.ts:389-403`).
3. **Sizing pass.** Stat every file, total the bytes, total the pending bytes and
   decide whether this is a cold pass (`usage.ts:410-427`).
4. **Ingest.** For each file, skip it when `size <= known.offset`, otherwise read
   from `known.offset` (`usage.ts:443-459`).
5. **History, prune, stamp** (`usage.ts:462-466`).

### Why offsets rather than re-parsing

A full parse of the corpus is 961 MB in about 5.5 s on this machine, roughly
174 MB/s (`usage.ts:32`). That is a fine one-off cost and an absurd per-update
one. The files are append-only, so a refresh only has to read what was appended,
which is why `files` is a map of `{ size, offset }` per path (`usage.ts:92`) and
why the whole design hangs on that number being right.

### Reading one file

`ingestFile` (`usage.ts:181`) opens a read stream at `fromOffset`, runs it through
`readline` and folds each record in. Three details are load bearing:

- **It yields to the event loop every 2000 lines** (`usage.ts:194`). A cold pass is
  several seconds of work and the wall has to keep painting through it.
- **It prefilters before parsing** (`usage.ts:196-199`): lines under 40 characters
  and lines without the substring `"usage"` never reach the JSON parser, because
  only assistant records carry a usage block.
- **It never throws** (`usage.ts:292-295`). A parse failure skips one line. An
  unreadable or mid-write file returns the **old** offset, so the same bytes are
  attempted again on the next pass.

A truncated final line, which is what an active session looks like at any given
instant, fails `JSON.parse` and is skipped (`usage.ts:202-206`).

### Bytes appended during a scan are counted twice (measured)

`ARCHITECTURE.md` states the invariant as "after a refresh every tracked offset
equals its file size, so no byte can be read twice", and `Do not break` rule 13
repeats it. **The invariant holds literally and does not deliver what it
promises.**

The size is stat'd in step 3, the stream is opened with a `start` and **no `end`**
(`usage.ts:188`), and the function returns that same pre-read `size`
(`usage.ts:297`), which the caller records as the offset (`usage.ts:455`). A
stream with no `end` reads to whatever EOF is when it drains. So anything appended
between the stat and the end of the read is ingested **and** left ahead of the
recorded offset, and the next pass reads it again.

Reproduced on 2026-09-03 with a synthetic `MBW_CLAUDE_HOME`, a 26.3 MB transcript
of 120,000 records, and 1,000 more records appended 60 ms into a scan that takes
about 350 ms:

```
control  : requests=120000  offset=27600000  size=27600000  scan=351ms
appended during the scan
pass 1   : requests=121000  offset=27600000  size=27600000  (file is now 27830000)
pass 2   : requests=122000  offset=27830000  size=27830000
expected : 121000
RESULT: DOUBLE COUNTED by 1000 records
```

Note what pass 1 shows: 121,000 records ingested, offset left at 27,600,000. The
recorded offset does equal the recorded size. It simply is not where the reader
stopped.

In normal use the exposure is small, but it is biased towards exactly the wrong
moment, because the trigger is a file-change event and a scan therefore starts
while a session is writing. The obvious candidate fix is to bound the read with
`end: size - 1` so the stream cannot pass the byte count that gets recorded, or to
return the count actually consumed instead of the stat. **Neither has been tried
here and neither is claimed to work**; this document reports measured behaviour,
not a patch. `ARCHITECTURE.md` records an independent recount landing within three
requests of the indexer (72,057 against 72,060), attributed at the time to records
appended while the recount ran. That may or may not be related, and no claim is
made here that it is.

### When a file shrinks or is replaced

A shrunk file was rewritten, and incremental aggregates cannot be reversed:
nothing in the index remembers which records came from which file. So the only
honest response is to throw the whole thing away and rebuild
(`usage.ts:398-402`), which recurses into a fresh `emptyIndex()` and returns
`rebuilt: true`. `index.ts:212` logs it. The alternative was serving numbers
already known to be wrong.

Two limits of that check, both read from the code rather than measured:

- **Only shrinkage is detected.** The comparison is `size < known.size`
  (`usage.ts:398`). A file rewritten to exactly the same length is not caught, and
  because `size <= known.offset` is then also true it is skipped entirely
  (`usage.ts:447`), leaving the old aggregates in place. A rewrite that ends up
  larger has its tail read from the old offset and mixed into the old totals. Both
  are safe only because transcripts really are append-only.
- **Nothing is ever removed from `files`.** No code path deletes an entry, so a
  transcript deleted from disk keeps its slot. The "N transcripts indexed" reading
  in the status strip (`stats.ts:1106`, fed by `index.ts:1110`) is therefore
  "transcripts this index has ever seen", not "transcripts on disk now". The two
  diverge only after a deletion, and clearing the cache reconciles them.

### Cold versus warm, and why the loading state needs to know

```
cold = no known files at all, or more than half the total bytes still pending
```

(`usage.ts:427`.) Progress is reported through a callback throttled to one call
per 120 ms (`usage.ts:432-439`), because 433 files would otherwise mean 433 IPC
messages, and `pushUsageProgress` drops anything that is not cold
(`index.ts:1117-1124`). A warm top-up finishes faster than a frame could be drawn,
so reporting it would only flicker the loading panel.

---

## The shape of the index

`UsageIndex` (`usage.ts:88-108`):

| Field | What it holds | Why it exists |
|---|---|---|
| `version` | `INDEX_VERSION`, currently 2 (`usage.ts:59`) | `loadIndex` discards a cache with any other value (`usage.ts:476`) |
| `builtAt` | ISO stamp of the last completed pass | |
| `files` | path to `{ size, offset }` | the whole incremental scheme; stripped before IPC |
| `totals` | the eight counters | the hero and the counter tiles |
| `daily` | `YYYY-MM-DD` to totals | kept forever; drives the daily chart and "days active" |
| `hourly` | `YYYY-MM-DDTHH` to totals | kept 14 days (`HOURLY_DAYS`, `usage.ts:62`), pooled into a 24 hour profile |
| `models` | model name to totals | the model split |
| `projects` | lowercased `cwd` to totals plus `lastSeen` and `display` | the project split |
| `sessions` | session id to start, end, requests, output, total, cwd, models | session count and spans |
| `recent` | `[epochMs, totalTokens, outputTokens]`, capped at 600 (`RECENT_EVENTS`, `usage.ts:64`) | the only time-resolved structure, and the input to velocity and the live trace |
| `prompts` | total, per-day, `lastAt`, plus its own offset and size | prompt counts from `history.jsonl` |
| `latest` | ts, model, sessionId, version, cwd of the newest record | the status strip and "last record" |
| `lastScanMs` | wall-clock of the last pass | shown in the strip, and the honest cost of a refresh |
| `unavailable`, `unavailableReason` | source readability | see below |

`prune` runs after every pass (`usage.ts:340-347`): `recent` is sorted by
timestamp and clipped to the newest 600, and hourly buckets older than 14 days are
deleted. Both bounds exist so the cache file and the load time stay small, and
both have a visible consequence, covered in `docs/derived-metrics.md`.

### The disk cache

`loadIndex` and `saveIndex` (`usage.ts:472-489`), file at
`<userData>/usage-index.json` (`index.ts:180`). Three decisions worth knowing:

- **A UTF-8 BOM is stripped before `JSON.parse`** (`usage.ts:475`), the same rule
  as the client store. `JSON.parse` rejects a BOM and the failure is invisible:
  the file looks perfect and is silently ignored.
- **A version mismatch discards the cache** rather than migrating it, which is the
  right call for something rebuildable from the transcripts in 5.5 s.
- **The write is atomic**: `.tmp` then `rename` (`usage.ts:485-488`), so a crash
  mid-write cannot leave a truncated cache that then loads as a real one.

The cache is written at most once a minute (`USAGE_SAVE_INTERVAL_MS`,
`index.ts:101`, applied at `index.ts:213-218`) plus once on quit
(`index.ts:1356`). It used to be rewritten on every refresh, which during an
active session meant a 170 KB file rewritten about once a second for a benefit
that only lands on the next cold start.

---

## Project labelling

Raw keys are absolute paths. Three transformations turn them into something a
person reads, without leaking anything.

### 1. Case folding, because Windows gave us two of everything

`index.projects` is keyed by `cwd.toLowerCase()` and keeps the original string in
`display` (`usage.ts:237-238`). Claude Code records the working directory with
whatever drive-letter case the shell used, so the same folder appeared as both
`C:\...` and `c:\...` and was counted as two projects with the same display name.
Grouping is case-insensitive, reading is not.

### 2. Leaf name, unless it is ambiguous

`labelProjects(paths)` (`project-label.ts:23`) counts how many paths end in each
leaf segment, lowercased, then labels each path with its leaf, or with
`parent / leaf` when that leaf is not unique and a parent exists
(`project-label.ts:34-35`).

The naive version broke on real data: two different working directories both ended
in `Travel Game`, so the panel listed the same name twice with different numbers
and no way to tell them apart (`project-label.ts:10-14`).

The result depends only on the **set** of paths, never on their order, which is
what lets a source machine and a projected screen agree without exchanging
anything about ordering. `test/projection.test.mjs:186-197` asserts exactly that,
including a reversed-input equality check.

### 3. Home directory masking, on the wire only

If Claude Code is run from the home folder itself, the leaf **is** the Windows
username, and a same-named folder directly under home would carry the username as
its parent prefix. Either one puts the username on the network, which the consent
dialog promises will not happen.

`maskHome` (`projection-wire.ts:116-123`) splits a label on `" / "` and replaces
any segment equal to the home directory's leaf, case-insensitively, with the
literal `home`. The value comes from `path.basename(os.homedir())`, computed once
(`source.ts:53-57`) and passed in as `homeDirName` (`source.ts:368`). It is
applied to project labels (`projection-wire.ts:140`) and to `latest.project`
(`projection-wire.ts:187`).

It is deliberately **not** applied locally. On your own machine the folder is
yours and the real name is the useful one; the masking exists because of who else
can see it. `test/projection.test.mjs:163-184` covers it, including the case where
the index key and the display string differ in case.

### Two implementations of the same rule

`project-label.ts:1-15` says the function was lifted out of the renderer precisely
so that projection and the local dashboard could not drift. **The renderer still
has its own inline copy** at `stats.ts:1016-1033`, and `stats.ts` does not import
`project-label.ts` at all.

The two agree today: same leaf-count rule, same lowercased comparison, same
`parent / leaf` join. But only the shared one is under test, so a change to the
tested copy would not move the panel a person actually looks at, and a change to
the renderer copy would not be caught by anything. Recorded as a finding; nothing
in this documentation task changed source.

---

## Scheduling: what triggers a scan

**Nothing polls.** There is no server to ask and no quota to spend, so a timer
could only add latency of up to one interval and burn work while idle
(`usage.ts:37-41`).

| Trigger | Where | Notes |
|---|---|---|
| Startup | `index.ts:1531-1536` | the cached index is loaded first, then one scan, then the watcher starts |
| Transcript write | `index.ts:247-261` | native recursive `fs.watch` on the transcript tree, debounced 900 ms |
| Projection turned off | `index.ts:1519-1522` | a machine that had been a screen resumes indexing, guarded by `!isDev` |

Windows supports recursive `fs.watch` natively, so one watcher covers every
transcript without chokidar walking a gigabyte of tree. The 900 ms debounce exists
because a single assistant turn produces several writes.

### Two floors, for two different reasons

- **`USAGE_MIN_INTERVAL_MS = 4000`** (`index.ts:111`). The watcher fires roughly
  once a second during an active session. That is accurate and restless to look
  at, and the wall is meant to be glanceable. `refreshUsage`
  (`index.ts:188-238`) coalesces: a call inside the window sets a dirty flag and
  schedules one trailing pass, and a call arriving while a scan runs sets the same
  flag and is picked up in the `finally`. Nothing is missed, it lands together.
- **`USAGE_SAVE_INTERVAL_MS = 60000`** (`index.ts:101`), covered above.

`usageBusy` serialises scans (`index.ts:189-192`), so a burst of file events
cannot start overlapping reads over the same bytes.

### What crosses to the renderer

`usageForRenderer` (`index.ts:1097-1111`) sends a reduced copy:

- **`files` is dropped**, because the renderer never reads the offset map and it
  was half of a 170 KB payload crossing IPC about once a second.
- **`fileCount`** replaces it.
- **`indexing`** is attached explicitly. `refreshIndex` mutates in place, so a
  half-built index is observable, and inferring readiness from "has some data"
  once presented 5 of 419 transcripts as the final totals: 11.5M tokens, 3 days
  active, 2 sessions, all wrong and all looking authoritative. Readiness is stated
  by the main process (`Do not break` rule 15).
- **`projection`** status rides along, because on a screen every honesty rule in
  the renderer keys off the link rather than off the local source.

A machine acting as a projection screen does not index at all. Its own `usage` is
an empty index, and returning it would paint a wall of zeros
(`index.ts:1103-1108`).

The payload goes out on the `wall:usage` channel (`index.ts:1136`), reaches the
renderer through the only bridge (`preload/index.ts:19-23`) and lands in
`StatsView.update`.

---

## The unavailable state

Set in exactly one place (`usage.ts:374-381`): the projects directory could not be
accessed or listed. The reason string names the path and the OS error, which is
right for a local status strip and wrong for a network frame, so
`projection-wire.ts:227-229` replaces it with the fixed string `the source cannot
read its transcripts`.

The renderer draws **two different absences**, and the distinction is the point
(`stats.ts:827-843`, `stats.css:850-863`):

| State | Condition | What the user sees |
|---|---|---|
| `is-nodata` | unreadable **and** `totals.requests === 0` | a panel saying there is no Claude Code data on this machine, plus the reason |
| `is-stale-data` | unreadable **and** cached numbers exist | the real numbers stay on screen at 55% opacity, desaturated, with a `NOT LIVE` marker on the hero |

Zeros in every panel would read as a measurement of zero usage, which is a claim.
An absence is not a measurement, so it is worded as an absence
(`stats.ts:1136-1183`).

Cached but stale numbers stay up because they were true when they were read. What
changes is everything that could imply they are current: the status strip turns
amber (`stats.css:604`) and the throughput footer loses its activity dot and takes
the warning colour (`stats.css:928-929`), because that footer is computed from
record timestamps inside the data, which on a dead source still look recent.

---

## Drift at the time of writing

The working tree had uncommitted changes in this area while this was written, and
they are listed so a reader is not surprised:

- `src/shared/velocity.ts` (new, untracked): `velocityOf()` extracted so the
  renderer and the main process share one definition of tokens per minute.
- `src/main/data/peak.ts` (new, untracked): an all-time peak velocity high water
  mark, persisted separately from the usage cache precisely because that cache is
  designed to be discarded on a version bump.
- `src/main/data/usage.ts`: an optional `peak` field added to `UsageIndex`.
- `src/renderer/stats.ts`: `derive()` now calls `velocityOf()`, and a peak readout
  was added to the velocity panel.

None of that changes anything described above, but line numbers in a working tree
will not match `a696f5d` once it lands.

## Related

- `docs/derived-metrics.md`, for what is computed from this index and why it is
  labelled the way it is.
- `docs/testing.md`, for what is and is not guarded. Note that nothing in `test/`
  currently covers `usage.ts`.
- `ARCHITECTURE.md`, sections "Claude Stats" and "Projection".
