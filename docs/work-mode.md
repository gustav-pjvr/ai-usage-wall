# Work mode

The inbox and the monday Tasks board on the wall, with actions and notices.
Full build only: the shareable Claude Stats Wall contains none of it. Phase 1
(tasks) and phase 2 (mail: Microsoft 365, Gmail and GoDaddy, read and act, with
notices) are built; reply and send (phase 4) are not, so nothing is ever sent
from the wall. Design and Gustav's decisions:
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

## Setup: connect mail

Tray, **Connect mail...** (or the **Connect mail** button the inbox shows while
no account is connected). The dialog has two parts. Each account is connected
once; the tray then lists it as **MuchBetter mail**, **Gmail mail** or
**PicklePlay mail**, each with **Reconnect...** and **Disconnect**.

### Microsoft 365 (gustav@muchbetter.world)

1. Click **Sign in with Microsoft**. The sign-in page opens in your normal
   browser (Microsoft's own page; the wall never sees the password).
2. Sign in as gustav@muchbetter.world and accept. The browser then shows
   "Signed in. You can close this tab".
3. The dialog says **MuchBetter connected.** and the inbox fills.

It waits up to 3 minutes for the browser; **Cancel sign-in** stops it. Another
Microsoft account is refused and nothing is stored.

How it works: OAuth 2.0 authorization code with PKCE (S256) for a public client,
no client secret. App registration `5f0949e0-ce25-41ec-961b-384cd318e57e` in the
muchbetter.world tenant (`ed2d1adf-3f5a-48e9-a200-7ae285517d7c`), scopes
`offline_access User.Read Mail.ReadWrite` (admin consent granted, Mail.Send
included). `Mail.Send` is consented in Entra but not asked for until phase 4
sends mail, so the wall's token cannot send. The redirect is
`http://127.0.0.1:<random port>` (RFC 8252 section 8.3: the IP literal of the
listener), answered by a listener bound to 127.0.0.1 that takes one request and
closes. In Entra, `http://127.0.0.1` (and `http://localhost`, kept) must be
redirect URIs under **Mobile and desktop applications**, a public client
platform where any port is accepted for a loopback address; under **Web** the
token request would be refused for want of a secret.

### Gmail (gustavpjvr@gmail.com)

Gmail is read over IMAP with an **app password**, not the Google password:

1. Google Account, **Security**, turn on **2-Step Verification** if it is off.
2. Google Account, **Security**, **2-Step Verification**, **App passwords**
   (or https://myaccount.google.com/apppasswords). Make one named "Client
   Wall" and copy the 16 letters.
3. In the dialog choose **Gmail**, paste it into **App password** and click
   **Connect**. The spaces Google shows are ignored.

IMAP must be on in Gmail settings (it is for new accounts). Server
`imap.gmail.com:993`, TLS.

### GoDaddy (gustav@pickleplaysouthafrica.org)

Choose **PicklePlay**, paste the mailbox password (the one GoDaddy webmail takes)
into **Mailbox password**, and click **Connect**. Server
`imap.secureserver.net:993`, TLS.

For both IMAP accounts the field is cleared the moment Connect is clicked; the
wall signs in to the server for real and reads the INBOX before it stores
anything. A refused password, an unreachable server or a certificate that does
not check out is reported in plain words and nothing is stored.

## Using it

- **Layout.** The inbox on the left (a third of the width), the task summary and
  the four task columns on the right, a status strip along the bottom (as in
  `docs/design/mock-work`). It fits every screen from 1280 x 800 to 2560 x 1440
  with 200 messages (test/render-work.cjs).
- **The inbox.** Every connected account, newest first (the time the message
  arrived), up to 200 per account. Unread messages are bold, flagged ones
  carry a flag, newsletters and automated mail are dimmed. The chips at the
  top (**All mail**, **MuchBetter**, **Gmail**, **PicklePlay**) show the unread
  count and filter the list. The list scrolls with the wheel or by dragging.
- **A message.** Click it to open it: the sender's address, the body as plain
  text (fetched at that moment, with a loading state), attachments by name.
  Links are written out as text, "Pay here (https://...)", and never opened by
  the wall. Then **Mark read / Mark unread**, **Flag / Unflag**, **Archive**,
  **Trash**, **Make a task** (a Backlog task named after the subject, owned and
  assigned by Gustav) and **Open in Outlook / Gmail / webmail** (that message
  in Outlook on the web or Gmail; GoDaddy's webmail has no per-message link,
  so it opens the inbox). Every button shows a pending state, then the
  server's read-back or a plain failure.
- **Archive and Trash** take the message out of the inbox and offer **Undo**
  for 5 seconds at the foot of the panel. Neither ever deletes anything for
  good: Archive moves to Gmail's All Mail, GoDaddy's archive folder (created
  as `Archive` if there is none) or Outlook's Archive; Trash moves to the Trash
  or Deleted Items folder, where the mail provider's own rules apply. Undo moves
  it back, except Gmail's archive: the message is still in All Mail, so Undo
  COPIES it to INBOX (Gmail puts the Inbox label back) and reads it back there;
  nothing moves out of All Mail and nothing is expunged.
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
- **Status strip**, along the bottom: "MuchBetter synced 20s ago" per mail
  account and "monday synced 20s ago", or the failure in plain words (sign-in
  refused, unreachable, rate limited, certificate failed).

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

### Mail sync

- **Gmail and GoDaddy (IMAP, `src/main/work/imap.ts`, imapflow 2.2.6).** One
  connection per account. INBOX is read on connect, then the connection waits
  in IDLE so new mail arrives within seconds; a 60 second poll is the fallback
  for servers without IDLE. Each sync reads the envelopes, flags, size, arrival
  time and the List-Unsubscribe header of the newest 200 (never a body), the
  unread count, and for Gmail which of them are in Promotions or Social (a
  Gmail search, since Gmail does not list its tabs as labels). A dropped
  connection reconnects with a back-off of 1 s doubling to 5 minutes.
- **Microsoft 365 (Graph, `src/main/work/graph.ts`).** The Inbox delta query
  (`/me/mailFolders/inbox/messages/delta`, newest first, the last 30 days,
  `id, receivedDateTime, isRead, flag, subject, from, bodyPreview,
  inferenceClassification, internetMessageId, webLink`) kept as a local copy;
  later polls fetch only what changed. Every 60 seconds in working hours
  (weekdays 07:30 to 18:00), every 5 minutes otherwise. A 429 or 503 waits at
  least the Retry-After Graph sends. An expired delta (410) starts again
  quietly; two in a row is reported as a server problem instead of looping.
  The access token is refreshed before it expires; the refresh token rotates
  and the new one replaces the stored one, but only once the sign-in's mailbox
  check has passed, and never after Disconnect (a refresh in flight at that
  moment writes nothing, nor does a sign-in still checking the mailbox; every
  write and the delete share one queue). Starting the accounts again (after a
  screen pairing ends) never doubles a connection: a start overtaken by
  another start or a suspend starts nothing more.
- **New mail** is a message a sync sees for the first time after the first
  sync (so connecting, or restarting, never notifies old mail). A message the
  wall itself moved back with Undo is not new. For Microsoft 365 it must also
  be no older than the newest message the first sync saw (server time, so the
  PC's clock plays no part), and its id must not have been seen before: the
  delta covers 30 days while the wall keeps 500 messages, so an old message
  changed in Outlook comes back from the delta and must not notify. If
  anything fails after the delta has advanced (the unread count, a
  rate-limited header check), that sync's new messages are carried to the
  next one, so their notices are late, not lost.
- **Bulk** is List-Unsubscribe, a no-reply sender, Gmail's Promotions or Social
  tab, or Outlook's Other (Focused Inbox). Graph is asked for the full headers
  of at most 5 new messages a sync, to find List-Unsubscribe.
- **Failures** are kinds, never server text: sign-in refused (that account
  stops until **Reconnect...**, so a wrong password is not retried), offline,
  rate limited, certificate failed, server. One account failing never stops the
  others. A paired projection screen does not sync mail at all: when this
  machine becomes a screen every account stops and the inbox is dropped from
  memory, and when it stops being one they start again from the stored
  accounts.

## Notices

Through the wall's existing toast, bottom right, for about 6 seconds, with
**Show** (switch the wall to Work, bring it up and highlight the task),
**Done** (mark it Done through monday, with a pending state and the result)
and **Later**. A notice shows the sender and the task name, never a comment's
text. A mail notice shows the account, the sender's name and the subject
(Gustav's choice), never the body, with **Show** (switch to Work and open that
message), **Mark read** and **Later**.

| Event | Notice |
|---|---|
| Jaco assigns Gustav a task | Yes, also in quiet hours |
| Jaco moves or comments on a task Gustav owns or assigned | Yes |
| A task leaves Waiting | Yes |
| Due today and overdue | One summary a weekday, from 08:00 |
| Gustav's own changes, from the wall or anywhere else | Never |
| New mail from a person, INBOX, any account | Yes: account, sender name, subject |
| Newsletters and automated mail (List-Unsubscribe, no-reply, Gmail Promotions or Social, Outlook Other) | Never |
| Mail from a VIP (`mailVip` in settings.json) | Yes, also in quiet hours |

- **Quiet hours** are 18:00 to 07:30 and all weekend. Only Jaco's assignments
  and VIP mail get through; everything else is counted and folded into the
  next morning summary ("3 due today, 1 overdue, 4 updates while you were
  away"; held mail counts as updates).
- **VIPs** are the plain addresses in `mailVip` in settings.json, compared
  without case. It starts as `["jacojvr@gmail.com"]`, the one address of Jaco's
  known to the wall (from Gustav's own notes); add his MuchBetter address when
  it is known, or set `[]` to turn VIPs off. The stats build has no list. VIP
  matching trusts the From header, which any sender can write: a forged From
  can make a stranger's mail notify in quiet hours, and that is all. It decides
  only whether a notice shows, and unlocks no action or data.
- **Never while focus mode is on.** A change that happens in focus mode is not
  shown later; it is counted into the next morning summary, which itself waits
  until focus mode ends.
- **Bursts** collapse into one notice with a count ("Mail · 3 new", or
  "Work · 4 updates" when mail and tasks arrive together; Show then goes to the
  newest, and Done or Mark read is not offered). Notices that arrive while
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
| Gmail and GoDaddy passwords | `%APPDATA%\MuchBetter Client Wall\mail-accounts\gmail.bin`, `pickleplay.bin` | Encrypted with Windows data protection, with the account (host, address). Stored only after a real sign-in worked. Deleted by Disconnect |
| The Microsoft 365 refresh token | `%APPDATA%\MuchBetter Client Wall\graph-token.bin` | Encrypted the same way; replaced on every refresh (it rotates). The access token is in memory only. Deleted by Disconnect |
| Mail notice memory | `mail-notices.json`: hashes of the messages already handled (the last 2000) | No address, subject or account name |
| VIP senders | `settings.json`: `mailVip` | Plain addresses only |
| The inbox and message bodies | Memory only | Fetched again on start; a body only when it is opened |

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
- **Mail passwords and Microsoft tokens** follow the token's rules: typed (or
  signed in) once, checked by a real sign-in, stored with DPAPI, and never sent
  to any renderer, logged, put in settings, a payload, a status line, a failure
  message, a notice or a projection frame. imapflow runs with `logger: false`
  (it logs nothing, not even errors), TLS on port 993 with certificate checks
  on. Failures are fixed kinds; a server's text, which can echo a LOGIN line or
  a token request, is never read or passed on. The Microsoft sign-in has PKCE,
  a fresh `state`, a redirect to `http://127.0.0.1:<port>` and a listener on
  127.0.0.1 only that takes one request and closes, and a 3 minute limit; it
  asks for no Mail.Send; its token requests go only to
  login.microsoftonline.com and Graph requests only to graph.microsoft.com.
- **Mail is untrusted text.** Main reduces every subject, sender and body to
  plain text (`src/main/work/mail-text.ts`: no tags, no scripts, no styles, no
  images, invisible and direction-changing characters removed, length capped)
  before the renderer gets it, and the renderer inserts it with `textContent`.
  No HTML body, remote image or tracking pixel ever reaches a page, and the
  renderer keeps `connect-src 'none'`. Links are text.
- **Mail actions are checked in main**: an opaque handle main issued, one of six
  known actions. Nothing can delete for good: Trash and Archive are MOVEs, an
  IMAP server without MOVE is refused before imapflow's copy-and-expunge
  fallback could run, and Graph is never sent a DELETE. **Open in ...** opens
  only Outlook on the web, Gmail or GoDaddy webmail URLs main built.
- **The Connect mail dialog** is its own window with the strict CSP, no
  navigation, and a bridge of five calls; the password field is cleared on
  submit and the reply never contains it.
- **The stats edition** contains no Work code: the main process, the wall and
  the toast reach Work through a `require()` behind a test of the build define
  itself, which esbuild removes from the stats bundles; the preload has no
  `work` or `mail` member and no Connect or Connect mail bridge; the stats build
  ships neither Connect page nor the Work stylesheet, no imapflow, no Graph
  code, and an empty `mailVip`.

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

- `test/mail.test.mjs`: the IMAP layer on a fake transport (the password
  store, TLS and sign-in failures as kinds, the newest 200 envelopes and no
  bodies, sanitising, bulk detection including Gmail's category search, read
  and flag read-back, Archive and Trash as MOVE with undo on Gmail and
  GoDaddy, no MOVE refused, IDLE and the poll, the reconnect back-off, no
  password in any value, error or log line), and the REAL imapflow 2.2.6
  checked against what imap.ts calls: its options are ImapFlowOptions, TLS is
  verified, logging is off and writes nothing, and every method and query key
  exists (the client is made but never connects).
- `test/graph.test.mjs`: PKCE, the loopback (127.0.0.1 only, one request, a
  wrong state refused, the timeout, closed after), the sign-in end to end on a
  fake Microsoft (the verifier, another account refused, the token stored
  encrypted), refresh rotation and a 401 retry, Retry-After, the delta
  baseline and new mail, bulk, read and flag read-back, Archive and Trash as
  moves with undo by the moved id and never a DELETE, the 5 second undo, the
  body as text, and planted tokens searched for in every value, error, log
  line and file.
- `test/work.test.mjs` also: the mail notice rules (person, bulk, VIPs in quiet
  hours, focus mode, de-duplication across a restart with hashed keys only,
  bursts), and every mail IPC channel end to end on a fake IMAP server and a
  fake Microsoft with a planted password and planted tokens, searched for in
  every reply, push, toast message, log line and file; `toWire` with mail
  data; and the stats bundles searched for the mail markers (imapflow, Graph,
  the accounts, the IPC).
- `test/render-work.cjs` also: the inbox at every size with 200 messages, long
  and unbroken subjects and an open message; mail as text; every mail action's
  pending state and result, a failure, Trash and Undo, Make a task, Show on a
  notice; the Connect mail dialog; the toast's mail notice with Mark read.

None of these call the real monday API, a real mail server or Microsoft. The
first real sync, the real token check and the real activity log shape are
unverified until Gustav connects; so are the first real Gmail, GoDaddy and
Microsoft 365 sign-ins and syncs (see "Not yet verified" below).

## Not yet verified (mail)

- A real sign-in to each account. In particular: that the Entra registration
  lists `http://127.0.0.1` under Mobile and desktop applications (a Web
  platform would refuse the token request), that Gmail accepts the IMAP MOVE
  from INBOX to All Mail as an archive and the COPY back as its undo, that
  GoDaddy's IMAP offers MOVE (if it does not, Archive and Trash say so and do
  nothing), and that GoDaddy's webmail address is `https://email.godaddy.com/`.
- Graph's delta with `$filter` and `$orderby` together on a large inbox, and
  whether `webLink` comes back in a delta `$select`.
- The full-screen and screen-share check before a notice (still focus mode
  only, as in phase 1).
