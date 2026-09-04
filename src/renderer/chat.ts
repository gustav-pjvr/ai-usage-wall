/**
 * The messages window.
 *
 * A separate window rather than a tab on the pairing panel, because the pairing
 * panel is asymmetric: the source shows a code there and the screen only ever
 * sees it once, at redemption. Putting the conversation inside it would have
 * left the receiving machine with no way in. Both machines open this the same
 * way, from the tray under Projection.
 *
 * Text only, and every message is written with textContent. The messages come
 * from another machine over a channel this app decrypts, and rendering them as
 * markup would turn a private channel into a way to script this window.
 */

interface ChatMessage {
  id: string;
  text: string;
  at: number;
  mine: boolean;
  state?: 'queued' | 'sent' | 'dropped';
}

interface ChatThread {
  peerId: string;
  label: string;
  messages: ChatMessage[];
  unread: number;
}

interface ChatView {
  threads: ChatThread[];
  role: 'source' | 'screen' | 'off';
  reachable: string[];
}

declare global {
  interface Window {
    chat: {
      load(): Promise<ChatView>;
      send(peerId: string, text: string): Promise<{ ok: boolean; delivered: boolean }>;
      markRead(peerId: string): Promise<void>;
      onChanged(cb: () => void): void;
      close(): Promise<void>;
    };
  }
}

const root = document.getElementById('chat') as HTMLElement;

let view: ChatView = { threads: [], role: 'off', reachable: [] };
let active = '';
/** Kept across redraws so a half-typed message survives an incoming one. */
let draft = '';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Clock time for a message, or the date once it is not from today. */
function stamp(at: number): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hhmm : `${d.getDate()}/${d.getMonth() + 1} ${hhmm}`;
}

/**
 * Grab the conversation and move it.
 *
 * There are no scrollbars in this window, so the wheel and the trackpad are two
 * of the three ways to scroll and this is the third. It deliberately does NOT
 * start on message text: dragging there selects, which is how a message gets
 * copied, and taking that away to add scrolling would be a poor trade. The
 * cursor says which is which, grab over the background and a caret over text.
 *
 * The three pixel threshold is what keeps a plain click from counting as a
 * drag, so clicking in the list still does nothing surprising.
 */
function enableDragScroll(list: HTMLElement): void {
  let startY = 0;
  let startTop = 0;
  let armed = false;
  let dragging = false;

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.msg-text')) return;
    armed = true;
    dragging = false;
    startY = e.clientY;
    startTop = list.scrollTop;
  });

  list.addEventListener('pointermove', (e) => {
    if (!armed) return;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) < 3) return;
      dragging = true;
      list.classList.add('dragging');
      try {
        list.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a nicety: without it a fast drag off the window just ends.
      }
    }
    list.scrollTop = startTop - dy;
  });

  const release = (e: PointerEvent) => {
    if (!armed) return;
    armed = false;
    dragging = false;
    list.classList.remove('dragging');
    try {
      list.releasePointerCapture(e.pointerId);
    } catch {
      /* never had it */
    }
  };
  list.addEventListener('pointerup', release);
  list.addEventListener('pointercancel', release);
  list.addEventListener('pointerleave', release);
}

/** How close to the bottom still counts as "reading the newest". */
const STICK_PX = 60;
/** Whether the view was pinned to the bottom before the last redraw. */
let wasAtBottom = true;

function currentThread(): ChatThread | null {
  return view.threads.find((t) => t.peerId === active) ?? view.threads[0] ?? null;
}

