/**
 * Who has the one toast window: a chat notice, a work notice, or the updater.
 *
 * Pure state, so the rules are tested without Electron (test/work.test.mjs):
 *   - A chat notice that is up is never cut off: a work notice waits for it.
 *   - A chat message that arrives while a work notice holds the window is
 *     deferred and counted per sender, and shown when the work notice ends.
 *   - The updater shows only when neither notice holds the window.
 *
 * src/main/index.ts owns the window and the timers; this only decides.
 */

export function createToastArbiter() {
  let chatUp = false;
  let workHeld = false;
  let workWaiting = false;
  const deferred = new Map<string, number>();

  return {
    /** A chat message arrived: show it now, or defer it (counted) while a work notice has the window. */
    chat(label: string): 'show' | 'defer' {
      if (workHeld) {
        deferred.set(label, (deferred.get(label) ?? 0) + 1);
        return 'defer';
      }
      chatUp = true;
      return 'show';
    },
    /** The chat notice's time is up. 'work' when a work notice was waiting for the window. */
    chatEnded(): 'work' | 'none' {
      chatUp = false;
      if (!workWaiting) return 'none';
      workWaiting = false;
      workHeld = true;
      return 'work';
    },
    /** A work notice wants the window: now, or after the chat notice that is up. */
    work(): 'now' | 'wait' {
      if (workHeld) return 'now';
      if (chatUp) {
        workWaiting = true;
        return 'wait';
      }
      workHeld = true;
      return 'now';
    },
    /** The work notice let go. Returns the chat messages it held back, per sender, in arrival order. */
    workReleased(): [string, number][] {
      workHeld = false;
      workWaiting = false;
      const out = [...deferred];
      deferred.clear();
      return out;
    },
    /** True while either notice has the window: the updater waits. */
    busy: (): boolean => chatUp || workHeld,
    workHeld: (): boolean => workHeld,
  };
}

export type ToastArbiter = ReturnType<typeof createToastArbiter>;
