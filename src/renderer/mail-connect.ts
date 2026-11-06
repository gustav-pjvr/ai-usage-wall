/**
 * The Connect mail dialog (full build only, docs/work-mode.md, "Mail setup").
 *
 * A normal, focusable window, like Connect monday, for the same reason: a
 * secret is not typed into a borrowed field on the desktop layer.
 *
 *   - Microsoft 365: one button. The sign-in happens in the system browser on
 *     Microsoft's own page; this window never sees a password or a token.
 *   - Gmail or GoDaddy: choose the account and paste the app password or the
 *     mailbox password. The field is read once, on Connect, and cleared at that
 *     moment whatever the outcome; main signs in with it for real before it is
 *     stored, and never sends it back.
 */

export {};

interface AccountState { id: string; label: string; preset: 'gmail' | 'godaddy' | 'm365'; connected: boolean; refused: boolean }

declare global {
  interface Window {
    mailConnect: {
      state(): Promise<AccountState[]>;
      submit(preset: string, password: string): Promise<{ ok: boolean; message: string }>;
      microsoft(): Promise<{ ok: boolean; message: string }>;
      cancel(): Promise<void>;
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

const IMAP = {
  gmail: {
    name: 'Gmail', address: 'gustavpjvr@gmail.com', field: 'App password',
    help: 'Use an app password, not your Google password: Google Account, Security, 2-Step Verification, App passwords. 2-Step Verification must be on.',
  },
  godaddy: {
    name: 'PicklePlay', address: 'gustav@pickleplaysouthafrica.org', field: 'Mailbox password',
    help: 'Use the password you sign in to GoDaddy webmail with for this mailbox.',
  },
} as const;
type ImapPreset = keyof typeof IMAP;

const title = el('h1', 'title', 'Connect mail');
title.id = 'connect-title';
const lede = el('p', 'lede', 'The inbox on the wall reads these accounts. Nothing is ever sent from the wall.');

// ── Microsoft 365 ───────────────────────────────────────────────────────────

const ms = el('section', 'mc-block');
ms.setAttribute('aria-labelledby', 'mc-ms');
const msHead = el('div', 'mc-head');
const msTitle = el('h2', 'mc-title', 'MuchBetter, Microsoft 365');
msTitle.id = 'mc-ms';
const msState = el('span', 'mc-state');
msHead.append(msTitle, msState);
const msText = el('p', 'note', 'gustav@muchbetter.world. Signs in with Microsoft in your browser; the wall never sees the password.');
const msActs = el('div', 'actions');
const msGo = el('button', 'btn btn-pri', 'Sign in with Microsoft');
msGo.type = 'button';
const msCancel = el('button', 'btn', 'Cancel sign-in');
msCancel.type = 'button';
msCancel.hidden = true;
msActs.append(msGo, msCancel);
ms.append(msHead, msText, msActs);

// ── Gmail or GoDaddy ────────────────────────────────────────────────────────

const form = el('form', 'connect-form mc-block');
form.setAttribute('aria-labelledby', 'mc-imap');
const imapHead = el('div', 'mc-head');
const imapTitle = el('h2', 'mc-title', 'Gmail or PicklePlay');
imapTitle.id = 'mc-imap';
const imapState = el('span', 'mc-state');
imapHead.append(imapTitle, imapState);

const choice = el('div', 'mc-choice');
choice.setAttribute('role', 'radiogroup');
choice.setAttribute('aria-label', 'Which account');
let preset: ImapPreset = 'gmail';
const radios = new Map<ImapPreset, HTMLInputElement>();
for (const p of Object.keys(IMAP) as ImapPreset[]) {
  const lab = el('label', 'mc-radio');
  const r = el('input');
  r.type = 'radio';
  r.name = 'preset';
  r.value = p;
  r.checked = p === preset;
  r.addEventListener('change', () => {
    if (r.checked) choose(p);
  });
  radios.set(p, r);
  const words = el('span', 'mc-radio-l');
  words.append(el('b', undefined, IMAP[p].name), el('span', 'mc-addr', IMAP[p].address));
  lab.append(r, words);
  choice.append(lab);
}

const help = el('p', 'note mc-help');
const label = el('label', 'sub');
label.htmlFor = 'password';
const input = el('input', 'token');
input.id = 'password';
input.type = 'password';
input.autocomplete = 'off';
input.spellcheck = false;
input.maxLength = 8192;
input.setAttribute('aria-describedby', 'mc-note');
const note = el('p', 'note', 'Checked with a real sign-in before it is stored, encrypted with Windows data protection. Never shown again, never projected.');
note.id = 'mc-note';
const imapActs = el('div', 'actions');
const connect = el('button', 'btn btn-pri', 'Connect');
connect.type = 'submit';
imapActs.append(connect);
form.append(imapHead, choice, help, label, input, note, imapActs);

const status = el('p', 'status');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
const foot = el('div', 'actions');
const close = el('button', 'btn', 'Close');
close.type = 'button';
foot.append(close);

const wrap = el('div', 'connect-form');
wrap.setAttribute('aria-labelledby', 'connect-title');
wrap.append(title, lede, ms, form, status, foot);
root.append(wrap);

function choose(p: ImapPreset): void {
  preset = p;
  help.textContent = IMAP[p].help;
  label.textContent = IMAP[p].field;
  input.placeholder = `Paste the ${IMAP[p].field.toLowerCase()}`;
  void paintState();
}

let accounts: AccountState[] = [];
const stateWord = (a: AccountState | undefined): string => (!a?.connected ? 'Not connected' : a.refused ? 'Sign-in refused' : 'Connected');

async function paintState(): Promise<void> {
  try {
    accounts = await window.mailConnect.state();
  } catch {
    accounts = [];
  }
  const m = accounts.find((a) => a.preset === 'm365');
  msState.textContent = stateWord(m);
  msState.className = `mc-state${m?.connected && !m.refused ? ' is-ok' : m?.refused ? ' is-bad' : ''}`;
  const i = accounts.find((a) => a.preset === preset);
  imapState.textContent = `${IMAP[preset].name}: ${stateWord(i)}`;
  imapState.className = `mc-state${i?.connected && !i.refused ? ' is-ok' : i?.refused ? ' is-bad' : ''}`;
}

// ── Busy states ─────────────────────────────────────────────────────────────

let busy: 'ms' | 'imap' | null = null;

function setBusy(on: 'ms' | 'imap' | null): void {
  busy = on;
  wrap.setAttribute('aria-busy', String(!!on));
  for (const c of [msGo, connect, input, close, ...radios.values()]) c.disabled = !!on;
  msCancel.hidden = on !== 'ms';
  msGo.textContent = on === 'ms' ? 'Waiting for the browser sign-in...' : 'Sign in with Microsoft';
  connect.textContent = on === 'imap' ? `Signing in to ${IMAP[preset].name}...` : 'Connect';
}

function say(text: string, tone: '' | 'ok' | 'bad'): void {
  status.className = `status${tone ? ` is-${tone}` : ''}`;
  status.textContent = text;
}

msGo.addEventListener('click', () => {
  if (busy) return;
  say('A Microsoft sign-in page opened in your browser. Finish it there; this waits up to 3 minutes.', '');
  setBusy('ms');
  void window.mailConnect.microsoft()
    .catch(() => ({ ok: false, message: 'The wall could not start the sign-in.' }))
    .then((r) => {
      setBusy(null);
      say(r.ok ? `${r.message} The inbox loads on the wall now.` : r.message, r.ok ? 'ok' : 'bad');
      void paintState();
    });
});

msCancel.addEventListener('click', () => void window.mailConnect.cancel());

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  const password = input.value;
  // Cleared now, whatever happens next: the page never holds on to it.
  input.value = '';
  if (!password.trim()) {
    say('Paste the password first.', 'bad');
    input.focus();
    return;
  }
  say('', '');
  setBusy('imap');
  void window.mailConnect.submit(preset, password)
    .catch(() => ({ ok: false, message: 'The wall could not check the password.' }))
    .then((r) => {
      setBusy(null);
      say(r.ok ? `${r.message} The inbox loads on the wall now.` : r.message, r.ok ? 'ok' : 'bad');
      void paintState();
      if (!r.ok) input.focus();
    });
});

close.addEventListener('click', () => void window.mailConnect.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !busy) void window.mailConnect.close();
});

choose('gmail');
setBusy(null);
