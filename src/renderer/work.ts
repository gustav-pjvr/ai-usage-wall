/**
 * Work mode: the monday Tasks board on the wall (full build only,
 * docs/work-mode.md). Phase 1 is tasks; mail arrives in phase 2.
 *
 * WHAT THIS FILE NEVER DOES
 *   - Touch the network. The renderer runs under connect-src 'none'; every
 *     fetch is in the main process (src/main/work/sync.ts).
 *   - See the token. The payload is board data and a sync status, nothing else.
 *   - Interpret monday text as markup. Every task name, project and date goes
 *     in with textContent.
 *   - Pretend. A change shows a pending state, then what monday read back or a
 *     plain failure; the card only moves once monday has confirmed it.
 *
 * TEXT BOXES BORROW FOCUS
 *   The wall is `focusable: false` (docs/notes-bar.md). A comment, a date or a
 *   new task asks main for the keyboard first and AWAITS it; if Windows will
 *   not give it, the box stays read-only and says so, rather than looking ready
 *   while every key goes to another application.
 */

import {
  GUSTAV_ID, MOVES, PRIORITIES, filterColumns, localDay, isNewFromJaco, isOverdue, personInitial, summarize, syncLabel,
  type ActionResult, type TaskAction, type TaskCard, type TaskColumns, type TaskPriority, type TaskStatus,
  type TasksView, type WorkFilter, type WorkPayload,
} from '../shared/work-view';

export interface WorkBridge {
  get(): Promise<WorkPayload | null>;
  action(taskId: string, action: TaskAction): Promise<ActionResult>;
  create(input: { name: string; priority?: TaskPriority; due?: string }): Promise<ActionResult>;
  open(taskId: string): Promise<boolean>;
  focus(active: boolean): Promise<boolean>;
  connect(): Promise<void>;
  onUpdate(cb: (p: WorkPayload) => void): () => void;
  onHighlight(cb: (id: string) => void): () => void;
  onCard(cb: (card: TaskCard) => void): () => void;
}

type ColKey = keyof TaskColumns;

const COLUMNS: readonly { key: ColKey; title: string; tone: string }[] = [
  { key: 'inProgress', title: 'In progress', tone: 'prog' },
  { key: 'waiting', title: 'Waiting on someone else', tone: 'wait' },
  { key: 'backlog', title: 'Backlog', tone: 'back' },
  { key: 'done', title: 'Done, last 7 days', tone: 'done' },
];

const STATS: readonly { key: keyof ReturnType<typeof summarize>; label: string; tone?: string }[] = [
  { key: 'inProgress', label: 'In progress' },
  { key: 'waiting', label: 'Waiting on someone', tone: 'wait' },
  { key: 'overdue', label: 'Overdue', tone: 'late' },
  { key: 'dueThisWeek', label: 'Due this week' },
  { key: 'newFromJaco', label: 'New from Jaco', tone: 'jaco' },
  { key: 'doneThisWeek', label: 'Done this week', tone: 'done' },
];

