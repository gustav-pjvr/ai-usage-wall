/**
 * The Connect monday dialog (full build only, docs/work-mode.md).
 *
 * A normal, focusable window, for the same reason the pairing window is one:
 * the wall cannot take a keystroke without borrowing focus, and a secret is
 * not something to type into a borrowed field on the desktop layer.
 *
 * The token is read from the field once, on Connect, and the field is cleared
 * at that moment whatever the outcome: it is never kept in this page, never
 * shown again, and main never sends it back. Main checks it with monday (it
 * must be Gustav's own) before it stores it with Windows' encryption.
 */

export {};

declare global {
  interface Window {
    mondayConnect: {
      submit(token: string): Promise<{ ok: boolean; message: string }>;
      close(): Promise<void>;
    };
  }
}

const root = document.getElementById('connect') as HTMLElement;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const form = el('form', 'connect-form');
form.setAttribute('aria-labelledby', 'connect-title');
const title = el('h1', 'title', 'Connect monday');
title.id = 'connect-title';
const lede = el('p', 'lede', 'Work mode reads and updates the Tasks board with your own monday personal API token.');

const steps = el('ol', 'steps');
for (const s of [
  'In monday, click your avatar, then Developers.',
  'Open My access tokens and copy your personal token.',
  'Paste it below and click Connect.',
]) steps.append(el('li', undefined, s));

const label = el('label', 'sub', 'Personal API token');
label.htmlFor = 'token';
const input = el('input', 'token');
input.id = 'token';
input.type = 'password';
input.autocomplete = 'off';
input.spellcheck = false;
input.maxLength = 8192;
input.placeholder = 'Paste the token';
input.setAttribute('aria-describedby', 'connect-note');

const note = el('p', 'note', 'Stored encrypted on this PC with Windows data protection. Never shown again, never projected. Disconnect monday in the tray deletes it.');
note.id = 'connect-note';

const status = el('p', 'status');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');

const actions = el('div', 'actions');
const connect = el('button', 'btn btn-pri', 'Connect');
connect.type = 'submit';
const cancel = el('button', 'btn', 'Cancel');
cancel.type = 'button';
actions.append(connect, cancel);

form.append(title, lede, steps, label, input, note, status, actions);
root.append(form);

let busy = false;

function setBusy(on: boolean): void {
  busy = on;
  form.setAttribute('aria-busy', String(on));
  connect.disabled = on;
  cancel.disabled = on;
  input.disabled = on;
  connect.textContent = on ? 'Checking with monday...' : 'Connect';
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  const token = input.value.trim();
  // Cleared now, whatever happens next: the page never holds on to it.
  input.value = '';
  if (!token) {
    status.className = 'status is-bad';
    status.textContent = 'Paste the token first.';
    input.focus();
    return;
  }
  status.className = 'status';
  status.textContent = '';
  setBusy(true);
  void window.mondayConnect
    .submit(token)
    .catch(() => ({ ok: false, message: 'The wall could not check the token.' }))
    .then((r) => {
      setBusy(false);
      status.className = `status ${r.ok ? 'is-ok' : 'is-bad'}`;
      status.textContent = r.ok ? 'Connected. The Tasks board loads on the wall now.' : r.message;
      if (r.ok) {
        connect.hidden = true;
        cancel.textContent = 'Close';
        cancel.focus();
        window.setTimeout(() => void window.mondayConnect.close(), 1500);
      } else {
        input.focus();
      }
    });
});

cancel.addEventListener('click', () => void window.mondayConnect.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !busy) void window.mondayConnect.close();
});

input.focus();
