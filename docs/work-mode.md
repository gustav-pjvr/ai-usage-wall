# Work mode

The monday Tasks board on the wall, with actions and notices. Full build only:
the shareable Claude Stats Wall contains none of it. This is phase 1 (tasks);
mail is phase 2. Design and Gustav's decisions:
[design/work-mode.md](design/work-mode.md).

## Setup: connect monday

1. In monday, click your avatar (top right), then **Developers**.
2. Open **My access tokens** and copy your personal API token.
3. On the wall: tray, **Connect monday...** (or the **Connect monday** button the
   Work view shows while it has no token). Paste the token and click
   **Connect**.

The wall checks the token with monday before it keeps it: monday must say it
belongs to Gustav (user `119615221`). A token for another user, a mistyped one,
or one monday refuses is not stored, and the dialog says which. The field is
cleared the moment Connect is clicked, whatever happens next.

**Disconnect monday** in the tray deletes the token from the PC.

## Using it

- **Switching.** The control at the top reads **Claude Stats | Work**. `Tab`
  flips between them, and the tray has **View**. The choice is saved
  (`settings.json`, `mode`).
- **The board.** A summary strip (in progress, waiting, overdue, due this week,
  new from Jaco, done this week), then four columns: In progress, Waiting on
  someone else, Backlog, and Done in the last 7 days. Dropped tasks are not
  shown. Open columns are ordered by due date, soonest first; Done newest
  first. Every column scrolls with the wheel or by dragging.
- **Mine | Everyone**, top right. Mine (the default) is every task whose Owner
  includes Gustav. The summary counts what the filter shows.
- **A card** shows the name, the project, a priority pill, the due date (red
  when overdue), owner initials, and "New, assigned by Jaco" for a task Jaco
  gave Gustav that has not been started.
- **Actions.** Click a card for its controls: move to In progress, Waiting,
  Backlog, Done or Dropped (the Status label and the matching group, as the
  monday-sync skill does it); priority; due today, tomorrow, in a week, a
  picked date, or cleared; a comment; **Open in monday**. **+ Task** (top
  right) takes a name, a priority and a due date and puts the task in Backlog,
  owned and assigned by Gustav.
- **Every action** shows a pending state, then either monday's own read-back
  or a plain failure. The card moves only after monday has confirmed it: a
  write that monday accepts but that does not read back as asked is reported
  as a failure, not shown as done. A failed comment reopens its box with the
  text still in it.
- **Typing** (a comment, a date, a new task) borrows keyboard focus from
  Windows the way the notes bar does ([notes-bar.md](notes-bar.md)). If the
  wall cannot take focus, the box stays read-only and says so.
- **Status strip**, along the bottom: "monday synced 20s ago", or the failure
  in plain words (token refused, unreachable, rate limited).

## Sync

All network traffic is in the main process (`src/main/work/`); the wall's page
keeps `connect-src 'none'`.

- **One request per tick.** It asks for the board's activity log since the
  last poll less two minutes (`activity_logs(from:, limit: 200)`), the board's
  last 25 updates (ids, authors and items only, never their text), and the
  complexity left. The items are read again only when the log shows a change
  (one more request), after an action, and every 10 minutes as a safety net
  (that read rides on the tick's own request).
- **When.** Every 60 seconds on weekdays from 07:30 to 18:00 (local time),
  every 15 minutes otherwise, waking at 07:30. A weekday with no changes is
  684 requests and a weekend day 96, measured by `test/work.test.mjs`,
  inside monday's 1,000-call daily cap (Standard; the plan tier cannot be read
  with this token) with room for actions. The coordinator asked for 5 minutes
  outside working hours: that is 792 requests a weekday, over the 700 target,
  so the quiet interval is 15 minutes (`QUIET_TICK_MS` in
  `src/main/work/sync.ts`).
- **What changed.** A change counts when its log entry is new (ids
  de-duplicate) and no older than the previous poll less two minutes. The
  notice is decided from the entry itself where it says what changed (the
  Status label before and after, the Owner or Assigned-by people, the source
  and destination group of a move), so a change whose items were read before
  its log entry arrived still notifies, once. Entries that do not say (such as
  `create_pulse`) fall back to comparing the two polls' items. A full page of
  200 entries reads the next page, up to 5; past that the poll logs the count
  and reads the items again. `from` is sent in whole seconds
  (`2026-11-06T11:58:00Z`). Log entries are UUID strings with `created_at` in 1e-7 s since the
  epoch, as measured on the account on 2026-11-06. The app sends
  `API-Version: 2026-10`, where `activity_logs` is a flat list; 2027-01 wraps
  it in a paginated `{ logs }` object, so the query and the header change
  together.
- **Limits and failures.** Every request ends within 20 seconds (an abort
  signal, and a race for a request that ignores it); a stall reads as offline.
  The daily cap (`DAILY_LIMIT_EXCEEDED`) says so in plain words with its reset
  (02:00 SAST) and stops polling until then. A refused token stops polling
  until monday is reconnected: the tray then offers **Reconnect monday...**,
  which opens the Connect dialog and replaces the token when the new one is
  accepted. A paired projection screen does not poll at all.
- **Writes.** A status change sets the label and then moves the item to its
  group. If the move fails after the label changed, the wall says exactly that
  ("the status changed, but the task was not moved") and reads the board again
  at once. Comments and task names are trimmed; a comment's line breaks go to
  monday as `<br>`; a name reads back as a match with whitespace collapsed; a
  comment counts as posted when the update id monday returned is on the item.
