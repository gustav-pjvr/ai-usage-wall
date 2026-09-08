/**
 * The notes bar: one line of text across the top of the wall, locked until you
 * double click it.
 *
 * WHAT IT IS FOR
 *
 * Gustav asked for somewhere to keep "basic notes or command reminders" on a
 * surface he is already looking at all day. That is a different thing from a
 * notes app: it has to be readable without being clicked, impossible to change
 * by accident, and gone from the way the moment it is not being used.
 *
 * WHY IT LOCKS
 *
 * The wall sits under every other window and takes stray clicks all day. An
 * always-editable field there would collect keystrokes meant for whatever was
 * really in focus, and the note is the kind of thing you only notice has been
 * mangled long after it happened. So the field is `readonly` until a DOUBLE
 * click, which is a gesture nothing else on the wall uses, and it locks again
 * the moment focus leaves.
 *
 * `readonly` ALONE IS NOT THE LOCK, and the first version of this file was
 * wrong about that. A readonly input still takes focus from an ordinary single
 * click: unlike `disabled` it only refuses to change its value, and
 * `tabIndex = -1` only removes it from the Tab order. So a stray click, or the
 * first half of the intended double click, parked the caret in a field that
 * looked locked, and the keydown handler below then swallowed every keystroke
 * before it could reach the wall's own shortcuts. The lock is therefore three
 * things together: readonly, a mousedown that refuses focus while locked, and a
 * keydown handler that does nothing at all unless an edit is actually open.
 *
 * DOM FOCUS IS NOT KEYBOARD FOCUS HERE
 *
 * The wall's windows are created `focusable: false` and carry
 * `WS_EX_NOACTIVATE`, which is what lets them sit behind everything without
 * stealing focus. A window like that never receives a keystroke. `input.focus()`
 * alone would therefore give this field the caret in the DOM, paint the editing
 * state, and send every character the user typed to whatever application was
 * really in front, with no caret on screen to suggest otherwise. That is the
 * exact trap the pairing window was built to avoid.
 *
 * So an edit BORROWS keyboard focus from the main process for its duration and
 * gives it back on lock. `host.setEditing` is that handoff, and it is awaited
 * before the field is unlocked: if the window cannot be focused, the edit does
 * not open at all rather than opening somewhere the keys will not arrive.
 *
 * WHERE IT LIVES
 *
 * In the shell, above the stage, so it spans the whole window and shows in both
 * views. It is NOT part of the stats view: switching to the client wall must
 * not take the note away.
 *
 * The text is persisted in settings.json, which is already atomic and already
 * arrives in the renderer on every state push. It is deliberately LOCAL: the
 * note does not travel over projection, because a paired screen is someone
 * else's machine and this field will hold whatever Gustav happens to be
 * thinking about.
 */

/** Long enough for several reminders on one line, short enough to stay a bar. */
export const NOTES_MAX = 400;

/**
 * Cap by the same measure the input itself uses.
 *
 * `maxlength` counts grapheme clusters; `String.slice` counts UTF-16 code
 * units. A 400 character note with an emoji or a composed accent in it passed
 * the field's own limit and was then quietly cut on lock. `Array.from` iterates
 * code points, which is close enough to agree with the field for any note
 * anyone will actually type.
 */
export const capped = (text: string): string =>
  Array.from(text).slice(0, NOTES_MAX).join('');

export interface NotesHost {
  /**
   * Persist the text. Called on lock, and only when it actually changed.
   *
   * Returns a promise ON PURPOSE. The bar flips to locked the instant the user
   * clicks away, long before the write lands, so a failed save would otherwise
   * be a note that looks kept and is gone at the next launch. The bar waits for
   * this and marks itself if it rejects.
   */
  save(text: string): Promise<void>;

  /**
   * Borrow or return keyboard focus for the whole window.
   *
   * Resolves true when the window actually holds focus. False means the keys
   * would go somewhere else, and the edit is abandoned rather than opened.
   */
  setEditing(active: boolean): Promise<boolean>;
}

export class NotesBar {
  readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  /** The last value known to be persisted, so Escape has something to go back to. */
  private committed = '';
  /**
   * A value that arrived from a state push while an edit was open.
   *
   * Held rather than applied, and NOT written into `committed`, because
   * `committed` is what Escape restores. Another monitor's wall window saving
   * mid-edit used to silently redefine "cancel" as "adopt whatever the other
   * screen just wrote".
   */
  private incoming: string | null = null;
  private editing = false;
  /** True between asking for focus and getting an answer. */
  private opening = false;

