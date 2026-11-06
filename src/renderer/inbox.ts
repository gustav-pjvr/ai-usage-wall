/**
 * Work mode's inbox panel (full build only, docs/work-mode.md, "Mail").
 *
 * WHAT THIS FILE NEVER DOES
 *   - Touch the network or see a password or a token. Main sends rows and
 *     plain-text bodies; every action is a request to main with an opaque
 *     handle.
 *   - Render mail as HTML. Senders, subjects, snippets and bodies all go in
 *     with textContent: no element from a message ever exists in this page, so
 *     no remote image, tracking pixel or script can load. Links in a body are
 *     text, never clickable; "Open in Outlook / Gmail / webmail" asks main,
 *     which opens only that account's web mail.
 *   - Pretend. Every action shows a pending state, then the server's read-back
 *     or a plain failure.
 */

import {
  mailSyncLabel, mailTime, webMailName,
  type MailActionKind, type MailActionResult, type MailBody, type MailOpenResult, type MailPayload, type MailRow,
} from '../shared/mail-view';
import type { ActionResult, TaskCard } from '../shared/work-view';

export interface MailBridge {
  get(): Promise<MailPayload | null>;
  open(handle: string): Promise<MailOpenResult>;
  action(handle: string, kind: MailActionKind): Promise<MailActionResult>;
  undo(token: string): Promise<MailActionResult>;
  task(handle: string): Promise<ActionResult>;
  web(handle: string): Promise<boolean>;
  connect(): Promise<void>;
  onUpdate(cb: (p: MailPayload) => void): () => void;
  onHighlight(cb: (handle: string) => void): () => void;
}

const UNDO_MS = 5000;