- **Days are local.** Today, the week, overdue and "done this week" are
  Gustav's local days (`localDay` in `src/shared/work-view.ts`), so at 00:30 in
  Johannesburg a task due today is due today, not yesterday.
- Only the Tasks board is read or written. Projects and Quotes stay vault
  first and Work mode never touches them.

## Notices

Through the wall's existing toast, bottom right, for about 6 seconds, with
**Show** (switch the wall to Work, bring it up and highlight the task),
**Done** (mark it Done through monday, with a pending state and the result)
and **Later**. A notice shows the sender and the task name, never a comment's
text.

| Event | Notice |
|---|---|
| Jaco assigns Gustav a task | Yes, also in quiet hours |
| Jaco moves or comments on a task Gustav owns or assigned | Yes |
| A task leaves Waiting | Yes |
| Due today and overdue | One summary a weekday, from 08:00 |
| Gustav's own changes, from the wall or anywhere else | Never |

- **Quiet hours** are 18:00 to 07:30 and all weekend. Only Jaco's assignments
  get through; everything else is counted and folded into the next morning
  summary ("3 due today, 1 overdue, 4 updates while you were away").
- **Never while focus mode is on.** A change that happens in focus mode is not
  shown later; it is counted into the next morning summary, which itself waits
  until focus mode ends.
- **Bursts** collapse into one notice with a count. Notices that arrive while
  a Done is in flight, or while a chat notice is up, wait as ONE collapsed
  notice, so the queue cannot grow. **The same change never notifies twice**,
  also across restarts.
- **Done** on the toast shows "Marking done..." and ends in a result within 30
  seconds at most: monday's answer, or "monday has not answered yet".
- **Chat notices are not cut off.** A work notice waits for a chat notice that
  is up; a chat message that arrives during a work notice is shown after it,
  with its count per sender. A chat notice still never shows message text.
- A paired projection screen shows no Work and gets no work notices.
- Not yet checked: a full-screen app or screen share in front. The design
  asks for it; phase 1 respects focus mode only.

## What is stored where

| What | Where | Notes |
|---|---|---|
| The monday token | `%APPDATA%\MuchBetter Client Wall\monday-token.bin` | Encrypted with Windows data protection (Electron `safeStorage`). Refused, not written, when encryption is unavailable. Deleted by Disconnect |
| View, task filter | `settings.json`: `mode` (`stats` or `work`), `workFilter` (`mine` or `everyone`) | The stats build always loads `stats`; an old `clients` loads as `stats` |
| Notice memory | `work-notices.json`: seen change keys (the last 2000), the count held by quiet hours, the day of the last summary | No task text, no token |
| The board | Memory only | Fetched again on start |

## Security

- **The token** is typed into the Connect dialog (its own window, strict CSP,
  no navigation), sent to main once, checked, and stored encrypted. It is never
  sent to any renderer again, never logged, never in settings, and never in a
  payload, status line, failure message, notice or projection frame. Errors
  from monday or the network are reduced to a kind (token refused, offline,
  rate limited, daily cap, server) by their HTTP status and error CODES alone
  before anything is shown or logged: their text can echo the request, so it is
  never read or passed on. The log carries counts only ("activity 3 of 3
  parsed"), never an id, a name or a server word.
- **Monday text is untrusted.** Every task name, project and date is inserted
  with `textContent`.
- **Actions are checked in main** field by field (a plain item id, a known
  status or priority, a real date, a comment of 1 to 10,000 characters) before
  anything reaches monday. **Open in monday** sends only the id; main builds
  `https://pickleplaysouthafrica-squad.monday.com/boards/5106174674/pulses/<id>`
  and opens nothing else.
- **Never projected.** `toWire()` builds its frame from an allowlist and has no
  Work field; a paired screen never shows Work and its IPC returns nothing.
- **The stats edition** contains no Work code: the main process, the wall and
  the toast reach Work through a `require()` behind a test of the build define
  itself, which esbuild removes from the stats bundles; the preload has no
  `work` member and no Connect bridge; the stats build ships neither the Connect
  page nor the Work stylesheet.

## Tests

- `test/work.test.mjs`: the notice rules at fixed times (quiet hours and their
  edges, weekends, own changes, focus mode and its count into the summary,
  de-duplication across a restart, bursts, the 08:00 summary); 24 hours of
  ticks on a weekday and a Saturday with the request count; the daily cap, a
  refused token, a request that never answers, a paired screen, a status that
  changed but did not move; counts-only logging; the toast arbiter; a stalled
  Done and the bounded queue; local days under `TZ=Africa/Johannesburg` at
  00:30 (a child process); every Work IPC channel end to end on a fake monday
  with a planted token, searched for in every reply, push, toast message, log
  line, file and projection frame; and the stats and full bundles searched for
  Work code.
- `test/monday.test.mjs`: the data layer (token store, board parsing, the
  tick query's shape, UUID activity ids and 17-digit times, the overlap and no
  upper time bound, writes with read-back, trimming and `<br>`, "not moved",
  `diffTasks`). The fakes use real-shaped ids and times.
- `test/settings.test.mjs`: `mode` and `workFilter`, the stats build's
  settings, and a paired screen never showing Work.
- `test/render-fit.cjs` with `test/render-work.cjs`: the Work view at every
  screen size with long names and 30+ cards a column, the pending and failure
  states, focus borrowing, wheel and drag, the Connect dialog and the toast's
  work notice, and the stats edition showing no Work at all.

None of these call the real monday API. The first real sync, the real token
check and the real activity log shape are unverified until Gustav connects.