function render(): void {
  const prev = root.querySelector('.list');
  if (prev) {
    wasAtBottom = prev.scrollHeight - prev.scrollTop - prev.clientHeight <= STICK_PX;
  }
  root.replaceChildren();

  const thread = currentThread();
  if (thread) active = thread.peerId;

  // Header: who you are talking to, and whether they can hear you.
  const head = el('header', 'head');
  head.appendChild(el('span', 'head-label', thread ? thread.label : 'Messages'));
  const reachable = thread ? view.reachable.includes(thread.peerId) : false;
  const state = el('span', `head-state ${reachable ? 'on' : 'off'}`, reachable ? 'connected' : 'not connected');
  head.appendChild(state);
  root.appendChild(head);

  // A picker only when there is a choice to make. One screen needs no tabs.
  if (view.threads.length > 1) {
    const tabs = el('div', 'tabs');
    for (const t of view.threads) {
      const b = el('button', `tab${t.peerId === active ? ' on' : ''}`);
      b.type = 'button';
      b.appendChild(el('span', 'tab-label', t.label));
      if (t.unread > 0 && t.peerId !== active) b.appendChild(el('span', 'tab-unread', String(t.unread)));
      b.addEventListener('click', () => {
        active = t.peerId;
        void window.chat.markRead(active);
        render();
      });
      tabs.appendChild(b);
    }
    root.appendChild(tabs);
  }

  const list = el('div', 'list');
  if (!thread || thread.messages.length === 0) {
    list.appendChild(
      el(
        'p',
        'empty',
        view.role === 'off'
          ? 'Projection is off, so there is nobody to message.'
          : 'No messages yet. Type below to start.',
      ),
    );
  } else {
    let lastDay = '';
    for (const m of thread.messages) {
      const day = new Date(m.at).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        list.appendChild(el('div', 'day', stamp(m.at).includes('/') ? day : 'Today'));
      }
      const row = el('div', `msg ${m.mine ? 'mine' : 'theirs'}`);
      row.appendChild(el('div', 'msg-text', m.text));
      const meta = el('div', 'msg-meta');
      meta.appendChild(el('span', 'msg-time', stamp(m.at)));
      // Only ever claimed for messages this machine sent, and only when true.
      if (m.mine && m.state === 'queued') meta.appendChild(el('span', 'msg-queued', 'waiting to send'));
      // Evicted by the outbox cap. It will never be sent, and saying nothing
      // would leave it looking identical to one that was.
      if (m.mine && m.state === 'dropped') meta.appendChild(el('span', 'msg-dropped', 'not sent'));
      row.appendChild(meta);
      list.appendChild(row);
    }
  }
  root.appendChild(list);

  const form = el('div', 'compose');
  const input = el('textarea', 'input') as HTMLTextAreaElement;
  input.rows = 1;
  input.placeholder = 'Message';
  input.maxLength = 2000;
  input.value = draft;
  const send = el('button', 'send', 'Send') as HTMLButtonElement;
  send.type = 'button';

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  };

  const submit = async () => {
    const text = input.value.trim();
    if (!text || !thread) return;
    input.value = '';
    draft = '';
    grow();
    // Sending is an intent to be at the newest, wherever the view was.
    wasAtBottom = true;
    await window.chat.send(thread.peerId, text);
    await refresh();
    input.focus();
  };

  input.addEventListener('input', () => {
    draft = input.value;
    grow();
  });
  input.addEventListener('keydown', (e) => {
    // Enter sends. Shift+Enter is the newline, which is the convention every
    // messenger uses and therefore the one nobody has to be told about.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  });
  send.addEventListener('click', () => void submit());

  form.appendChild(input);
  form.appendChild(send);
  root.appendChild(form);

  enableDragScroll(list);

  /*
   * Follow the conversation only if the reader was already at the bottom.
   *
   * Every arriving message rebuilds this list, and jumping to the newest
   * unconditionally would drag someone out of the history they had scrolled
   * back to read. Sixty pixels of slack counts as "at the bottom", so a small
   * nudge upward does not stop it following.
   */
  requestAnimationFrame(() => {
    if (wasAtBottom) list.scrollTop = list.scrollHeight;
    input.focus();
    grow();
  });
}

async function refresh(): Promise<void> {
  view = await window.chat.load();
  if (!view.threads.some((t) => t.peerId === active)) active = view.threads[0]?.peerId ?? '';
  if (active) await window.chat.markRead(active);
  render();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void window.chat.close();
});

window.chat.onChanged(() => void refresh());

void refresh();

export {};
