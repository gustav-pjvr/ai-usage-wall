# Work mode | design (draft for Gustav, 2026-11-06)

A third view on Gustav's own wall, beside Claude Stats and Clients: the latest
mail from every inbox in one scrolling panel, and the monday Tasks board as
four scrolling columns, with actions on both and notices through the wall's
existing toast. Mock: `docs/design/mock-work/work-1920x1080.png` (sample data).

**Phase 1 (Tasks) and phase 2 (mail, with Microsoft 365, so phase 3 too) are
implemented**: [../work-mode.md](../work-mode.md). Reply and send (phase 4) is
not built. Gustav's decisions (2026-11-06) are in section 6.

## 1. Recon: what exists

**The app.** Modes are `stats` and `clients`, switched from the top control,
`Tab` and the tray (`src/main/index.ts`, `wall:setMode`). The shareable build
forces `stats` (`isStatsOnly`). The renderer runs under
`connect-src 'none'`: it has no network, and every fetch happens in main.
Secrets already live in `safeStorage` (DPAPI) in `src/main/projection/store.ts`.
The wall windows are `focusable: false` with `WS_EX_NOACTIVATE`; typing works
only by borrowing focus, the way the notes bar does (`docs/notes-bar.md`).

**Notices today.** One always-on-top toast window (268 x 88, bottom right,
`setIgnoreMouseEvents(true)`) shared by the updater and chat notices. A chat
notice shows a name and a count, never the text, for 2 s, and is skipped when
the chat window is focused. It cannot be clicked. The tray also has
`displayBalloon`.

**Mail hosts (MX lookups, 2026-11-06).** `muchbetter.world` is Microsoft 365
(`mail.protection.outlook.com`). `pickleplaysouthafrica.org` is GoDaddy mail
(`secureserver.net`), not Titan. Which address is on Titan, and which Gmail
address, is **OPEN**.

**monday.** Tasks board `5106174674` (183 items). Groups and statuses already
match the four columns: In progress, Waiting on someone else, Backlog, Done
(plus `Dropped`). Columns: Status, Owner, Assigned by, Priority, Due, Notes,
Project (link to the Projects board). The monday-sync skill keeps group and
status in step and reads every write back.

**APIs (Grok job `work-mode-api-facts`, official docs, 2026-11-06).**

| Source | Way in | Push? | Notes |
|---|---|---|---|
| Microsoft 365 | Graph, OAuth auth code + PKCE, loopback `127.0.0.1`, scopes `Mail.ReadWrite Mail.Send offline_access` | No (webhooks need a public HTTPS URL) | Basic-auth IMAP is off in Exchange Online for good. Refresh token 90 days, rolling. Delta query per folder. 10,000 requests per 10 min per mailbox. Needs an app registration in the muchbetter.world Entra tenant. |
| Gmail | Gmail API (OAuth) or IMAP with an app password | IMAP IDLE | `gmail.modify` is a restricted scope: an unverified personal app in Testing loses its refresh token every 7 days. An app password needs 2-Step Verification. |
| Titan | IMAP `imap.titan.email:993`, SMTP `smtp.titan.email:465`, full address and password (an app password when 2FA is on) | IDLE unconfirmed | "Third-party access" must be on in Titan. No mail REST API. |
| GoDaddy | IMAP `imap.secureserver.net:993`, SMTP `smtpout.secureserver.net:465` (to confirm) | IDLE likely | Only if Gustav wants this inbox too. |
| monday | GraphQL `api.monday.com/v2`, personal v2 token, `API-Version: 2026-10` | No (webhooks need a public URL) | 10M complexity points per minute; the whole board is one cheap query. `items_page` filters on last updated; `activity_logs` gives who changed what. |

## 2. Design

### 2.1 Shape

- `mode: 'work'` joins `stats` and `clients`, **full build only**. The
  shareable Claude Stats Wall never contains the code path or a setting for
  it, exactly like Clients.
- Layout at 1920 x 1080 (mock): Inbox on the left (640 px), on the right a
  summary strip (in progress, waiting, overdue, due this week, new from Jaco,
  done this week) above four scrolling columns. Every panel scrolls with the
  wheel and by drag, like the messages window.
