# Messaging: plain text between two paired desktops

**Summary.** Once two machines are paired for projection they can send each
other text. It rides the sealed channel the dashboard already uses, so the relay
forwards ciphertext it cannot read. Threads are per screen because keys are per
screen. A message that cannot be delivered is queued and says so rather than
claiming it was sent, because the relay stores nothing and a message into a
closed socket is gone with no error anywhere. History is capped, encrypted at
rest, and deleted with the pairing that produced it.

Read [projection.md](projection.md) first for the channel this sits on, and
[privacy-wire.md](privacy-wire.md) for what leaves the machine.

## Arrival

A message raises the same panel the update downloader uses, bottom right, above
other windows, for two seconds. It says `New message` and who it is from, or
`4 new messages` when several land together, and it never shows the text.

Three details worth knowing:

- **One window, not two.** A second always-on-top panel would have to negotiate
  a position with the first and could overlap it. A notice borrows the update
  toast for its two seconds and then hands it back, so a download in progress
  reappears rather than being cancelled by a message.
- **A burst is one notice with a count.** Five messages do not stack five
  panels in the same corner.
- **Nothing appears if the Messages window is already open and focused.** A
  popup announcing a message you are watching arrive is noise, and this panel is
  the one surface in the app that interrupts.

The tray count is still there for anything missed, and it is the durable signal:
the panel is gone in two seconds whether or not anyone saw it.

## Where it lives

**Tray icon, Projection, Messages...**, on both machines. It is a window of its
own, not a tab on the pairing panel.

That placement is deliberate and was corrected during the build. The pairing
panel is asymmetric: the source shows a code there and the screen only ever sees
it once, while redeeming. Hanging the conversation off it would have given the
receiving machine no way in. Both roles now reach it the same way.

The tray entry only appears when there is someone to message: on a source, at
least one confirmed screen; on a screen, a pairing that has not ended. It
carries the unread count, so `Messages (3)` is readable without opening
anything.

## Scrolling

There are no scrollbars in this window. Nothing to drag, nothing white down the
side of a dark panel. Three ways to move instead:

- the wheel and the trackpad, which work because the region still has
  `overflow-y: auto`. Hiding a bar with `overflow: hidden` would have stopped
  the region scrolling at all, which is the mistake this avoids.
- grabbing the conversation and moving it. The cursor is a grab hand over the
  background.
- nothing else. There is deliberately no scroll-to-bottom button; the view
  follows the newest message on its own.

Dragging does **not** start on message text. A drag there selects, which is how
a message gets copied, and buying scrolling with the loss of copy would be a bad
trade. The cursor says which is which: a grab hand over the background, a caret
over text. A drag has to move three pixels before it counts, so a plain click
still does nothing.

The view follows new messages only when it was already at the bottom, with sixty
pixels of slack. Otherwise a message arriving while someone reads back through
history would yank them to the end of it. Sending always returns to the bottom,
because sending is an intent to be at the newest.

## What crosses the wire

One new body type on the existing sealed envelope, in both directions:

```
{ t: 'chat', msg: { id, text, at } }
```

- `id` is 96 random bits from `newMessageId()`. It is only ever compared for
  equality, and it is what dedupe relies on.
- `text` is cleaned by `cleanOutgoing()`: control characters removed except tab
  and newline, trimmed, capped at 2000 characters.
- `at` is the sender's clock, for display only. It never orders anything and
  never expires anything.

Source to screen goes through `sendTo()` as a normal frame. Screen to source
goes through `sendUp()` on the `up` channel, which previously carried only the
hello-ack.

## Delivery, and why "sent" is not assumed

The relay stores nothing. A frame addressed to a peer that is not connected is
discarded in transit and no error is raised anywhere. So the interesting state
is not "did the socket accept it" but "was anyone there".

| State | Shown as | Meaning |
|---|---|---|
| `sent` | nothing | The peer was reachable and the socket took it |
| `queued` | "waiting to send" | Held locally; goes out on reconnect |
| `dropped` | "not sent" | Evicted by the outbox cap; will never be sent |

What counts as reachable:

- **Source:** the screen is confirmed, the relay reports it online, and the
  socket is open. All three matter. An unconfirmed screen has not proved it
  holds the key, and relay-reported presence is the only presence signal there
  is.
