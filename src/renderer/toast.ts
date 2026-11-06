/**
 * The update notification that floats above other applications.
 *
 * It exists because the previous design announced a staged update only inside a
 * tray menu, which meant nobody found out. This window is deliberately small,
 * cannot be focused, and takes no clicks: the thing you act on is the Install
 * button on the wall itself. Its whole job is to say that a download is
 * happening and then get out of the way.
 */

interface UpdateStateLike {
  phase: string;
  version?: string;
  percent?: number;
}

interface NoticeLike {
  from: string;
  count: number;
}

/** A work notice (full build): words only. Main keeps the task it is about. */
interface WorkNoticeLike {
  id: number;
  label: string;
  from: string;
  title: string;
  count: number;
  canDone: boolean;
}

declare global {
  interface Window {
    updateToast: {
      onUpdate(cb: (s: UpdateStateLike) => void): void;
      onNotice(cb: (n: NoticeLike) => void): void;
      /** Full build only. */
      onWork?(cb: (n: WorkNoticeLike) => void): void;
      onWorkEnd?(cb: () => void): void;
      workAction?(id: number, action: 'show' | 'done' | 'later'): Promise<{ ok: boolean; message: string }>;
    };
  }
}

const toast = document.getElementById('toast') as HTMLElement;
const title = document.getElementById('title') as HTMLElement;
const sub = document.getElementById('sub') as HTMLElement;
const fill = document.getElementById('fill') as HTMLElement;

/*
 * A message arrived.
 *
 * Deliberately says who and how many, never what. This panel floats above other
 * applications, so anyone glancing at the screen can read it, and the whole
 * point of the channel underneath is that the words are not for them. The main
 * process hands the window back to the updater after two seconds.
 */
window.updateToast.onNotice((n) => {
  toast.hidden = false;
  toast.dataset.phase = 'notice';
  title.textContent = n.count > 1 ? `${n.count} new messages` : 'New message';
  sub.textContent = n.from ? `from ${n.from}` : 'open Messages in the tray';
});

window.updateToast.onUpdate((s) => {
  if (s.phase === 'downloading') {
    toast.hidden = false;
    toast.dataset.phase = 'downloading';
    title.textContent = s.version ? `Downloading update ${s.version}` : 'Downloading update';
    const pct = Math.max(0, Math.min(100, Math.round(s.percent ?? 0)));
    fill.style.width = `${pct}%`;
    sub.textContent = pct > 0 ? `${pct}%` : 'starting';
    return;
  }
  if (s.phase === 'ready') {
    toast.hidden = false;
    toast.dataset.phase = 'ready';
    title.textContent = `Update ${s.version ?? ''} ready`.trim();
    sub.textContent = 'click Install update on the wall';
    return;
  }
  toast.hidden = true;
});

/*
 * Work notices (full build only, docs/work-mode.md): the one toast that takes
 * clicks. Main makes the window larger and clickable for it and gives it back
 * afterwards. Sender and task name only, set with textContent; Done shows a
 * pending state and then what monday said.
 */
// The build define itself, so the stats bundle drops this block (see main.ts).
if (process.env.MBW_EDITION !== 'stats' && window.updateToast.onWork && window.updateToast.workAction) {
  const act = window.updateToast.workAction;
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] => {
    const n = document.createElement(tag);
    n.className = cls;
    n.textContent = text;
    return n;
  };
  const box = mk('div', 'work');
  box.hidden = true;
  box.setAttribute('role', 'alert');
  const k = mk('div', 'work-k');
  const label = mk('span', 'work-label');
  k.append(mk('span', 'work-dot'), label);
  const from = mk('div', 'work-from');
  const title = mk('div', 'work-title');
  const acts = mk('div', 'work-acts');
  const show = mk('button', 'work-btn work-btn-pri', 'Show');
  const done = mk('button', 'work-btn', 'Done');
  const later = mk('button', 'work-btn', 'Later');
  const msg = mk('span', 'work-msg');
  msg.setAttribute('role', 'status');
  msg.setAttribute('aria-live', 'polite');
  for (const b of [show, done, later]) b.type = 'button';
  acts.append(show, done, later, msg);
  box.append(k, from, title, acts);
  document.body.append(box);

  let current: WorkNoticeLike | null = null;
  const setBusy = (on: boolean): void => {
    box.setAttribute('aria-busy', String(on));
    for (const b of [show, done, later]) b.disabled = on;
  };

  window.updateToast.onWork((n) => {
    current = n;
    toast.hidden = true;
    box.hidden = false;
    label.textContent = n.label;
    from.textContent = n.from;
    title.textContent = n.title;
    done.hidden = !n.canDone;
    done.textContent = 'Done';
    msg.textContent = '';
    msg.className = 'work-msg';
    setBusy(false);
  });
  window.updateToast.onWorkEnd?.(() => {
    current = null;
    box.hidden = true;
  });

  const send = (action: 'show' | 'done' | 'later'): void => {
    const n = current;
    if (!n) return;
    if (action !== 'done') {
      void act(n.id, action).catch(() => undefined);
      return;
    }
    setBusy(true);
    done.textContent = 'Marking done...';
    void act(n.id, 'done')
      .catch(() => ({ ok: false, message: 'The wall could not send that.' }))
      .then((r) => {
        if (current !== n) return;
        setBusy(false);
        done.hidden = r.ok;
        done.textContent = 'Done';
        msg.className = `work-msg ${r.ok ? 'is-ok' : 'is-bad'}`;
        msg.textContent = r.ok ? 'Marked done on monday' : r.message;
      });
  };
  show.addEventListener('click', () => send('show'));
  done.addEventListener('click', () => send('done'));
  later.addEventListener('click', () => send('later'));
}

export {};
