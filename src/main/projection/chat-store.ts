/**
 * Chat threads, in memory and on disk.
 *
 * ON DISK, BECAUSE THE ALTERNATIVE IS WORSE
 *
 * Keeping this in memory only would be simpler and would avoid writing anyone's
 * words to a file. It would also mean the history vanishes on every restart,
 * and since the stats build now checks for updates every minute and installs
 * when asked, restarts are not rare. A chat that silently forgets is not a
 * chat.
 *
 * So it persists, through the same writer the projection keys use, which means
 * DPAPI scoped to the logged-in user on Windows. If safeStorage reports
 * encryption unavailable, that writer warns once per process that it is falling
 * back to plaintext, and that warning covers this file too.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No sender names. Each thread has exactly one peer, so `mine` is a boolean and
 * no hostname needs storing. No read receipts and no typing indicators: both
 * would mean sending something the person did not ask to send.
 */

import { MAX_HISTORY, MAX_OUTBOX, SOURCE_PEER } from '../../shared/chat';
import type { ChatMessage, ChatThread, ChatWire } from '../../shared/chat';
import { readChatFile, writeChatFile } from './store';

/** peerId -> thread. A screen has exactly one, under SOURCE_PEER. */
const threads = new Map<string, ChatThread>();

/**
 * Ids already accepted, per peer, so a duplicate is never shown twice.
 *
 * The source does not check sequence numbers on the up channel, so a relay that
 * replayed a screen's message would otherwise deliver it again. Dedupe by id
 * makes that harmless in both directions and costs one Set.
 */
const seen = new Map<string, Set<string>>();

/** Messages waiting for a peer that was not connected when they were written. */
const outbox = new Map<string, ChatWire[]>();

let dirty = false;
let saveTimer: NodeJS.Timeout | null = null;

function threadFor(peerId: string, label: string): ChatThread {
  let t = threads.get(peerId);
  if (!t) {
    t = { peerId, label, messages: [], unread: 0 };
    threads.set(peerId, t);
  } else if (label && t.label !== label) {
    t.label = label;
  }
  return t;
}

/**
 * Ids remembered per peer, capped at twice the history window.
 *
 * A Set that only grows is a slow leak that a peer holding the key controls, so
 * it is bounded. Twice MAX_HISTORY is deliberate: the replay window this can
 * enforce is then never smaller than the history a person can still see, so a
 * duplicate can only slip through once the original has already scrolled out of
 * the thread entirely.
 */
const MAX_SEEN = MAX_HISTORY * 2;

function seenFor(peerId: string): Set<string> {
  let s = seen.get(peerId);
  if (!s) {
    s = new Set();
    seen.set(peerId, s);
  }
  return s;
}

function remember(peerId: string, id: string): void {
  const s = seenFor(peerId);
  s.add(id);
  if (s.size > MAX_SEEN) {
    // Sets iterate in insertion order, so this drops the oldest ids first.
    const excess = s.size - MAX_SEEN;
    let n = 0;
    for (const old of s) {
      s.delete(old);
      if (++n >= excess) break;
    }
  }
}

/**
 * Coalesced write. A burst of messages is one save, and the save is scheduled
 * rather than awaited so nothing in the message path waits on a disk.
 */
function scheduleSave(): void {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    void writeChatFile({
      v: 1,
      threads: [...threads.values()].map((t) => ({
        peerId: t.peerId,
        label: t.label,
        messages: t.messages,
        unread: t.unread,
      })),
      outbox: [...outbox.entries()].map(([peerId, items]) => ({ peerId, items })),
    });
  }, 1500);
  saveTimer.unref?.();
}

/** Load whatever is on disk. Anything malformed is discarded, never repaired. */
export async function loadChat(): Promise<void> {
  threads.clear();
  seen.clear();
  outbox.clear();
  const raw = (await readChatFile()) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') return;

  const list = Array.isArray(raw.threads) ? raw.threads : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const peerId = typeof e.peerId === 'string' ? e.peerId : '';
    if (!peerId) continue;
    const messages = (Array.isArray(e.messages) ? e.messages : [])
      .filter((m): m is ChatMessage => !!m && typeof m === 'object' && typeof (m as ChatMessage).id === 'string')
      .slice(-MAX_HISTORY);
    const t: ChatThread = {
      peerId,
      label: typeof e.label === 'string' ? e.label : peerId,
      messages,
      unread: Number.isFinite(Number(e.unread)) ? Math.max(0, Number(e.unread)) : 0,
    };
    threads.set(peerId, t);
    const s = seenFor(peerId);
    for (const m of messages) s.add(m.id);
  }

  const boxes = Array.isArray(raw.outbox) ? raw.outbox : [];
  for (const entry of boxes) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const peerId = typeof e.peerId === 'string' ? e.peerId : '';
    const items = Array.isArray(e.items) ? (e.items as ChatWire[]) : [];
    if (peerId && items.length) outbox.set(peerId, items.slice(-MAX_OUTBOX));
  }
}

