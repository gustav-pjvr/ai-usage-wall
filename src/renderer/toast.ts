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

declare global {
  interface Window {
    updateToast: {
      onUpdate(cb: (s: UpdateStateLike) => void): void;
      onNotice(cb: (n: NoticeLike) => void): void;
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

export {};
