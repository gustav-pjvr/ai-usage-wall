/**
 * The pairing window.
 *
 * The only focusable window this app has, and it exists for one reason: the
 * wall's own windows are created `focusable: false` so they can sit behind
 * everything without stealing focus, which makes a text input in them a trap.
 * Typing a code needs a real window.
 *
 * Two modes in one file, because they are two halves of one conversation:
 *   source  shows the code and counts it down, and lists paired screens
 *   screen  takes the code and reports exactly why it was refused
 */

declare global {
  interface Window {
    pair: {
      mode(): Promise<'source' | 'screen'>;
      status(): Promise<ProjectionStatus>;
      onStatus(cb: (s: ProjectionStatus) => void): void;
      newCode(): Promise<{ code: string; expiresAt: number } | null>;
      cancelCode(): Promise<void>;
      redeem(code: string): Promise<{ ok: boolean; message: string }>;
      revoke(screenId: string): Promise<void>;
      close(): Promise<void>;
      copy(text: string): Promise<void>;
    };
  }
}

type ProjectionStatus =
  | { role: 'off' }
  | {
      role: 'source';
      phase: string;
      screens: { screenId: string; label: string; online: boolean; confirmed: boolean }[];
      pairing: { code: string; expiresAt: number } | null;
    }
  | { role: 'screen'; phase: string; sourceLabel: string; ageMs: number | null };

const root = document.getElementById('pair') as HTMLElement;
let mode: 'source' | 'screen' = 'source';
let status: ProjectionStatus = { role: 'off' };

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

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function render(): void {
  root.replaceChildren();
  root.appendChild(el('h1', 'title', mode === 'source' ? 'Pair a screen' : 'Show another machine'));

  if (mode === 'source') renderSource();
  else renderScreen();
}

function renderSource(): void {
  const pairing = status.role === 'source' ? status.pairing : null;

  root.appendChild(
    el(
      'p',
      'lede',
      'Type this code into the other machine, in Projection, "Show another machine here". It works once and expires in ten minutes.',
    ),
  );

  if (pairing) {
    const code = el('div', 'code', pairing.code);
    code.tabIndex = 0;
    root.appendChild(code);

    const left = el('p', 'countdown', `expires in ${mmss(pairing.expiresAt - Date.now())}`);
    left.dataset.expires = String(pairing.expiresAt);
    root.appendChild(left);

    const row = el('div', 'row');
    const copy = el('button', 'btn', 'Copy code');
    copy.addEventListener('click', () => {
      void window.pair.copy(pairing.code);
      copy.textContent = 'Copied';
      window.setTimeout(() => (copy.textContent = 'Copy code'), 1500);
    });
    const fresh = el('button', 'btn btn-quiet', 'New code');
    fresh.addEventListener('click', () => void window.pair.newCode());
    row.append(copy, fresh);
    root.appendChild(row);
  } else {
    const make = el('button', 'btn', 'Show a pairing code');
    make.addEventListener('click', () => void window.pair.newCode());
    root.appendChild(make);
  }

  const screens = status.role === 'source' ? status.screens : [];
  root.appendChild(el('h2', 'sub', screens.length ? 'Paired screens' : 'No screens yet'));
  for (const sc of screens) {
    const row = el('div', 'screen-row');
    const name = el('div', 'screen-name', sc.label);
    const state = el(
      'div',
      `screen-state ${sc.online ? 'is-on' : ''}`,
      sc.confirmed ? (sc.online ? 'connected' : 'offline') : 'waiting for confirmation',
    );
    const remove = el('button', 'btn btn-quiet', 'Remove');
    remove.addEventListener('click', () => void window.pair.revoke(sc.screenId));
    row.append(name, state, remove);
    root.appendChild(row);
  }
}

function renderScreen(): void {
  if (status.role === 'screen') {
    root.appendChild(el('p', 'lede', `This machine is paired with ${status.sourceLabel || 'a source'}.`));
    root.appendChild(el('div', 'ok', status.phase === 'live' ? 'Live' : status.phase));
    const done = el('button', 'btn', 'Close');
    done.addEventListener('click', () => void window.pair.close());
    root.appendChild(done);
    return;
  }

  root.appendChild(
    el('p', 'lede', 'On the other machine choose Projection, then "Project this machine to another screen", and type its code here.'),
  );

  const input = el('input', 'code-input');
  input.type = 'text';
  input.placeholder = 'XXXX-XXXX-XXXX';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 20;
  root.appendChild(input);

  const msg = el('p', 'msg');
  root.appendChild(msg);

  const connect = el('button', 'btn', 'Connect');
  const submit = async () => {
    connect.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Checking...';
    const res = await window.pair.redeem(input.value);
    msg.className = `msg ${res.ok ? 'is-ok' : 'is-bad'}`;
    msg.textContent = res.message;
    connect.disabled = false;
    if (res.ok) input.value = '';
  };
  connect.addEventListener('click', () => void submit());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
  });
  root.appendChild(connect);

  requestAnimationFrame(() => input.focus());
}

// The countdown is the only thing that needs a clock, and once a second is the
// coarsest it can be while still counting seconds.
window.setInterval(() => {
  const node = root.querySelector<HTMLElement>('.countdown');
  if (!node?.dataset.expires) return;
  const left = Number(node.dataset.expires) - Date.now();
  if (left <= 0) {
    node.textContent = 'expired, show a new code';
    return;
  }
  node.textContent = `expires in ${mmss(left)}`;
}, 1000);

// Escape always closes. This window is modal-feeling and must never trap.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void window.pair.close();
});

window.pair.onStatus((s) => {
  status = s;
  render();
});

void (async () => {
  mode = await window.pair.mode();
  status = await window.pair.status();
  render();
})();

export {};