  constructor(private readonly host: NotesHost) {
    this.root = document.createElement('div');
    this.root.id = 'notes-bar';
    this.root.dataset.state = 'locked';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'notes-input';
    this.input.readOnly = true;
    this.input.maxLength = NOTES_MAX;
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Wall note');
    // Not reachable by Tab while locked. See the header: this is one of three
    // things holding the lock, not the lock itself.
    this.input.tabIndex = -1;
    this.input.placeholder = 'Double click to write a note';

    const hint = document.createElement('span');
    hint.className = 'notes-hint';
    hint.textContent = 'ENTER SAVES  ·  ESC CANCELS';

    this.root.append(this.input, hint);
    this.wire();
  }

  private wire(): void {
    /*
     * Refuse focus while locked.
     *
     * preventDefault on mousedown stops the browser focusing the element and
     * starting a selection, and it does NOT cancel the click or dblclick that
     * follow, so the unlock gesture still works. This is what keeps a stray
     * click from parking the caret in a bar that looks inert.
     */
    this.root.addEventListener('mousedown', (e) => {
      if (!this.editing) e.preventDefault();
    });

    // Double click anywhere on the bar, not just on the text. At one line high
    // the input is a small target, and the bar is the thing you can see.
    this.root.addEventListener('dblclick', (e) => {
      e.preventDefault();
      void this.unlock();
    });

    this.input.addEventListener('blur', () => this.lock(true));

    this.input.addEventListener('keydown', (e) => {
      // Locked means locked. Without this the handler kept swallowing keys for
      // any focus that reached the input by another route.
      if (!this.editing) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        this.lock(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.lock(false);
      }
      // Every other key is the user typing. Stop it reaching the window's
      // global shortcuts, which include single letters and Escape.
      e.stopPropagation();
    });
  }

  private async unlock(): Promise<void> {
    if (this.editing || this.opening) return;
    // Guards the await below. Two double clicks in quick succession would
    // otherwise both pass the `editing` check and borrow focus twice.
    this.opening = true;
    try {
      const focused = await this.host.setEditing(true).catch(() => false);
      if (!focused) {
        // Better to do nothing visible than to open a field that silently sends
        // what the user types to another application.
        this.root.dataset.save = 'nofocus';
        console.warn('[notes] the wall could not take keyboard focus, not opening the edit');
        return;
      }
      this.editing = true;
      this.input.readOnly = false;
      this.input.tabIndex = 0;
      this.root.dataset.state = 'editing';
      delete this.root.dataset.save;
      this.input.focus();
      // Caret to the end rather than selecting everything: this is usually an
      // addition to an existing note, and select-all means one keystroke wipes it.
      const end = this.input.value.length;
      this.input.setSelectionRange(end, end);
    } finally {
      this.opening = false;
    }
  }

  /**
   * Lock, optionally saving.
   *
   * `blur()` is called explicitly rather than assumed, because Escape and Enter
   * lock while the field still holds focus, and a field that looks locked but
   * still has the caret is worse than either state. The `editing` guard makes
   * the blur that follows a no-op rather than a second pass.
   */
  private lock(save: boolean): void {
    if (!this.editing) return;
    this.editing = false;
    this.input.readOnly = true;
    this.input.tabIndex = -1;
    this.root.dataset.state = 'locked';
    if (document.activeElement === this.input) this.input.blur();
    // Hand keyboard focus back. Unconditional: the window must not stay
    // focusable because a save failed or the text was unchanged.
    void this.host.setEditing(false).catch(() => undefined);

    if (!save) {
      // Cancel means "show what is current", which is the pushed value if one
      // arrived while this edit was open, and otherwise what was here before.
      this.committed = this.incoming ?? this.committed;
      this.incoming = null;
      this.input.value = this.committed;
      return;
    }

    const next = capped(this.input.value).replace(/\s+$/, '');
    this.input.value = next;
    this.incoming = null;
    if (next === this.committed) return;

    this.committed = next;
    this.host.save(next).catch((err: unknown) => {
      // The bar already says locked, so silence here is a note that looks kept
      // and is not. Mark it, and let the styling say so.
      this.root.dataset.save = 'failed';
      console.error('[notes] could not save:', err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * Take the note from a state push.
   *
   * Held rather than applied while editing, on purpose. Saving triggers a state
   * push that comes straight back here, and on a second monitor there is a
   * second wall window doing the same thing. Applying an incoming value to a
   * field someone is typing in would overwrite them mid-word.
   */
  setText(text: string | null | undefined): void {
    const next = capped(text ?? '');
    if (this.editing) {
      this.incoming = next;
      return;
    }
    this.committed = next;
    this.incoming = null;
    if (this.input.value !== next) this.input.value = next;
  }

}