- Top bar: account chips with unread counts that filter the inbox; Mine or
  Everyone for tasks (Mine = Owner includes Gustav, the default); `+ Task`;
  `Notify: on`.

### 2.2 Data layer (main process only)

```
src/main/work/
  accounts.ts      account list, tokens in safeStorage, never in settings.json
  graph.ts         Microsoft 365: OAuth (PKCE, loopback), delta sync, actions
  imap.ts          Gmail, Titan, GoDaddy: IMAP + IDLE, SMTP to send
  monday.ts        Tasks board: poll, diff, actions with read-back
  notify.ts        the rules in section 3, quiet hours, de-duplication
src/shared/work-view.ts   the only shape the renderer sees
```

- **Mail sync.** Microsoft 365: delta query on Inbox every 60 s. IMAP
  accounts: IDLE on INBOX for near-instant mail, with a 60 s poll as the
  fallback and a reconnect with back-off. The view keeps the newest 200 per
  account, in memory plus a small encrypted cache so a restart paints at once.
- **Tasks sync.** One query for all items on the Tasks board every 60 s (and
  10 s after any action), diffed against the last copy to find what changed
  and who changed it.
- **The renderer gets a view, never a source.** Per mail: account id, opaque
  handle, sender name and address, subject, a plain-text snippet, time, read
  and flag state. The body is fetched on open and **converted to plain text in
  main**: no HTML is ever rendered, so no remote images, tracking pixels or
  scripts. Links open in the browser only after the wall shows the real URL.
  Attachments are listed by name only in v1.
- **Never projected.** Work data is not in `toWire()` and a paired screen
  never shows Work mode. A test proves no work field crosses the wire.

### 2.3 Actions

Every button shows a pending state, then the result; nothing looks as if it
did nothing (rule 11). Failures say what failed.

| Mail | How |
|---|---|
| Mark read or unread, flag, archive | One click, undo for 5 s |
| Trash | One click, undo for 5 s; never a permanent delete |
| Reply | Opens a reply box that borrows keyboard focus like the notes bar; **Send is always a separate, explicit click**, never automatic; sent through Graph or SMTP |
| Make a task | Creates a Tasks item in Backlog, Owner and Assigned by Gustav, the subject as the name, a link back in Notes |
| Open in the mail app | Opens Outlook on the web, Gmail or Titan webmail in the browser |

| Task | How |
|---|---|
| Move (In progress, Waiting, Backlog, Done, Dropped) | Sets the Status label **and** moves to the matching group, as the monday-sync skill does, then reads it back |
| Priority, Due, Owner | Inline pickers |
| Comment | `create_update`, through the same borrowed-focus box |
| New task | `+ Task`: name, project, priority, due; lands in Backlog |
| Open in monday | Browser |

Scope is the **Tasks board only**. Projects and Quotes stay vault first (rule
14 and the monday-sync skill): Work mode never writes to them.

## 3. Notifications (proposed map, **OPEN** for Gustav to change)

The toast gains a work notice: clickable, about 6 s, with buttons (Show, Mark
read or Done, Later). Show switches the wall to Work, brings it to the front
and opens that mail or task. Bursts collapse into one notice with a count.

| Event | Notify? | Toast shows |
|---|---|---|
| New mail from a person, Inbox, any account | Yes | Account, sender name, subject |
| Newsletters and automated mail (List-Unsubscribe, no-reply, Gmail Promotions or Social) | No, counted only | |
| Mail from a VIP list (clients, Jaco) | Yes, also in quiet hours | |
| Booking or enquiry mail to the bookings addresses | Yes | |
| Task assigned to Gustav by Jaco | Yes | "Jaco gave you: <task>" |
| Jaco moves or comments on a task Gustav owns or assigned | Yes | |
| A task Gustav is waiting on moves out of Waiting | Yes | |
| Due today, overdue | Once, at 08:00, as one summary | "3 due today, 1 overdue" |
| Gustav's own changes, from the wall or from Claude sessions | Never | |

