# Codex usage

**Last updated:** 2026-10-26
**Primary sources:** `src/main/data/codex-usage.ts`, `src/main/data/history.ts`,
`src/shared/pricing.ts`, `src/shared/codex-view.ts`,
`src/shared/projection-wire.ts`, `src/main/index.ts` (Codex usage section)
**Design:** [design/codex-side-by-side.md](design/codex-side-by-side.md)
**Tests:** `test/codex-usage.test.mjs`

## Summary

The wall reads Codex's own session files the way it reads Claude Code's
transcripts, into a second index that shares Claude's folding code but none of
its state or files. The renderer gets the result as `codex` (a `CodexView`) in
the usage payload, present only when there is at least one Codex response on
record, so a wall without Codex looks exactly as it always did.

## What is read

One source: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one append-only file
per Codex session. The root is `~/.codex`, overridable with `MBW_CODEX_HOME`
(like `MBW_CLAUDE_HOME`).

Four kinds of line are parsed, and only these:

| Line | Fields used | Why |
|---|---|---|
| `session_meta` | `id`, `cwd`, `originator` | the session, its project, and who started it |
| `turn_context` | `model`, `cwd` | the model and project of the responses that follow |
| `token_usage_record` | `response_id`, `session_id`, `usage` | the tokens, one record per model response |
| `event_msg` `token_count` | `rate_limits` | Codex's own plan reading |

Every other line (`response_item`: messages, tool calls, reasoning) is skipped
by its top-level `type`, read from the head of the line, before any parse.
`auth.json`, prompts and message text are never read. T3 Code's database is not
a second source: its Codex threads are the `T3 Code` rollouts already read
here, and `src/main/data/t3-usage.ts` keeps reading Claude rows only.

## Normalisation

OpenAI counts cached tokens INSIDE `input_tokens`; Anthropic reports them
apart. Each record is mapped onto the wall's `TokenTotals` so that "tokens
processed" means the same for both providers:

| Wall field | Codex value |
|---|---|
| `input` | `input_tokens - cached_input_tokens` |
| `cacheRead` | `cached_input_tokens` |
| `cacheCreate` | `cache_write_input_tokens` |
| `output` | `output_tokens` (reasoning is already inside) |
| `thinking` | `reasoning_output_tokens` |
| `requests` | 1 |

The model is the one in the latest `turn_context` before the record, and the
project the latest `turn_context` cwd (else `session_meta`'s). Both are kept per
file with its byte offset, so a read that starts mid-file, after a restart
included, still prices and places its records.

## The same machinery as Claude

Every rule in [usage-indexing.md](usage-indexing.md) and
[usage-history.md](usage-history.md) applies, through the same code where it can:

- **Incremental by byte offset**, bounded at the stat'd size. A line is applied
  only once the line after it arrives or the slice ends on a newline, so a
  record whose newline has not been written yet is neither counted early nor
  counted twice.
- **A shrunk file rebuilds** the index; a deleted one is archived first.
- **Per-file contributions** folded through usage.ts `fold`, so a contribution
  and the index can never disagree.
- **Its own history store**, `codex-usage-history.json` in userData, made by
  the same `createHistoryStore` as Claude's `usage-history.json`: only a missing
  file counts as empty, an unreadable one archives nothing, and a path is in
  exactly one of the index and the store.
- **Its own cache**, `codex-usage-index.json`, with its own version. A version
  bump hands back every contribution, `pendingStale` included.
- **No double counting by `response_id`**: each contribution keeps the last 24
  characters of the ids it counted (the head of a real id is shared by a whole
  session; the tail is random), and a refresh skips any id already counted live
  or in history. On 26 Oct there were no duplicates in 762 records; this guards
  a forked session that copies earlier records into a new file.
- **Daily** by UTC date, **hourly** by UTC hour for 14 days, **activeDays** and
  the five-minute **intraday** slots by local day, and **active** stretches for
  Hours, all with the helpers Claude uses (`src/shared/intraday.ts`,
  `src/shared/active-time.ts`).

## Plan limits

The latest `token_count` reading with `limit_id: "codex"` and at least one
window, by the record's own time, is kept on the index as `limits`: the 5-hour
(`primary`) and weekly (`secondary`) windows with `used_percent`,
`window_minutes` and `resets_at` (seconds, stored as epoch ms), and the plan.
`premium` readings carry no windows and are ignored. A rebuild keeps the later
of the old and new readings. The view shows the reading's age, and a window
whose `resetsAt` has passed has reset (`windowCurrent` in codex-view.ts).

## Cost

At OpenAI API list prices, read 2026-10-26 (design doc section 3), in
`src/shared/pricing.ts`: `gpt-6-astra` 10 / 1 / 50, `gpt-6.1-sol` 2 / 0.10 / 10,
`gpt-6-luna` 0.10 / 0.01 / 0.50 per 1M tokens (input / cached input / output),
cache writes at the 30-minute rate (1.25x input). Exact ids only, plus a dated
snapshot of the same id; no prefix rules, because `gpt-6-sol` is a different
model. Any other id is unpriced: its tokens go to `unpricedTokens`, never to a
zero cost. Claude's prices and `REPRICED_AT` are untouched.

## Main process

`refreshCodex` mirrors `refreshUsage` on its own flags: serialised, coalesced to
one pass per 4 s, a debounced recursive watch on the sessions folder, and a
60-second sweep as the safety net. A machine without the folder costs one
failed access a minute and logs its absence once; the first pass that finds the
folder starts the watch. The cache loads at startup, before the first refresh,
and is saved every minute and on quit. A projection screen does not index.

The payload gains `codex` (live index merged with its history store) and
`todaySlots`, Claude's 288 local five-minute slots of today, summed across live
and archived transcripts. Both are omitted when they cannot be honest:
`todaySlots` while Claude's index is cold or rebuilding, `codex` while it has no
response yet. Settings gain `statsView` (`detailed` | `simple`, default
detailed) and `showCodex` (default true).

## Projection

The wire carries an optional `codex` block, built and re-validated by naming
every field. Codex projects are labelled by Claude's rule with the home folder
masked, and sent only when project names are shared; on arrival a key that
looks like a path is dropped. A source without Codex sends nothing, and an older
screen ignores the field.

## Measured on 2026-10-26 (this machine, read only)

40 rollouts read in about 330 ms: 762 responses, 55,066,228 tokens (cached
50,995,584), $65.78 at list prices ($60.80 astra, $4.71 sol, $0.26 luna), no
unpriced tokens, 40 sessions (35 started by Claude, 3 by Gustav, 2 by T3 Code),
4.15 hours by the five-minute-stretch method (Codex's own turn times sum to 5.3
hours, which include waits between responses), latest plan reading 09:39 UTC:
5-hour 99%, weekly 16%. These match the design doc's own count.