const PENDING: Record<MailActionKind, string> = {
  read: 'Marking read',
  unread: 'Marking unread',
  flag: 'Flagging',
  unflag: 'Removing the flag',
  archive: 'Archiving',
  trash: 'Moving to Trash',
};
const DONE: Record<MailActionKind, string> = {
  read: 'Marked read',
  unread: 'Marked unread',
  flag: 'Flagged',
  unflag: 'Flag removed',
  archive: 'Archived',
  trash: 'Moved to Trash',
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const button = (cls: string, text: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
};

/** Account ids are fixed words; anything else gets no account styling. */
const ACCOUNT_ID = /^[a-z0-9_-]{1,64}$/;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type BodyState = { state: 'loading' } | { state: 'ok'; body: MailBody } | { state: 'bad'; message: string };

export class InboxView {
  readonly root: HTMLElement;
  /** A task made from a mail, for the board to show at once. */
  onTask: ((card: TaskCard) => void) | null = null;

  private readonly title: HTMLElement;
  private readonly chips: HTMLElement;
  private readonly list: HTMLElement;
  private readonly undoBar: HTMLElement;
  private payload: MailPayload | null = null;
  private filter = 'all';
  private selected: string | null = null;
  private flash: string | null = null;
  private flashTimer = 0;
  private readonly bodies = new Map<string, BodyState>();
  private readonly pending = new Map<string, string>();
  private readonly notes = new Map<string, { text: string; tone: 'ok' | 'bad' }>();
  private readonly noteTimers = new Map<string, number>();
  private undo: { token: string; words: string; until: number; busy: boolean; message: string; tone: '' | 'ok' | 'bad' } | null = null;
  private undoTimer = 0;

  constructor(private readonly bridge: MailBridge, dragScroll: (list: HTMLElement) => void) {
    this.root = el('section', 'wpanel work-inbox');
    this.root.setAttribute('aria-label', 'Inbox');

    const head = el('div', 'inbox-head');
    this.title = el('div', 'inbox-title');
    head.append(this.title, el('span', 'inbox-order', 'newest first'));

    this.chips = el('div', 'inbox-chips');
    this.chips.setAttribute('role', 'group');
    this.chips.setAttribute('aria-label', 'Which inbox');

    this.list = el('div', 'inbox-list');
    this.list.setAttribute('role', 'list');
    this.list.setAttribute('aria-label', 'Messages, newest first');
    dragScroll(this.list);

    this.undoBar = el('div', 'inbox-undo');
    this.undoBar.hidden = true;
    this.undoBar.setAttribute('role', 'status');
    this.undoBar.setAttribute('aria-live', 'polite');

    this.root.append(head, this.chips, this.list, this.undoBar);

    bridge.onUpdate((p) => this.update(p));
    bridge.onHighlight((h) => this.highlight(h));
    void bridge.get().then((p) => {
      if (p) this.update(p);
    }).catch(() => undefined);
    this.render();
  }

  /** One status line per account, for the Work view's strip. */
  statusLines(now: number): { text: string; tone: 'ok' | 'bad' | 'off' }[] {
    const p = this.payload;
    if (!p) return [{ text: 'mail loading', tone: 'off' }];
    if (!p.accounts.length) return [{ text: 'mail not connected', tone: 'off' }];
    return p.accounts.map((a) => mailSyncLabel(a, now));
  }

  private update(p: MailPayload): void {
    this.payload = p;
    const live = new Set(p.rows.map((r) => r.handle));
    for (const h of [...this.bodies.keys()]) if (!live.has(h)) this.bodies.delete(h);
    if (this.selected && !live.has(this.selected) && !this.pending.has(this.selected)) this.selected = null;
    if (this.filter !== 'all' && !p.accounts.some((a) => a.id === this.filter)) this.filter = 'all';
    this.render();
  }

  private rows(): MailRow[] {
    const rows = this.payload?.rows ?? [];
    return this.filter === 'all' ? rows : rows.filter((r) => r.account === this.filter);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  render(): void {
    const p = this.payload;
    const loading = !p || !p.known;
    this.root.dataset.state = loading ? 'loading' : p.accounts.length ? 'on' : 'off';
    this.root.setAttribute('aria-busy', String(loading));
    this.paintHead();

    const top = this.list.scrollTop;
    this.list.replaceChildren();
    if (loading) {
      for (let i = 0; i < 6; i++) this.list.append(this.skeleton());
      return;
    }
    if (!p.accounts.length) {
      const empty = el('div', 'inbox-empty');
      empty.append(
        el('div', 'inbox-empty-title', 'Connect mail to see your inbox here'),
        el('p', 'inbox-empty-text', 'MuchBetter (Microsoft 365), Gmail and PicklePlay. Passwords and sign-ins are stored encrypted on this PC and never shown again.'),
        button('wbtn wbtn-pri', 'Connect mail', () => void this.bridge.connect()),
      );
      this.list.append(empty);
      return;
    }
    const rows = this.rows();
    if (!rows.length) this.list.append(el('div', 'work-none', 'Nothing in this inbox.'));
    for (const r of rows) this.list.append(this.row(r));
    this.list.scrollTop = top;
    if (this.flash) this.scrollToFlash();
  }

  private paintHead(): void {
    const p = this.payload;
    const unread = p ? p.accounts.reduce((n, a) => n + a.unread, 0) : 0;
    this.title.replaceChildren(el('span', 'inbox-title-k', 'Inbox'));
    if (p?.accounts.length) this.title.append(el('span', 'inbox-title-n', `${unread} unread · ${p.accounts.length} account${p.accounts.length === 1 ? '' : 's'}`));

    this.chips.replaceChildren();
    this.chips.hidden = !p?.accounts.length;
    if (!p?.accounts.length) return;
    const chip = (id: string, label: string, count: number, bad: boolean): void => {
      const b = button(`inbox-chip${this.filter === id ? ' is-on' : ''}${bad ? ' is-bad' : ''}`, '', () => {
        this.filter = id;
        this.render();
      });
      if (id !== 'all' && ACCOUNT_ID.test(id)) b.dataset.account = id;
      b.setAttribute('aria-pressed', String(this.filter === id));
      if (id !== 'all') b.append(el('i', 'inbox-dot'));
      b.append(el('span', 'inbox-chip-l', label), el('b', 'inbox-chip-n', String(count)));
      this.chips.append(b);
    };
    chip('all', 'All mail', unread, false);
    for (const a of p.accounts) chip(a.id, a.label, a.unread, a.status === 'auth' || a.status === 'tls');
  }

  private skeleton(): HTMLElement {
    const sk = el('div', 'mail mail-skeleton');
    sk.setAttribute('aria-hidden', 'true');
    sk.append(el('span', 'sk-line sk-short'), el('span', 'sk-line'), el('span', 'sk-line'));
    return sk;
  }

  private row(r: MailRow): HTMLElement {
    const node = el('div', 'mail');
    node.dataset.handle = r.handle;
    if (ACCOUNT_ID.test(r.account)) node.dataset.account = r.account;
    node.setAttribute('role', 'listitem');
    node.classList.toggle('is-unread', !r.seen);
    node.classList.toggle('is-bulk', r.bulk);
    const open = this.selected === r.handle;
    node.classList.toggle('is-open', open);
    node.classList.toggle('is-highlight', this.flash === r.handle);
    node.setAttribute('aria-expanded', String(open));
    const pending = this.pending.get(r.handle);
    node.toggleAttribute('data-pending', !!pending);
    node.setAttribute('aria-busy', String(!!pending));

    const top = el('div', 'mail-top');
    top.append(el('i', 'inbox-dot'), el('span', 'mail-from', r.fromName || r.fromAddress || 'Unknown sender'));
    if (r.flagged) {
      const f = el('span', 'mail-flag', '⚑');
      f.title = 'Flagged';
      f.setAttribute('aria-label', 'Flagged');
      top.append(f);
    }
    top.append(el('span', 'mail-time', mailTime(r.date, Date.now())));
    node.append(top, el('div', 'mail-subj', r.subject || '(no subject)'));
    if (!open && r.snippet) node.append(el('div', 'mail-snip', r.snippet));
    if (open) node.append(this.opened(r));

    const note = this.notes.get(r.handle);
    if (pending || note) {
      const msg = el('div', `task-msg mail-msg${note && !pending ? ` tone-${note.tone}` : ''}`);
      msg.setAttribute('role', 'status');
      msg.setAttribute('aria-live', 'polite');
      if (pending) {
        const spin = el('span', 'task-spin');
        spin.setAttribute('aria-hidden', 'true');
        msg.append(spin, document.createTextNode(`${pending}...`));
      } else if (note) msg.textContent = note.text;
      node.append(msg);
    }

    node.addEventListener('click', () => {
      if (this.selected === r.handle) this.selected = null;
      else {
        this.selected = r.handle;
        void this.load(r.handle);
      }
      this.render();
    });
    return node;
  }

  /** The open message: its plain-text body, attachments by name, and the actions. */
  private opened(r: MailRow): HTMLElement {
    const box = el('div', 'mail-open');
    box.addEventListener('click', (e) => e.stopPropagation());
    if (r.fromAddress) box.append(el('div', 'mail-addr', r.fromAddress));
    const state = this.bodies.get(r.handle) ?? { state: 'loading' as const };
    if (state.state === 'loading') {
      const sk = el('div', 'mail-body is-loading');
      sk.setAttribute('aria-busy', 'true');
      const words = el('span', 'mail-loading', 'Loading the message...');
      sk.append(el('span', 'sk-line'), el('span', 'sk-line'), el('span', 'sk-line sk-short'), words);
      box.append(sk);
    } else if (state.state === 'bad') {
      box.append(el('div', 'mail-body tone-bad', `Could not load the message: ${state.message}`));
    } else {
      // textContent, always: the body is text main made from the message, never markup.
      box.append(el('div', 'mail-body', state.body.text || '(This message has no text.)'));
      if (state.body.attachments.length) {
        box.append(el('div', 'mail-att', `Attachments: ${state.body.attachments.map((a) => `${a.name} (${size(a.size)})`).join(', ')}`));
      }
    }
    box.append(this.actions(r));
    return box;
  }

  private actions(r: MailRow): HTMLElement {
    const acts = el('div', 'mail-acts');
    const busy = this.pending.has(r.handle);
    const add = (cls: string, label: string, run: () => void): void => {
      const b = button(cls, label, run);
      b.disabled = busy;
      acts.append(b);
    };
    add('wbtn', r.seen ? 'Mark unread' : 'Mark read', () => void this.run(r, r.seen ? 'unread' : 'read'));
    add(`wbtn${r.flagged ? ' is-on' : ''}`, r.flagged ? 'Unflag' : 'Flag', () => void this.run(r, r.flagged ? 'unflag' : 'flag'));
    add('wbtn', 'Archive', () => void this.run(r, 'archive'));
    add('wbtn', 'Trash', () => void this.run(r, 'trash'));
    add('wbtn wbtn-pri', 'Make a task', () => void this.makeTask(r));
    add('wbtn', `Open in ${webMailName(r.account)}`, () => {
      void this.bridge.web(r.handle).catch(() => false).then((ok) => {
        if (!ok) this.note(r.handle, `Could not open ${webMailName(r.account)} in the browser.`, 'bad');
      });
    });
    return acts;
  }

  // ── Loading and actions ───────────────────────────────────────────────────

  private async load(handle: string): Promise<void> {
    const known = this.bodies.get(handle);
    if (known && known.state !== 'bad') return;
    this.bodies.set(handle, { state: 'loading' });
    let r: MailOpenResult;
    try {
      r = await this.bridge.open(handle);
    } catch {
      r = { ok: false, message: 'The wall could not ask for the message.' };
    }
    this.bodies.set(handle, r.ok ? { state: 'ok', body: r.body } : { state: 'bad', message: r.message });
    if (this.selected === handle) this.render();
  }

  private note(handle: string, text: string, tone: 'ok' | 'bad'): void {
    this.notes.set(handle, { text, tone });
    window.clearTimeout(this.noteTimers.get(handle));
    if (tone === 'ok') {
      this.noteTimers.set(handle, window.setTimeout(() => {
        this.notes.delete(handle);
        this.render();
      }, 3500));
    }
    this.render();
  }

  private async run(r: MailRow, kind: MailActionKind): Promise<void> {
    if (this.pending.has(r.handle)) return;
    this.notes.delete(r.handle);
    this.pending.set(r.handle, PENDING[kind]);
    this.render();
    let result: MailActionResult;
    try {
      result = await this.bridge.action(r.handle, kind);
    } catch {
      result = { ok: false, message: 'The wall could not send that change.' };
    }
    this.pending.delete(r.handle);
    if (!result.ok) {
      this.note(r.handle, `Not changed: ${result.message}`, 'bad');
      return;
    }
    if (kind === 'archive' || kind === 'trash') {
      // Gone from the inbox on the server's word; the undo bar can bring it back for 5 s.
      if (this.payload) this.payload = { ...this.payload, rows: this.payload.rows.filter((x) => x.handle !== r.handle) };
      if (this.selected === r.handle) this.selected = null;
      if (result.undo) this.offerUndo(result.undo, DONE[kind]);
      this.render();
      return;
    }
    if (result.row && this.payload) {
      const row = result.row;
      this.payload = { ...this.payload, rows: this.payload.rows.map((x) => (x.handle === row.handle ? { ...row, snippet: row.snippet || x.snippet } : x)) };
    }
    this.note(r.handle, DONE[kind], 'ok');
  }

  private async makeTask(r: MailRow): Promise<void> {
    if (this.pending.has(r.handle)) return;
    this.notes.delete(r.handle);
    this.pending.set(r.handle, 'Making a task');
    this.render();
    let result: ActionResult;
    try {
      result = await this.bridge.task(r.handle);
    } catch {
      result = { ok: false, message: 'The wall could not send that task.' };
    }
    this.pending.delete(r.handle);
    if (result.ok) {
      this.onTask?.(result.card);
      this.note(r.handle, 'Task made in Backlog', 'ok');
    } else this.note(r.handle, `No task made: ${result.message}`, 'bad');
  }

  private offerUndo(token: string, words: string): void {
    window.clearInterval(this.undoTimer);
    this.undo = { token, words, until: Date.now() + UNDO_MS, busy: false, message: '', tone: '' };
    this.paintUndo();
    this.undoTimer = window.setInterval(() => {
      if (!this.undo || this.undo.busy) return;
      if (Date.now() >= this.undo.until && !this.undo.tone) {
        this.undo = null;
        window.clearInterval(this.undoTimer);
      }
      this.paintUndo();
    }, 250);
  }

  private paintUndo(): void {
    const u = this.undo;
    this.undoBar.replaceChildren();
    this.undoBar.hidden = !u;
    if (!u) return;
    this.undoBar.setAttribute('aria-busy', String(u.busy));
    if (u.tone) {
      this.undoBar.append(el('span', `inbox-undo-l tone-${u.tone}`, u.message));
      return;
    }
    const left = Math.max(0, Math.ceil((u.until - Date.now()) / 1000));
    this.undoBar.append(el('span', 'inbox-undo-l', u.busy ? 'Undoing...' : `${u.words}.`));
    if (u.busy) {
      const spin = el('span', 'task-spin');
      spin.setAttribute('aria-hidden', 'true');
      this.undoBar.prepend(spin);
      return;
    }
    const b = button('wbtn wbtn-pri', `Undo (${left})`, () => void this.runUndo());
    this.undoBar.append(b);
  }

  private async runUndo(): Promise<void> {
    const u = this.undo;
    if (!u || u.busy) return;
    u.busy = true;
    this.paintUndo();
    let r: MailActionResult;
    try {
      r = await this.bridge.undo(u.token);
    } catch {
      r = { ok: false, message: 'The wall could not send the undo.' };
    }
    if (this.undo !== u) return;
    u.busy = false;
    u.tone = r.ok ? 'ok' : 'bad';
    u.message = r.ok ? 'Back in the inbox.' : `Not undone: ${r.message}`;
    this.paintUndo();
    window.clearInterval(this.undoTimer);
    this.undoTimer = window.setTimeout(() => {
      if (this.undo === u) {
        this.undo = null;
        this.paintUndo();
      }
    }, r.ok ? 2500 : 6000);
  }

  // ── Show on a notice ──────────────────────────────────────────────────────

  highlight(handle: string): void {
    if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(handle)) return;
    const row = this.payload?.rows.find((r) => r.handle === handle);
    if (row && this.filter !== 'all' && this.filter !== row.account) this.filter = 'all';
    this.flash = handle;
    this.selected = handle;
    void this.load(handle);
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flash = null;
      this.root.querySelector('.mail.is-highlight')?.classList.remove('is-highlight');
    }, 4000);
    this.render();
  }

  private scrollToFlash(): void {
    const node = this.list.querySelector<HTMLElement>('.mail.is-highlight');
    if (!node) return;
    // Within the list only: scrollIntoView would also move the stage.
    this.list.scrollTop = Math.max(0, node.offsetTop - this.list.clientHeight / 4);
  }
}