const PENDING_WORD: Record<TaskStatus, string> = {
  'In progress': 'Moving to In progress',
  Waiting: 'Moving to Waiting',
  'Not started': 'Moving to Backlog',
  Done: 'Marking done',
  Dropped: 'Dropping',
};
const DONE_WORD: Record<TaskStatus, string> = {
  'In progress': 'Moved to In progress',
  Waiting: 'Moved to Waiting',
  'Not started': 'Moved to Backlog',
  Done: 'Marked done',
  Dropped: 'Dropped. It leaves the board view.',
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

/** "5 Nov", from a YYYY-MM-DD or ISO string, read as a calendar date (UTC, as monday stores it). */
function shortDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Today's local date, plus `days`, as YYYY-MM-DD (the shared helper). */
const localDate = (days: number): string => localDay(Date.now(), days);

const columnOf = (status: TaskStatus): ColKey | null =>
  status === 'In progress' ? 'inProgress' : status === 'Waiting' ? 'waiting' : status === 'Not started' ? 'backlog' : status === 'Done' ? 'done' : null;

/** Open columns soonest due first (no date last); Done newest first. Stable otherwise. */
function ordered(key: ColKey, cards: TaskCard[]): TaskCard[] {
  const list = [...cards];
  if (key === 'done') return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return list.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
}

/**
 * Grab a column and move it, like the messages window. Not on buttons, inputs
 * or an open card's controls; a three pixel threshold keeps a click a click,
 * and the click that ends a drag is swallowed so a drag never opens a card.
 */
function enableDragScroll(list: HTMLElement): void {
  let startY = 0;
  let startTop = 0;
  let armed = false;
  let dragging = false;
  let swallow = false;
  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, textarea, .task-acts')) return;
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
  const release = (e: PointerEvent): void => {
    if (!armed) return;
    armed = false;
    if (dragging) swallow = true;
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
  list.addEventListener('click', (e) => {
    if (!swallow) return;
    swallow = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

/** The keyboard loan, shared by every Work text box. One box at a time. */
class FocusLoan {
  held = false;
  private busy = false;
  constructor(private readonly bridge: WorkBridge) {
    window.addEventListener('blur', () => {
      if (this.held) void this.release();
    });
  }
  async borrow(): Promise<boolean> {
    if (this.held) return document.hasFocus();
    if (this.busy) return false;
    this.busy = true;
    try {
      this.held = await this.bridge.focus(true).catch(() => false);
      return this.held;
    } finally {
      this.busy = false;
    }
  }
  async release(): Promise<void> {
    this.held = false;
    const active = document.activeElement as HTMLElement | null;
    if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName) && active.closest('#view-work, #work-new')) active.blur();
    // Without the loan no key can reach the wall: say so rather than look editable.
    // Clicking a box borrows again (its mousedown handler).
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('#view-work .task-input, #work-new .task-input')) input.readOnly = true;
    for (const box of document.querySelectorAll<HTMLElement>('#view-work .task-edit, #work-new')) box.dataset.focus = 'off';
    await this.bridge.focus(false).catch(() => false);
  }
}

interface Editor {
  taskId: string;
  kind: 'comment' | 'date';
}

export class WorkView {
  readonly root: HTMLElement;
  /** Mine | Everyone, for the action row. */
  readonly filterChip: HTMLElement;
  /** "+ Task", for the action row. */
  readonly newChip: HTMLButtonElement;
  /** The new-task form, hanging from the action row. */
  readonly newPanel: HTMLElement;
  onFilter: ((f: WorkFilter) => void) | null = null;

  private readonly strip: HTMLElement;
  private readonly lists = new Map<ColKey, HTMLElement>();
  private readonly counts = new Map<ColKey, HTMLElement>();
  private readonly statusEl: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly loan: FocusLoan;
  private payload: WorkPayload | null = null;
  private tasks: TasksView | null = null;
  private filter: WorkFilter = 'mine';
  private visible = false;
  private openId: string | null = null;
  private editor: Editor | null = null;
  private highlightId: string | null = null;
  private highlightTimer = 0;
  private statusTimer = 0;
  /** Per task: an action in flight (its words), and the last result. */
  private readonly pending = new Map<string, string>();
  private readonly notes = new Map<string, { text: string; tone: 'ok' | 'bad' }>();
  private readonly noteTimers = new Map<string, number>();
  private creating = false;

  constructor(private readonly bridge: WorkBridge) {
    this.loan = new FocusLoan(bridge);
    this.root = el('div', 'work');
    this.root.setAttribute('aria-label', 'Work: the monday Tasks board');

    this.strip = el('section', 'wpanel work-strip');
    this.strip.setAttribute('aria-label', 'Task summary');

    const cols = el('div', 'work-cols');
    for (const c of COLUMNS) {
      const col = el('section', `wpanel work-col tone-${c.tone}`);
      col.dataset.col = c.key;
      const head = el('div', 'work-col-head');
      const title = el('div', 'work-col-title');
      title.append(el('i', 'work-col-dot'), el('span', undefined, c.title));
      const count = el('span', 'work-count', '');
      head.append(title, count);
      const list = el('div', 'work-list');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', c.title);
      enableDragScroll(list);
      col.append(head, list);
      cols.append(col);
      this.lists.set(c.key, list);
      this.counts.set(c.key, count);
    }

    this.empty = el('div', 'work-empty');
    this.empty.hidden = true;

    this.statusEl = el('div', 'work-status');
    this.statusEl.setAttribute('role', 'status');

    this.root.append(this.strip, cols, this.empty, this.statusEl);

    // Mine | Everyone.
    this.filterChip = el('div', 'wall-seg work-chip work-filter');
    this.filterChip.setAttribute('role', 'group');
    this.filterChip.setAttribute('aria-label', 'Whose tasks');
    for (const [f, label] of [['mine', 'Mine'], ['everyone', 'Everyone']] as const) {
      const b = button('wall-seg-btn', label, () => {
        if (this.filter === f) return;
        this.setFilter(f);
        this.onFilter?.(f);
      });
      b.dataset.filter = f;
      this.filterChip.append(b);
    }

    this.newChip = button('wall-action work-chip work-new-chip', '+ Task', () => {
      if (this.newPanel.dataset.open === 'on') this.closeNew();
      else void this.openNew();
    });
    this.newChip.title = 'New task in Backlog';
    this.newPanel = this.buildNewPanel();

    bridge.onUpdate((p) => this.update(p));
    bridge.onHighlight((id) => this.highlight(id));
    bridge.onCard((card) => this.apply(card));
    void bridge.get().then((p) => {
      if (p) this.update(p);
    }).catch(() => undefined);

    this.setFilter('mine');
    this.render();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    window.clearInterval(this.statusTimer);
    if (on) {
      this.paintStatus();
      // The age in the strip is read off the clock, so it ticks while shown.
      this.statusTimer = window.setInterval(() => this.paintStatus(), 5000);
    } else {
      this.closeNew();
      if (this.editor) this.closeEditor();
    }
  }

  setFilter(f: WorkFilter): void {
    this.filter = f;
    for (const b of this.filterChip.querySelectorAll<HTMLButtonElement>('.wall-seg-btn')) {
      const on = b.dataset.filter === f;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.render();
  }

  private update(p: WorkPayload): void {
    this.payload = p;
    if (p.tasks) this.tasks = structuredClone(p.tasks);
    else if (!p.status.connected) this.tasks = null;
    this.render();
  }

  /** A card monday has confirmed (from a toast's Done): move it now, the next sync agrees. */
  private apply(card: TaskCard): void {
    if (!this.tasks) return;
    const cols = this.tasks.columns;
    for (const key of Object.keys(cols) as ColKey[]) cols[key] = cols[key].filter((c) => c.id !== card.id);
    const key = columnOf(card.status);
    if (key) cols[key].push(card);
    this.render();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    // A box being typed in is never rebuilt under the caret; the board catches up when it closes.
    if (this.editor) {
      this.paintStatus();
      return;
    }
    const p = this.payload;
    const connected = p?.status.connected === true;
    const loading = !p || (connected && !this.tasks);
    this.root.dataset.state = !p ? 'loading' : !connected ? 'off' : loading ? 'loading' : 'on';
    this.root.setAttribute('aria-busy', String(loading));
    this.newChip.disabled = !connected || !this.tasks;
    this.paintEmpty(p, connected);

    const columns = this.tasks ? filterColumns(this.tasks.columns, this.filter) : null;
    this.paintStrip(columns);
    for (const c of COLUMNS) {
      const list = this.lists.get(c.key)!;
      const count = this.counts.get(c.key)!;
      const top = list.scrollTop;
      list.replaceChildren();
      if (!columns) {
        count.textContent = '';
        if (loading) for (let i = 0; i < 3; i++) list.append(this.skeleton());
        continue;
      }
      const cards = ordered(c.key, columns[c.key]);
      count.textContent = String(cards.length);
      if (!cards.length) list.append(el('div', 'work-none', this.filter === 'mine' ? 'Nothing of yours here.' : 'Nothing here.'));
      for (const card of cards) list.append(this.card(card, c.key));
      list.scrollTop = top;
    }
    this.paintStatus();
    if (this.highlightId) this.scrollToHighlight();
  }

  private paintEmpty(p: WorkPayload | null, connected: boolean): void {
    this.empty.replaceChildren();
    this.empty.hidden = !p || connected;
    if (this.empty.hidden) return;
    this.empty.append(
      el('div', 'work-empty-title', 'Connect monday to see your tasks here'),
      el('p', 'work-empty-text', 'Paste a monday personal API token once. It is stored encrypted on this PC, used only to read and update the Tasks board, and never shown again.'),
      button('wbtn wbtn-pri', 'Connect monday', () => void this.bridge.connect()),
    );
  }

  private paintStrip(columns: TaskColumns | null): void {
    this.strip.replaceChildren();
    const counts = columns && this.tasks ? summarize(columns, this.tasks.at) : null;
    for (const s of STATS) {
      const cell = el('div', `work-stat${s.tone ? ` tone-${s.tone}` : ''}`);
      const num = el('b', 'work-stat-n', counts ? String(counts[s.key]) : '');
      if (!counts) {
        num.classList.add('is-skeleton');
        num.setAttribute('aria-hidden', 'true');
      }
      cell.append(num, el('span', 'work-stat-l', s.label));
      this.strip.append(cell);
    }
  }

  private paintStatus(): void {
    const p = this.payload;
    this.statusEl.replaceChildren();
    const sync = p ? syncLabel(p.status, Date.now()) : { text: 'monday loading', tone: 'off' as const };
    const s = el('span', `work-sync tone-${sync.tone}`, sync.text);
    this.statusEl.append(
      s,
      el('span', undefined, 'Quiet hours 18:00 to 07:30 and weekends'),
      el('span', undefined, 'Work data stays on this PC, never projected'),
      el('span', undefined, 'Mail arrives in phase 2'),
    );
  }

  private skeleton(): HTMLElement {
    const sk = el('div', 'task task-skeleton');
    sk.setAttribute('aria-hidden', 'true');
    sk.append(el('span', 'sk-line'), el('span', 'sk-line sk-short'));
    return sk;
  }

  private card(card: TaskCard, col: ColKey): HTMLElement {
    const at = this.tasks?.at ?? new Date().toISOString();
    const node = el('div', 'task');
    node.dataset.id = card.id;
    node.setAttribute('role', 'listitem');
    if (card.priority === 'High') node.classList.add('is-high');
    const fresh = isNewFromJaco(card);
    if (fresh) node.classList.add('is-new');
    if (card.id === this.highlightId) node.classList.add('is-highlight');
    const open = this.openId === card.id;
    node.classList.toggle('is-open', open);
    node.setAttribute('aria-expanded', String(open));
    const pending = this.pending.get(card.id);
    node.toggleAttribute('data-pending', !!pending);
    node.setAttribute('aria-busy', String(!!pending));

    node.append(el('div', 'task-name', card.name));
    const meta = el('div', 'task-meta');
    if (card.project) meta.append(el('span', 'task-proj', card.project));
    if (card.priority) meta.append(el('span', `task-pri pri-${card.priority.toLowerCase()}`, card.priority === 'Medium' ? 'MED' : card.priority.toUpperCase()));
    if (col === 'done') meta.append(el('span', 'task-due', shortDate(localDay(Date.parse(card.updatedAt)))));
    else if (card.due) meta.append(el('span', `task-due${isOverdue(card, at) ? ' is-late' : ''}`, `due ${shortDate(card.due)}`));
    else if (col === 'waiting') meta.append(el('span', 'task-due', `since ${shortDate(localDay(Date.parse(card.updatedAt)))}`));
    const who = el('span', 'task-who');
    for (const id of card.ownerIds.slice(0, 3)) {
      const av = el('span', `task-av${personInitial(id) === 'J' ? ' is-j' : ''}`, personInitial(id));
      av.setAttribute('aria-hidden', 'true');
      who.append(av);
    }
    meta.append(who);
    node.append(meta);
    if (fresh) node.append(el('div', 'task-new', 'New, assigned by Jaco'));

    if (open) node.append(this.actions(card));
    const note = this.notes.get(card.id);
    const msg = el('div', `task-msg${note ? ` tone-${note.tone}` : ''}`);
    msg.setAttribute('role', 'status');
    msg.setAttribute('aria-live', 'polite');
    if (pending) {
      const spin = el('span', 'task-spin');
      spin.setAttribute('aria-hidden', 'true');
      msg.append(spin, document.createTextNode(`${pending}...`));
    } else if (note) msg.textContent = note.text;
    if (pending || note) node.append(msg);

    node.addEventListener('click', () => {
      if (this.editor) return;
      this.openId = this.openId === card.id ? null : card.id;
      this.render();
    });
    return node;
  }

  private actions(card: TaskCard): HTMLElement {
    const acts = el('div', 'task-acts');
    const busy = this.pending.has(card.id);
    const row = (label: string): HTMLElement => {
      const r = el('div', 'task-row');
      r.append(el('span', 'task-row-l', label));
      acts.append(r);
      return r;
    };

    const move = row('Move');
    for (const m of MOVES) {
      if (m.status === card.status) continue;
      const b = button(`wbtn${m.status === 'Done' ? ' wbtn-pri' : ''}`, m.label, () =>
        void this.run(card, { kind: 'status', value: m.status }, PENDING_WORD[m.status], DONE_WORD[m.status]));
      b.disabled = busy;
      move.append(b);
    }

    const pri = row('Priority');
    for (const p of PRIORITIES) {
      const b = button(`wbtn${card.priority === p ? ' is-on' : ''}`, p, () => {
        if (card.priority !== p) void this.run(card, { kind: 'priority', value: p }, `Setting ${p} priority`, `Priority ${p}`);
      });
      b.disabled = busy;
      b.setAttribute('aria-pressed', String(card.priority === p));
      pri.append(b);
    }

    const due = row('Due');
    const dueBtn = (label: string, value: string | null, words: string): void => {
      const b = button('wbtn', label, () => {
        if (card.due !== value) void this.run(card, { kind: 'due', value }, words, value ? `Due ${shortDate(value)}` : 'Due date cleared');
      });
      b.disabled = busy;
      due.append(b);
    };
    dueBtn('Today', localDate(0), 'Setting the due date');
    dueBtn('Tomorrow', localDate(1), 'Setting the due date');
    dueBtn('+1 week', localDate(7), 'Setting the due date');
    const pick = button('wbtn', 'Date...', () => void this.openEditor(card.id, 'date'));
    pick.disabled = busy;
    due.append(pick);
    if (card.due) dueBtn('Clear', null, 'Clearing the due date');

    const more = row('');
    const comment = button('wbtn', 'Comment...', () => void this.openEditor(card.id, 'comment'));
    comment.disabled = busy;
    const openB = button('wbtn', 'Open in monday', () => {
      void this.bridge.open(card.id).then((ok) => {
        if (!ok) this.note(card.id, 'Could not open that task in the browser.', 'bad');
      });
    });
    more.append(comment, openB);

    if (this.editor?.taskId === card.id) acts.append(this.editorBox(card));
    return acts;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private note(id: string, text: string, tone: 'ok' | 'bad'): void {
    this.notes.set(id, { text, tone });
    window.clearTimeout(this.noteTimers.get(id));
    // Success fades; a failure stays until the next try or the card closes.
    if (tone === 'ok') {
      this.noteTimers.set(id, window.setTimeout(() => {
        this.notes.delete(id);
        this.render();
      }, 3500));
    }
    this.render();
  }

  private async run(card: TaskCard, action: TaskAction, pendingWords: string, doneWords: string): Promise<boolean> {
    if (this.pending.has(card.id)) return false;
    this.notes.delete(card.id);
    this.pending.set(card.id, pendingWords);
    this.render();
    let result: ActionResult;
    try {
      result = await this.bridge.action(card.id, action);
    } catch {
      result = { ok: false, message: 'The wall could not send that change.' };
    }
    this.pending.delete(card.id);
    if (result.ok) {
      // Only now, with monday's own read-back, does the card change.
      this.apply(result.card);
      this.note(card.id, doneWords, 'ok');
      return true;
    }
    this.note(card.id, `Not changed: ${result.message}`, 'bad');
    return false;
  }

  // ── Comment and date box ─────────────────────────────────────────────────

  private async openEditor(taskId: string, kind: Editor['kind']): Promise<void> {
    this.editor = { taskId, kind };
    this.openId = taskId;
    this.forceRender();
    const focused = await this.loan.borrow();
    if (this.editor?.taskId !== taskId) return;
    const box = this.root.querySelector<HTMLElement>(`.task[data-id="${taskId}"] .task-edit`);
    const input = box?.querySelector<HTMLInputElement | HTMLTextAreaElement>('.task-input');
    if (!box || !input) return;
    input.readOnly = !focused;
    box.dataset.focus = focused ? 'on' : 'off';
    const hint = box.querySelector('.task-edit-note');
    if (hint) hint.textContent = focused ? '' : 'The wall could not take keyboard focus. Click the box to try again.';
    if (focused) input.focus();
  }

  private closeEditor(): void {
    this.editor = null;
    if (this.loan.held) void this.loan.release();
    this.render();
  }

  /** Render even while an editor is open (used when the editor itself opens). */
  private forceRender(): void {
    const ed = this.editor;
    this.editor = null;
    this.render();
    this.editor = ed;
    // Rebuild just the open card so its editor box appears.
    if (!ed || !this.tasks) return;
    const node = this.root.querySelector<HTMLElement>(`.task[data-id="${ed.taskId}"]`);
    const card = Object.values(this.tasks.columns).flat().find((c) => c.id === ed.taskId);
    if (!node || !card) return;
    const acts = node.querySelector('.task-acts');
    if (acts) acts.replaceWith(this.actions(card));
  }

  private editorBox(card: TaskCard): HTMLElement {
    const kind = this.editor!.kind;
    const box = el('form', 'task-edit');
    box.dataset.focus = 'off';
    box.addEventListener('click', (e) => e.stopPropagation());
    const input = kind === 'comment' ? el('textarea', 'task-input') : el('input', 'task-input');
    if (input instanceof HTMLInputElement) {
      input.type = 'date';
      input.value = card.due ?? localDate(0);
    } else {
      input.rows = 3;
      input.maxLength = 10_000;
      input.placeholder = 'Comment for monday (Ctrl+Enter posts)';
    }
    input.spellcheck = false;
    input.readOnly = true;
    input.setAttribute('aria-label', kind === 'comment' ? 'Comment' : 'Due date');
    const save = el('button', 'wbtn wbtn-pri', kind === 'comment' ? 'Post comment' : 'Set date');
    save.type = 'submit';
    const cancel = button('wbtn', 'Cancel', () => this.closeEditor());
    const noteEl = el('div', 'task-edit-note');
    noteEl.setAttribute('role', 'status');
    const actions = el('div', 'task-edit-acts');
    actions.append(save, cancel);
    box.append(input, actions, noteEl);

    input.addEventListener('mousedown', () => {
      if (!this.loan.held || !document.hasFocus()) {
        void this.loan.borrow().then((ok) => {
          input.readOnly = !ok;
          box.dataset.focus = ok ? 'on' : 'off';
          noteEl.textContent = ok ? '' : 'The wall could not take keyboard focus. Click the box to try again.';
          if (ok) input.focus();
        });
      }
    });
    input.addEventListener('keydown', (e) => {
      // Every key is typing: keep it from the wall's own shortcuts (Tab, Escape).
      e.stopPropagation();
      const ke = e as KeyboardEvent;
      if (ke.key === 'Escape') {
        ke.preventDefault();
        this.closeEditor();
      } else if (ke.key === 'Enter' && (kind === 'date' || ke.ctrlKey)) {
        ke.preventDefault();
        box.requestSubmit();
      }
    });
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (kind === 'comment' && !value) {
        noteEl.textContent = 'Write something first.';
        return;
      }
      if (kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        noteEl.textContent = 'Pick a date first.';
        return;
      }
      this.editor = null;
      void this.loan.release();
      const action: TaskAction = kind === 'comment' ? { kind: 'comment', value } : { kind: 'due', value };
      void this.run(card, action, kind === 'comment' ? 'Posting the comment' : 'Setting the due date',
        kind === 'comment' ? 'Comment posted' : `Due ${shortDate(value)}`).then((ok) => {
        // A failed comment is not lost: the box opens again with the text in it.
        if (!ok && kind === 'comment') {
          void this.openEditor(card.id, 'comment').then(() => {
            const again = this.root.querySelector<HTMLTextAreaElement>(`.task[data-id="${card.id}"] .task-input`);
            if (again) again.value = value;
          });
        }
      });
    });
    return box;
  }

  // ── New task ──────────────────────────────────────────────────────────────

  private buildNewPanel(): HTMLElement {
    const panel = el('form', 'work-new');
    panel.id = 'work-new';
    panel.dataset.open = 'off';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'New task');
    const head = el('div', 'work-new-head');
    head.append(el('div', 'work-new-title', 'New task'), el('div', 'work-new-sub', 'Lands in Backlog, owned and assigned by you'));
    const name = el('input', 'task-input work-new-name');
    name.type = 'text';
    name.maxLength = 500;
    name.spellcheck = false;
    name.placeholder = 'Task name';
    name.setAttribute('aria-label', 'Task name');
    name.readOnly = true;

    const priRow = el('div', 'task-row');
    priRow.append(el('span', 'task-row-l', 'Priority'));
    for (const p of ['None', ...PRIORITIES] as const) {
      const b = button(`wbtn${p === 'None' ? ' is-on' : ''}`, p, () => {
        for (const x of priRow.querySelectorAll<HTMLButtonElement>('.wbtn')) {
          x.classList.toggle('is-on', x === b);
          x.setAttribute('aria-pressed', String(x === b));
        }
        panel.dataset.priority = p;
      });
      b.setAttribute('aria-pressed', String(p === 'None'));
      priRow.append(b);
    }
    panel.dataset.priority = 'None';

    const dueRow = el('div', 'task-row');
    const due = el('input', 'task-input work-new-due');
    due.type = 'date';
    due.readOnly = true;
    due.setAttribute('aria-label', 'Due date (optional)');
    dueRow.append(el('span', 'task-row-l', 'Due'), due);

    const note = el('div', 'task-edit-note work-new-note');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    const create = el('button', 'wbtn wbtn-pri work-new-create', 'Create task');
    create.type = 'submit';
    const cancel = button('wbtn', 'Cancel', () => this.closeNew());
    const acts = el('div', 'task-edit-acts');
    acts.append(create, cancel);
    panel.append(head, name, priRow, dueRow, acts, note);

    for (const input of [name, due]) {
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closeNew();
        }
      });
      input.addEventListener('mousedown', () => {
        if (panel.dataset.open === 'on' && (!this.loan.held || !document.hasFocus())) void this.grantNew();
      });
    }

    panel.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.creating) return;
      const taskName = name.value.trim();
      if (!taskName) {
        note.textContent = 'A task needs a name.';
        return;
      }
      const input: { name: string; priority?: TaskPriority; due?: string } = { name: taskName };
      const p = panel.dataset.priority;
      if (p === 'High' || p === 'Medium' || p === 'Low') input.priority = p;
      if (due.value) input.due = due.value;
      this.creating = true;
      panel.setAttribute('aria-busy', 'true');
      create.disabled = true;
      create.textContent = 'Creating...';
      note.textContent = '';
      note.className = 'task-edit-note work-new-note';
      void this.bridge.create(input).catch(() => ({ ok: false, message: 'The wall could not send that task.' }) as ActionResult)
        .then((r) => {
          this.creating = false;
          panel.setAttribute('aria-busy', 'false');
          create.disabled = false;
          create.textContent = 'Create task';
          if (r.ok) {
            name.value = '';
            due.value = '';
            this.apply(r.card);
            this.highlight(r.card.id);
            this.closeNew();
          } else {
            note.classList.add('tone-bad');
            note.textContent = `Not created: ${r.message}`;
          }
        });
    });
    return panel;
  }

  private async grantNew(): Promise<void> {
    const ok = await this.loan.borrow();
    if (this.newPanel.dataset.open !== 'on') return;
    const name = this.newPanel.querySelector<HTMLInputElement>('.work-new-name')!;
    const due = this.newPanel.querySelector<HTMLInputElement>('.work-new-due')!;
    const note = this.newPanel.querySelector<HTMLElement>('.work-new-note')!;
    name.readOnly = !ok;
    due.readOnly = !ok;
    this.newPanel.dataset.focus = ok ? 'on' : 'off';
    if (!ok) note.textContent = 'The wall could not take keyboard focus. Click the name box to try again.';
    else {
      if (note.textContent?.startsWith('The wall could not take')) note.textContent = '';
      name.focus();
    }
  }

  private async openNew(): Promise<void> {
    if (this.newChip.disabled) return;
    if (this.editor) this.closeEditor();
    this.newPanel.dataset.open = 'on';
    this.newChip.setAttribute('aria-expanded', 'true');
    await this.grantNew();
  }

  closeNew(): void {
    if (this.newPanel.dataset.open !== 'on') return;
    this.newPanel.dataset.open = 'off';
    this.newChip.setAttribute('aria-expanded', 'false');
    if (this.loan.held) void this.loan.release();
  }

  // ── Highlight (Show on a notice) ──────────────────────────────────────────

  highlight(id: string): void {
    if (!/^\d{1,30}$/.test(id)) return;
    this.highlightId = id;
    // Show finds the task even when it is someone else's.
    const all = this.tasks ? Object.values(this.tasks.columns).flat() : [];
    const card = all.find((c) => c.id === id);
    if (card && this.filter === 'mine' && !card.ownerIds.includes(GUSTAV_ID)) {
      this.setFilter('everyone');
      this.onFilter?.('everyone');
    }
    this.openId = id;
    window.clearTimeout(this.highlightTimer);
    this.highlightTimer = window.setTimeout(() => {
      this.highlightId = null;
      this.root.querySelector('.task.is-highlight')?.classList.remove('is-highlight');
    }, 4000);
    if (!this.editor) this.render();
  }

  private scrollToHighlight(): void {
    const node = this.root.querySelector<HTMLElement>('.task.is-highlight');
    const list = node?.closest<HTMLElement>('.work-list');
    if (!node || !list) return;
    // Within the column only: scrollIntoView would also move the stage.
    list.scrollTop = Math.max(0, node.offsetTop - list.clientHeight / 3);
  }

  /** True while the view is on screen (main.ts reads it for Tab). */
  get shown(): boolean {
    return this.visible;
  }
}
