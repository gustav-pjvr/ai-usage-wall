# Codex beside Claude: reading Codex usage, and the side-by-side dashboard

**Status:** design, 2026-10-26. Requested by Gustav: "look into and design
reading of all Codex usages and then we need a rework of the dashboard to show
claude and codex side by side", "with codex being able to be toggled off from
view". Layout choices are Gustav's (section 4); nothing is built yet.

## 1. Where Codex usage lives (measured 2026-10-26)

**One source: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl`.**
One append-only JSONL file per Codex session, like Claude Code's transcripts.
40 files, 53 MB, first record 2026-10-22 12:36 UTC (Codex was installed on
22 Oct). No archive folder and no cleanup setting in `~/.codex/config.toml`.

Who started them, from each file's `session_meta.originator`:

| Originator | Sessions | What it is |
|---|---|---|
| `codex_exec` | 35 | Claude's Codex jobs (`~/.claude/scripts/codex-job.sh`) |
| `codex-tui` | 3 | Gustav in the Codex terminal UI |
| `T3 Code` | 2 | Codex threads run inside T3 Code |

**T3 Code is not a second source.** Its database (`~/.t3/userdata/statev2.sqlite`)
holds the same two Codex threads (29 turns), under synthetic thread ids, and
their times match the two `T3 Code` rollout files (23 Oct 21:52 to 24 Oct 08:42,
and 26 Oct 09:19 to 09:37). Reading both would count them twice, so the wall
reads rollouts only and keeps ignoring `provider = 'codex'` rows in T3's
database. `~/.codex-jobs` holds job briefs and reports, not usage: its runs are
already the `codex_exec` rollouts.

### Records that matter

| Record | Holds | Use |
|---|---|---|
| `session_meta` (line 1) | session id, `cwd`, `originator`, `cli_version` | project, and who started it |
| `turn_context` | `model`, `effort`, `cwd` for the turns that follow | model per response |
| `token_usage_record` | one per model response: `response_id`, `usage` {`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`} | **the token source** |
| `event_msg: task_started` / `task_complete` | turn start (`started_at`) and end | exact turn durations |
| `event_msg: token_count` | running session totals, plus `rate_limits` | **plan limits** (below) |

762 `token_usage_record`s, 0 duplicate `response_id`s, 55,066,228 tokens:
input 54,427,263 (of which cached 50,995,584), output 638,965 (of which
reasoning 138,275). By model: `gpt-6-astra` 27.4M, `gpt-6.1-sol` 14.0M,
`gpt-6-luna` 13.7M. 69 completed turns, 5.3 hours of turn time.

### The units differ from Claude's, and must be normalised

OpenAI counts cached tokens INSIDE `input_tokens`; Anthropic reports
`input_tokens` (uncached) and `cache_read_input_tokens` separately. So for a
Codex response, mapped onto the wall's existing `TokenTotals`:

| Wall field | Codex value |
|---|---|
| `cacheRead` | `cached_input_tokens` |
| `input` (fresh) | `input_tokens - cached_input_tokens` |
| `cacheCreate` | `cache_write_input_tokens` (0 in every record so far) |
| `output` | `output_tokens` (already includes reasoning) |
| `thinking` | `reasoning_output_tokens` |
| `requests` | 1 per `token_usage_record` |

With that, "tokens processed" means the same thing for both (input + output +
cache reads + cache writes, each counted once), and Codex's 55.1M is directly
comparable with Claude's figure.

### Plan limits: Codex has them, Claude does not

Every `token_count` event carries `rate_limits` for `limit_id: "codex"`:
`primary` (the 5-hour window) and `secondary` (the weekly window), each with
`used_percent` and `resets_at`, plus `plan_type` (`plus`). Latest reading,
2026-10-26 09:39 UTC: 5-hour 99% used, weekly 16%. This is a real, measured
quota, which the wall has never been able to show for Claude (it is not on
disk; see `src/main/data/usage.ts`). Two honesty rules:

- It is a reading taken when Codex last ran, not live. Always show its age.
- Once `resets_at` has passed, the window has reset: show "reset since", never
  the stale percentage.

`limit_id: "premium"` readings carry no windows and are ignored.

## 2. Reading it: same machinery as Claude, a second index

The Claude indexer already does everything Codex needs: byte-offset
incremental reads of append-only JSONL, per-file contributions (so a deleted
file moves to history instead of vanishing), local-day five-minute `intraday`
slots, `activeDays`, per-file `active` stretches for Hours, a cache with a
version, and a history store. So:

- **`src/main/data/codex-usage.ts`**: a record parser that turns one rollout
  line into the same `(rec: TokenTotals, meta)` the Claude parser produces, fed
  into the same `fold`, `foldIntraday` and `foldActive`. Model and cwd come
  from the latest `turn_context` / `session_meta`, remembered per file in its
  entry so an incremental read that starts mid-file still knows them.
- **A second `UsageIndex`**, its own cache file (`codex-usage-index.json`) and
  its own history store (`codex-usage-history.json`), so neither provider's
  numbers can leak into the other's and Claude's existing files are untouched.
- **A filesystem watch** on `~/.codex/sessions`, debounced like the Claude one.
  Overridable with `MBW_CODEX_HOME`, as Claude's is with `MBW_CLAUDE_HOME`.
- **Latest `rate_limits` reading** kept on the index (timestamp, both windows,
  plan).
- **Hours**: the same five-minute-stretch method as Claude, so the two hours
  figures mean the same thing. Codex's exact turn times (5.3 h) are the
  yardstick in tests, as `turn_duration` was for Claude.
- **Cost at API list prices**: OpenAI's published per-token prices for the
  three models (input, cached input, output; reasoning billed as output),
  priced by each record's own time like Claude since index version 8. A model
  with no published price counts as unpriced, shown as a caveat, never zero.
  Prices: see section 3.
- **Who started it**: `originator` kept per session, so the wall can say how
  much of Codex's work Claude delegated (35 of 40 sessions today).
- **Projection wire**: a `codex` block (totals, daily, models, hours, limits),
  optional, so older screens ignore it. A source without Codex sends nothing.

Nothing reads chat text, prompts or `auth.json`.

## 3. Prices

Read from https://developers.openai.com/api/docs/pricing on 2026-10-26
(standard tier, short context, USD per 1M tokens):

| Model | Input | Cached input | Cache write (30m / 12h) | Output |
|---|---|---|---|---|
| `gpt-6-astra` | 10.00 | 1.00 | 12.50 / 25.00 | 50.00 |
| `gpt-6.1-sol` | 2.00 | 0.10 | 2.50 / 5.00 | 10.00 |
| `gpt-6-luna` | 0.10 | 0.01 | 0.125 / 0.25 | 0.50 |

- Long context (over 272K input tokens) costs more, but Codex's context window
  is 258,400 and the largest prompt on record is 243,048, so it cannot apply.
- Reasoning: in all 762 records `reasoning_output_tokens <= output_tokens` and
  `total_tokens = input_tokens + output_tokens`, so reasoning is inside output
  and is billed once, at the output rate.
- Cache writes are 0 in every record so far; priced at the 30-minute rate if
  they ever appear, since the record does not say which.
- Other ids in Codex's model list (`gpt-6-sol`, the `gpt-5.6` family) have
  official prices too; `gpt-reserve` and `codex-auto-review` have none and
  would count as unpriced.
- On the Plus plan nothing is billed per token (learn.chatgpt.com/docs/pricing),
  so like Claude's this is "at API list prices", not a bill.

Today: `gpt-6-astra` $60.80, `gpt-6.1-sol` $4.71, `gpt-6-luna` $0.26,
total **$65.78**.

## 4. The dashboard

Gustav's requirements (2026-10-26): Claude and Codex side by side; Codex can be
toggled off; a **simplified view** plus the **detailed view** (the current
dashboard); the design is brought to him before anything is released.

Mock: `docs/design/mock/index.html` (open with `?simple`, `?detailed`,
`?simple-off`, `?detailed-off`), screenshots beside it at 1920x1080 and
1366x768. Real figures from 26 Oct; it is a mock, not the app.

**Controls**, top right beside Today / Any day / Milestones: a `Simple |
Detailed` switch and a `Codex` on/off toggle, both remembered in settings like
the top panel choice. A wall with no Codex data (any other install of the stats
edition) shows no Codex toggle and behaves as if it were off.

**Colours.** Claude keeps the wall's signal teal; Codex is violet
`oklch(0.74 0.15 295)`, clear of the teal, the cost green and the amber used
for derived figures and peaks.

**Simple view.** Two large cards, Claude Code and Codex, each: models used,
tokens processed (huge), cost at API list prices, hours, requests today, the
last 14 days as bars on its own scale; Codex adds its plan limits (5-hour and
weekly, with reset times and the reading's age), Claude says plainly it has
none on disk. Below, full width, **Today, side by side**: two lanes on one
24-hour axis showing every five minutes each was working, and "Claude started
35 of 40 Codex sessions". Codex off: one Claude card across the full width and
one lane.

**Detailed view.** The current grid, with Codex woven into each panel: a
second figure under the hero, ringed constellation stars where Codex worked
too, cost and hours split, a Codex plan panel in the right stack, a Claude |
Codex column in Totals, daily activity and "when you work" as mirrored bars
(Claude up, Codex down), both efficiency figures, and Codex models and projects
listed below Claude's. Codex off: exactly today's dashboard.

**Scale rule.** Codex is 0.07% of the two together, so on a shared scale it
would be invisible. Every chart gives each its own scale and says so; the hero
states the share in words.

## 5. Next release: Claude plan limits (Gustav, 2026-10-26)

Asked for after trying 0.10.0: "Why cant we have the usage limits for claude
here too?" The 2026-10-10 survey said Claude Code keeps no plan limits on
disk. That was wrong: `~/.claude.json` holds `cachedUsageUtilization`, a
reading Claude Code fetches itself (`fetchedAtMs`, last seen 2026-10-26 12:17
UTC). Fields used, nothing else (the file also holds account details and
tokens; read only this key):

- `utilization.five_hour` and `utilization.seven_day`: `utilization` (percent
  used) and `resets_at` (ISO).
- `utilization.limits[]`: `kind` (`session`, `weekly_all`, `weekly_scoped`),
  `percent`, `resets_at`, `severity`, and for `weekly_scoped` the model
  (`scope.model.display_name`, e.g. "Fable").

Checked the same minute against T3 Code's Limits page, which shows percent
LEFT: Claude session 14% left (86% used), weekly 93% left (7% used), weekly
Fable 100% left (0% used), resets matching to the minute.

Decisions:
- A Claude plan panel beside Codex's, in the Detailed view's right stack and
  on the Simple view's Claude card (replacing "no plan limits on disk").
- Displayed exactly as the Codex panel: percent USED, reset times, and the
  reading's age; a window past its `resets_at` shows as reset, never the
  stale percent. One row per window: session, weekly, and each scoped weekly
  limit (e.g. "Week, Fable").
- Read-only, only that key, never any credential; a missing or malformed key
  hides the panel (never 0). Watched like the transcripts, since Claude Code
  rewrites the file when it refreshes the reading.
- Paired screens: carried in the wire like Codex's limits.