/** Every thread, newest activity first. */
export function allThreads(): ChatThread[] {
  const last = (t: ChatThread) => (t.messages.length ? t.messages[t.messages.length - 1].at : 0);
  return [...threads.values()].sort((a, b) => last(b) - last(a));
}

export function threadOf(peerId: string): ChatThread | null {
  return threads.get(peerId) ?? null;
}

/** Rename a thread when a peer's label becomes known or changes. */
export function relabel(peerId: string, label: string): void {
  const t = threads.get(peerId);
  if (t && label && t.label !== label) {
    t.label = label;
    scheduleSave();
  }
}

/** Forget a peer entirely. Called when a screen is revoked or unpaired. */
export function forgetPeer(peerId: string): void {
  const had = threads.delete(peerId);
  seen.delete(peerId);
  outbox.delete(peerId);
  if (had) scheduleSave();
}

/**
 * Forget everything, and do NOT write.
 *
 * This is called beside clearProjection(), which deletes the file. Scheduling a
 * save here recreated it 1.5 seconds later with an empty threads array, which
 * is harmless but contradicts the promise that turning projection off leaves
 * nothing behind. Cancelling the pending write is the whole fix.
 */
export function forgetAll(): void {
  threads.clear();
  seen.clear();
  outbox.clear();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = false;
}

function push(t: ChatThread, m: ChatMessage): void {
  t.messages.push(m);
  if (t.messages.length > MAX_HISTORY) t.messages.splice(0, t.messages.length - MAX_HISTORY);
}

/** Record a message this machine is sending. */
export function recordOutgoing(peerId: string, label: string, wire: ChatWire, delivered: boolean): ChatMessage {
  const t = threadFor(peerId, label);
  const m: ChatMessage = { ...wire, mine: true, state: delivered ? 'sent' : 'queued' };
  push(t, m);
  remember(peerId, wire.id);
  if (!delivered) {
    const box = outbox.get(peerId) ?? [];
    box.push(wire);
    if (box.length > MAX_OUTBOX) {
      /*
       * The cap has to evict something, and whatever it evicts is never going
       * to be sent. Say so on the message rather than leaving it claiming to be
       * on its way, which is the same lie `state` exists to prevent.
       */
      const evicted = box.splice(0, box.length - MAX_OUTBOX);
      const gone = new Set(evicted.map((e) => e.id));
      for (const msg of t.messages) {
        if (msg.mine && msg.state === 'queued' && gone.has(msg.id)) msg.state = 'dropped';
      }
    }
    outbox.set(peerId, box);
  }
  scheduleSave();
  return m;
}

/**
 * Record a message that arrived. Returns null when it is a duplicate, so the
 * caller knows not to notify twice.
 */
export function recordIncoming(peerId: string, label: string, wire: ChatWire): ChatMessage | null {
  const s = seenFor(peerId);
  if (s.has(wire.id)) return null;
  remember(peerId, wire.id);
  const t = threadFor(peerId, label);
  const m: ChatMessage = { ...wire, mine: false };
  push(t, m);
  t.unread += 1;
  scheduleSave();
  return m;
}

/** Everything waiting for a peer, and it is cleared by taking it. */
export function takeOutbox(peerId: string): ChatWire[] {
  const box = outbox.get(peerId) ?? [];
  if (box.length) outbox.delete(peerId);
  return box;
}

export function outboxSize(peerId: string): number {
  return (outbox.get(peerId) ?? []).length;
}

/** A queued message reached the peer. Flip its state so the UI stops lying. */
export function markDelivered(peerId: string, ids: string[]): void {
  const t = threads.get(peerId);
  if (!t || !ids.length) return;
  const set = new Set(ids);
  let changed = false;
  for (const m of t.messages) {
    if (m.mine && m.state === 'queued' && set.has(m.id)) {
      m.state = 'sent';
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

/** The user is looking at this thread. */
export function markRead(peerId: string): void {
  const t = threads.get(peerId);
  if (t && t.unread) {
    t.unread = 0;
    scheduleSave();
  }
}

export function totalUnread(): number {
  let n = 0;
  for (const t of threads.values()) n += t.unread;
  return n;
}

export { SOURCE_PEER };