- **Screen:** the socket is open and the relay reports the source online. An
  open socket alone was the first implementation and it was wrong: it says
  nothing about whether the far end exists. Trusting the relay here is trusting
  it about its own connectivity, which is the one thing it cannot be wrong about
  without dropping the message anyway.

Queued messages flush when a screen comes online, when it becomes confirmed, and
when a screen sees the source come back. The outbox holds 100 per peer; past
that the oldest are evicted and marked `dropped`, because a cap that silently
keeps saying "waiting" is the same lie one step further along.

## Threads and dedupe

One thread per peer. On a source that is one per screen id; on a screen it is
the single constant `SOURCE_PEER`, because a screen has exactly one peer and no
id for it.

Per-screen threads rather than a broadcast: keys are per screen, so a broadcast
would seal the same words for up to eight machines. A message meant for one
device should reach one device.

Two layers, because one was not enough.

Dedupe by message id, held in a bounded set per peer, catches a duplicate while
the id is still remembered. A persisted per-screen `lastUpSeq` is the real
boundary: it catches anything older, including a frame a relay held back until
the original had scrolled out of the window entirely.

The sequence check is the newer of the two. The `up` channel had none while it
carried only a hello-ack per connection, and messaging is what made replaying it
worth anything. See [projection-crypto.md](projection-crypto.md).

## Storage

`projection-chat.json` in `userData`, written by the same writer as the
projection keys, which means DPAPI scoped to the logged-in user on Windows. If
`safeStorage` reports encryption unavailable, that writer warns once per process
that it is falling back to plaintext.

- 300 messages per thread. Older ones fall off the front.
- 100 queued messages per peer.
- Writes are coalesced on a 1.5 second timer, so a burst is one save and nothing
  in the message path waits on a disk.

It is deleted when the pairing that produced it ends: revoking a screen,
a screen unpairing itself, a screen being told it was revoked or that the space
closed, and turning projection off and forgetting.

That list is longer than it looks because two of those cases were bugs. A
revoked screen used to delete its keys and then write the whole conversation
back, because the file was deleted while the threads were still in memory and
the next save recreated it. A screen that unpaired itself used to leave its
thread on the source forever, one orphan per pair-and-unpair cycle.

## What is deliberately absent

- **No sender names in storage.** Each thread has one peer, so `mine` is a
  boolean, and a hostname would be a name in a file that does not need one.
- **No read receipts, no typing indicators.** Both mean sending something the
  person did not ask to send.
- **No message content in the notification.** A message arriving raises a two
  second panel in the corner saying who it is from and how many, never a word of
  what. That panel floats above other applications, so anyone glancing at the
  screen can read it, and the point of the channel underneath is that the words
  are not for them.

  This entry used to read "no notification on arrival", on the reasoning that
  the app interrupts only when asked. Gustav asked, so it notifies. The
  reasoning was not wrong, it was simply outvoted by the person using it, and
  the restraint that survived is the part about content.
- **No formatting, no links, no markup.** The renderer writes every message with
  `textContent`. Messages come from another machine, and rendering them as
  markup would turn a private channel into a way to script the window.

## Limits worth knowing

- Message text is the one thing on the wire a person authors, so none of the
  leak guards that protect dashboard fields apply to it. Whatever is in a
  message, someone typed it and pressed Enter.
- A relay can tell that messages are being exchanged, and roughly when, from
  frame timing and size. It cannot read them.
- The peer is another copy of this app holding the right key. It is not treated
  as fully trusted: inbound text is validated and bounded, and peer-supplied
  labels are control-stripped because unlike message text they are logged.
- There is no forward secrecy. A key obtained later opens any earlier message
  for that screen that was recorded in transit. This is a property of the
  channel, not of chat.

## Tests

`test/chat.test.mjs`, 43 checks. The ones that carry weight:

- An undelivered message is recorded as `queued`, never `sent`.
- The same id arriving twice is dropped and does not move the unread count.
- Evicted messages are marked `dropped` rather than left saying "waiting".
- A 20 MB message is cleaned in well under a second. Without the fix this took
  1660 ms, because the control-character strip ran before the length cap and a
  peer holding the key could stall the main process with one message.
- `forgetAll()` does not resurrect the file it was deleting 1.5 seconds later.

Not covered, and worth knowing: the terminal-verdict path on a screen, the
persisted `lastUpSeq` boundary, and the flush-on-reconnect path all need two
live machines and a relay, so they are exercised by hand rather than in the
suite.