- **Quiet hours** 18:00 to 07:30 and weekends: nothing but VIPs; the rest wait
  for the morning summary.
- **Never** while focus mode is on or a full-screen app or screen share is in
  front (checked through the existing layering code), and never twice for the
  same mail or change.
- **Privacy OPEN:** the toast floats above everything, including a screen
  share. Default proposed: sender and subject; the stricter choice is sender
  only (the chat notice already shows only a name).

## 4. Security (security-sensitive: secrets, sends mail)

- Tokens and passwords in `safeStorage` only; never logged, never in settings,
  never sent to the renderer or the wire.
- OAuth: system browser, PKCE, `state` checked, loopback on `127.0.0.1` with a
  random port, the listener closed after one request.
- TLS only (993, 465); certificate errors are failures, never bypassed.
- Mail content is untrusted: plain text only, length-capped, inserted with
  `textContent`. The CSP stays `connect-src 'none'`.
- Send and Trash are the only outward or destructive actions; both are
  explicit clicks with a pending state, Trash has undo.
- Tests prove: no secret in any payload, wire frame or log; HTML in a body
  never reaches the DOM; a work field never crosses `toWire`. Independent Opus
  audit before release.

## 5. Phases

1. **Tasks**: monday panel, actions, task notices. Needs only a monday token.
   **Implemented** ([../work-mode.md](../work-mode.md)). Built as designed, with
   these choices: Stats and Work are the two views (Clients was removed in
   0.10.2); the four task columns take the full width and the status strip says
   "Mail arrives in phase 2"; "new from Jaco" is a Jaco assignment Gustav has
   not started; changes held by quiet hours are counted into the morning
   summary; a pasted token must belong to Gustav; the full-screen and screen
   share check is not in phase 1 (focus mode is).
2. **IMAP mail**: Gmail (app password) and GoDaddy, read and actions, mail
   notices. **Implemented** ([../work-mode.md](../work-mode.md)), together with
   phase 3. Built as designed, with these choices: the account chips sit in the
   inbox panel's header rather than the top bar (the top bar has no room at
   1280 px beside the view switch and the task chips); Archive and Trash undo
   from a bar at the foot of the panel; "Open in the mail app" is one button per
   message (Outlook on the web, Gmail by Message-ID, GoDaddy webmail's inbox,
   which has no per-message link); "Make a task" names the task after the
   subject and does not yet write a link back into Notes (createTask takes a
   name, priority and due date only); Gmail's Promotions and Social come from a
   Gmail search, as X-GM-LABELS does not list the tabs; VIPs are `mailVip` in
   settings.json, starting with Jaco's Gmail address; mail held by quiet hours
   or focus mode counts into the morning summary.
3. **Microsoft 365** through Graph, after the Entra app registration.
   **Implemented** with phase 2: PKCE public client, loopback on 127.0.0.1
   (redirect `http://127.0.0.1:<port>`), Inbox delta, the same actions and
   notices. Scopes `offline_access User.Read Mail.ReadWrite`: Mail.Send is
   consented but asked for only when phase 4 sends. After the Opus audit
   (2026-11-06): new Graph mail must postdate the newest message of the first
   sync (server time), rotation waits
   for the mailbox check and stops at Disconnect, plain text is never
   tokenized, Gmail's archive undo copies back to INBOX, mail stops while the
   machine is a paired screen.
4. **Reply and send** for all accounts. Not built.

Version 0.11.0 when phase 1 and 2 ship together, or one minor per phase.

## 6. Decisions (Gustav, 2026-11-06)

1. Inboxes: muchbetter.world (Microsoft 365, Graph), Gmail, and
   gustav@pickleplaysouthafrica.org (GoDaddy, IMAP). **No Titan.**
2. Gmail through IMAP with an app password (2-Step Verification on the account).
3. Notices show the sender and the subject.
4. The notification map in section 3 stands as proposed.

Still to settle when building: the Entra app registration steps for Microsoft
365 (Claude writes them), the Gmail address, and the Tasks defaults (Mine by
default, Dropped hidden, Done shows the last 7 days).
