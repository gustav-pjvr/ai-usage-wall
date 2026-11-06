/**
 * Ask Gemini: a question bar and an answer panel over the wall (full build
 * only, docs/ask-gemini.md).
 *
 * KEYBOARD FOCUS IS BORROWED, EXACTLY AS THE NOTES BAR BORROWS IT
 *
 * The wall is `focusable: false` with WS_EX_NOACTIVATE, so a text field in it
 * receives no keystroke until the main process lends the window focus
 * (docs/notes-bar.md). Opening the bar asks for the loan and AWAITS it; if the
 * window cannot be focused, the field stays read-only and says so, rather than
 * looking ready while every key goes to another application. The loan is
 * returned on close, and also whenever the window loses focus, so the wall
 * goes back to being the thing that never steals focus.
 *
 * ANSWERS ARE UNTRUSTED TEXT
 *
 * Gemini writes them, and a web search can put anyone's words in them. Main
 * has already stripped escapes and control characters; here they are only
 * ever set with textContent. The light formatting (paragraphs and "-" bullets)
 * is done by splitting the text into elements, never by parsing markup.
 *
 * The last five questions and answers of this session stay in a list below the
 * current one. Memory only: nothing is saved, and nothing here is projected.
 */

export interface AskBridge {
  start(question: string): Promise<{ ok: boolean; id?: number; model?: string; code?: string; message?: string }>;
  cancel(): Promise<boolean>;
  focus(active: boolean): Promise<boolean>;
  onOpen(cb: () => void): () => void;
  onChunk(cb: (e: { id: number; text: string }) => void): () => void;
  onDone(cb: (e: { id: number; text: string; model: string }) => void): () => void;
  onError(cb: (e: { id: number; code: string; message: string }) => void): () => void;
}

/** Matches QUESTION_MAX in src/main/ask/agy.ts; main enforces it, this is a courtesy. */
const QUESTION_MAX = 2000;
const HISTORY = 5;

interface Entry {
  question: string;
  answer: string;
  model: string;
  state: 'pending' | 'done' | 'error';
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * Answer text as elements: blank lines split paragraphs, lines starting "- ",
 * "* " or "1. " become list items. Bold markers are dropped. textContent only.
 */
export function renderAnswer(target: HTMLElement, text: string): void {
  target.replaceChildren();
  const blocks = text.replace(/\*\*|__/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    let list: HTMLUListElement | null = null;
    let para: string[] = [];
    const flush = (): void => {
      if (para.length) target.append(el('p', 'ask-p', para.join('\n')));
      para = [];
    };
    for (const line of lines) {
      const m = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
      if (m) {
        flush();
        if (!list) {
          list = el('ul', 'ask-list');
          target.append(list);
        }
        list.append(el('li', undefined, m[1]));
      } else {
        list = null;
        para.push(line.trim());
      }
    }
    flush();
  }
}

export class AskPanel {
  readonly root: HTMLElement;
  /** The ASK chip for the action row, built like the row's own buttons. */
  readonly chip: HTMLButtonElement;
  private readonly input: HTMLInputElement;
  private readonly note: HTMLElement;
  private readonly modelEl: HTMLElement;
  private readonly current: HTMLElement;
  private readonly history: HTMLElement;
  private readonly entries: Entry[] = [];
  private open = false;
  private hasFocus = false;
  private borrowing = false;
  /** The run this panel is waiting on; events for any other id are ignored. */
  private runId: number | null = null;

