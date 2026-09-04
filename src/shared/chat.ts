/**
 * Text messages between two paired desktops.
 *
 * Deliberately plain text and nothing else. No formatting, no attachments, no
 * markup. It rides the same sealed channel the dashboard uses, so anything
 * richer would be a new way for one machine to make another machine render
 * something, and the renderer that displays these messages sets textContent
 * rather than innerHTML for the same reason.
 */

/** Hard cap on one message. Long enough for a paragraph, short enough to seal. */
export const MAX_TEXT = 2000;

/** How many messages a thread keeps. Older ones fall off the front. */
export const MAX_HISTORY = 300;

/** How many undelivered messages a thread holds for a peer that is away. */
export const MAX_OUTBOX = 100;

/** What actually crosses the wire, inside the seal. */
export interface ChatWire {
  /** Random, and the ONLY thing dedupe relies on. */
  id: string;
  text: string;
  /** Sender's clock, for display only. Never used to order or to expire. */
  at: number;
}

/**
 * A message as a thread holds it.
 *
 * `mine` rather than a sender id: each machine has exactly one peer per thread,
 * so "who sent it" is a boolean, and a sender name here would put a hostname in
 * a file that does not otherwise need one.
 */
export interface ChatMessage extends ChatWire {
  mine: boolean;
  /**
   * Only meaningful for messages this machine sent.
   *
   * `queued` means the peer was not connected, so the relay would have dropped
   * it: the relay stores nothing, and a message sent into a closed socket is
   * gone with no error raised anywhere. Showing "sent" for that would be a lie,
   * which is the only reason this field exists.
   *
   * `dropped` is the outbox cap being reached: the message was evicted and will
   * never be sent. Leaving it as `queued` forever would be the same lie one
   * step further along.
   */
  state?: 'queued' | 'sent' | 'dropped';
}

/** One conversation, which is one paired screen. */
export interface ChatThread {
  /** The screen id. A screen's thread with its source uses `SOURCE_PEER`. */
  peerId: string;
  label: string;
  messages: ChatMessage[];
  unread: number;
}

/**
 * A screen has exactly one peer, its source, and no screen id for it. This is
 * the fixed key it files that conversation under.
 */
export const SOURCE_PEER = 'source';

/**
 * Drop control characters, keeping tab and newline.
 *
 * Written as a loop over code points rather than a regex on purpose: a regex
 * literal for this range is a row of escapes that is easy to get wrong and
 * impossible to read, and an earlier attempt at one put raw control bytes into
 * this very file.
 */
function stripControl(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const printable = c === 9 || c === 10 || (c >= 32 && c !== 127);
    if (printable) out += ch;
  }
  return out;
}

/**
 * Clean a message typed by a person, before it is sealed and sent. Returns null
 * for anything not worth sending.
 */
export function cleanOutgoing(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  /*
   * Slice BEFORE stripping, not after.
   *
   * stripControl walks the string one code point at a time, and the socket will
   * hand over any plaintext that fits the frame, which after inflate is far more
   * than a person types. Stripping first meant a peer holding the key could
   * stall this process for seconds with one message: measured at 1.6 s for
   * 20 MB and 4.6 s for 60 MB. Four times the cap leaves room for surrogate
   * pairs and for control characters that are about to be removed anyway.
   */
  const bounded = raw.length > MAX_TEXT * 4 ? raw.slice(0, MAX_TEXT * 4) : raw;
  const text = stripControl(bounded).trim();
  if (!text) return null;
  return text.slice(0, MAX_TEXT);
}

/**
 * Clean a peer-supplied label (a hostname from the hello or hello-ack).
 *
 * Unlike message text, labels ARE logged and shown in the tray, so a control
 * character here would reach a terminal rather than a text node.
 */
export function cleanLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const text = stripControl(raw.slice(0, 200)).trim().slice(0, 40);
  return text || fallback;
}

/**
 * Validate a message that arrived from the network.
 *
 * The peer is another copy of this app holding the right key, so this is not an
 * adversary in the usual sense. It is still the wrong place to assume good
 * input: a malformed frame should cost one dropped message, not an exception in
 * the main process.
 */
export function cleanIncoming(raw: unknown): ChatWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' ? stripControl(m.id.slice(0, 256)).slice(0, 64) : '';
  const text = cleanOutgoing(m.text);
  if (!id || !text) return null;
  const at = Number(m.at);
  return { id, text, at: Number.isFinite(at) ? at : Date.now() };
}