  constructor(private readonly bridge: AskBridge) {
    this.root = el('section');
    this.root.id = 'ask-panel';
    this.root.dataset.open = 'off';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Ask Gemini');

    const head = el('div', 'ask-head');
    head.append(el('div', 'ask-title', 'Ask Gemini'));
    this.modelEl = el('div', 'ask-model');
    const close = el('button', 'ask-close', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(this.modelEl, close);

    const bar = el('div', 'ask-bar');
    this.input = el('input', 'ask-input');
    this.input.type = 'text';
    this.input.maxLength = QUESTION_MAX;
    this.input.spellcheck = false;
    this.input.placeholder = 'Ask about your usage, or anything else';
    this.input.setAttribute('aria-label', 'Question for Gemini');
    this.input.readOnly = true;
    bar.append(this.input, el('span', 'ask-hint', 'ENTER ASKS  ·  ESC CLOSES'));

    this.note = el('div', 'ask-note');
    this.note.setAttribute('role', 'status');
    this.note.setAttribute('aria-live', 'polite');

    const body = el('div', 'ask-body');
    this.current = el('div', 'ask-current');
    this.history = el('div', 'ask-history');
    body.append(this.current, this.history);

    this.root.append(head, bar, this.note, body);

    this.chip = el('button', 'wall-action wall-action-ask', 'Ask');
    this.chip.type = 'button';
    this.chip.title = 'Ask Gemini  (Ctrl+Alt+G)';
    this.chip.addEventListener('click', () => {
      if (this.open) this.close();
      else void this.show();
    });

    this.paintCurrent();
    this.wire();
  }

  private wire(): void {
    this.input.addEventListener('keydown', (e) => {
      // Every key is the user typing. Keep it from the wall's own shortcuts,
      // which include a document-level Escape for focus mode.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.ask();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (this.runId !== null) void this.bridge.cancel();
        else this.close();
      }
    });
    // Clicking the field after the window lost focus borrows it again.
    this.input.addEventListener('mousedown', () => {
      // Also when main ended the loan on a blur that raced the borrow reply:
      // hasFocus still says true, but the document is not focused.
      if (this.open && (!this.hasFocus || !document.hasFocus())) void this.borrow();
    });
    // The window lost focus (another app was clicked): give the loan back so
    // the wall is unfocusable again. The panel stays open to be read.
    window.addEventListener('blur', () => {
      if (this.hasFocus) void this.release();
    });

    this.bridge.onOpen(() => void this.show());
    this.bridge.onChunk((e) => {
      if (e.id !== this.runId) return;
      const entry = this.entries[0];
      if (!entry || entry.state !== 'pending') return;
      entry.answer += e.text;
      this.paintCurrent();
    });
    this.bridge.onDone((e) => {
      if (e.id !== this.runId) return;
      this.runId = null;
      const entry = this.entries[0];
      if (entry) {
        entry.answer = e.text;
        entry.model = e.model;
        entry.state = 'done';
      }
      this.setBusy(false);
      this.paintCurrent();
      this.paintHistory();
    });
    this.bridge.onError((e) => {
      if (e.id !== this.runId) return;
      this.runId = null;
      const entry = this.entries[0];
      if (entry) {
        entry.answer = e.message;
        entry.state = 'error';
      }
      this.setBusy(false);
      this.paintCurrent();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Open the panel and borrow keyboard focus for the field. */
  async show(): Promise<void> {
    this.open = true;
    this.root.dataset.open = 'on';
    await this.borrow();
  }

  private async borrow(): Promise<void> {
    if (this.borrowing) return;
    this.borrowing = true;
    try {
      const focused = await this.bridge.focus(true).catch(() => false);
      if (!this.open) {
        if (focused) void this.bridge.focus(false).catch(() => undefined);
        return;
      }
      this.hasFocus = focused;
      this.input.readOnly = !focused;
      this.root.dataset.focus = focused ? 'on' : 'off';
      if (focused) {
        this.note.textContent = '';
        this.input.focus();
      } else {
        // Better a field that says it cannot type than one that sends the keys elsewhere.
        this.note.textContent = 'The wall could not take keyboard focus. Click the question field to try again.';
      }
    } finally {
      this.borrowing = false;
    }
  }

  private async release(): Promise<void> {
    this.hasFocus = false;
    this.input.readOnly = true;
    this.root.dataset.focus = 'off';
    if (document.activeElement === this.input) this.input.blur();
    await this.bridge.focus(false).catch(() => false);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.dataset.open = 'off';
    // Unconditional: the window must never stay focusable because a run is going.
    void this.release();
  }

  private async ask(): Promise<void> {
    const q = this.input.value.trim();
    if (!q || this.runId !== null) return;
    const entry: Entry = { question: q, answer: '', model: '', state: 'pending' };
    this.setBusy(true);
    const r = await this.bridge.start(q).catch(() => ({ ok: false, message: 'Gemini could not be asked.' }) as const);
    if (!r.ok || typeof r.id !== 'number') {
      this.setBusy(false);
      this.note.textContent = r.message ?? 'Gemini could not be asked.';
      return;
    }
    this.runId = r.id;
    entry.model = r.model ?? '';
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, HISTORY);
    this.input.value = '';
    this.note.textContent = '';
    this.paintCurrent();
    this.paintHistory();
  }

  private setBusy(on: boolean): void {
    this.root.dataset.busy = on ? 'on' : 'off';
    this.root.setAttribute('aria-busy', String(on));
  }

  private paintCurrent(): void {
    const entry = this.entries[0];
    this.current.replaceChildren();
    if (!entry) {
      this.current.append(el('div', 'ask-empty', 'Questions go to Gemini with the numbers on this wall. Answers are written by Gemini and can be wrong.'));
      return;
    }
    this.current.append(el('div', 'ask-q', entry.question));
    const meta = el('div', 'ask-meta');
    meta.append(el('span', 'ask-by', 'Answer by Gemini'), el('span', 'ask-by-model', entry.model));
    this.current.append(meta);
    this.modelEl.textContent = entry.model;

    const a = el('div', `ask-a is-${entry.state}`);
    if (entry.state === 'pending' && !entry.answer) {
      a.append(el('div', 'ask-pending', 'Asking Gemini...'));
      const sk = el('div', 'ask-skeleton');
      sk.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 3; i++) sk.append(el('span', 'ask-sk-line'));
      a.append(sk);
    } else if (entry.state === 'pending') {
      // Streaming: one text node, cheap to repaint per chunk; formatted on done.
      a.append(el('div', 'ask-stream', entry.answer));
    } else if (entry.state === 'error') {
      a.append(el('div', 'ask-error', entry.answer));
    } else {
      renderAnswer(a, entry.answer);
    }
    this.current.append(a);
  }

  private paintHistory(): void {
    this.history.replaceChildren();
    const older = this.entries.slice(1).filter((e) => e.state === 'done');
    if (!older.length) return;
    this.history.append(el('div', 'ask-section', 'Earlier this session'));
    for (const e of older) {
      const item = el('details', 'ask-old');
      const sum = el('summary', 'ask-old-q', e.question);
      const body = el('div', 'ask-old-a');
      renderAnswer(body, e.answer);
      item.append(sum, body);
      this.history.append(item);
    }
  }
}
