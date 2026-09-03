/**
 * Projection: the role switch, the consent gate, and the only place the network
 * objects are ever constructed.
 *
 * Nothing else in the app imports relay-socket, source or screen. That is what
 * makes rule 25 checkable: when there is no projection.json, `current` stays
 * null, no socket class is instantiated, and the app makes no requests at all.
 */

import { dialog } from 'electron';
import { PRODUCT_NAME } from '../../shared/edition';
import { normaliseCode } from '../../shared/pairing-code';
import { deriveScreenKey, lookupFromStretched, newKeyPair, newSecret, newSpaceId, stretchCode } from './crypto';
import { ScreenReceiver, type ScreenStatus } from './screen';
import { SourceProjector, type SourceStatus } from './source';
import {
  clearProjection,
  loadProjection,
  saveProjection,
  type ProjectionState,
  type ScreenState,
  type SourceState,
} from './store';

export const DEFAULT_RELAY = 'https://claude-stats-relay.gustavpjvr.workers.dev';

export type ProjectionStatus =
  | { role: 'off' }
  | SourceStatus
  | ScreenStatus;

type Notice = (title: string, body: string) => void;

let source: SourceProjector | null = null;
let screen: ScreenReceiver | null = null;
let status: ProjectionStatus = { role: 'off' };
let emit: (s: ProjectionStatus) => void = () => {};
let notice: Notice = () => {};
let onProjectedUsage: (usage: Record<string, unknown>) => void = () => {};

export const projectionStatus = (): ProjectionStatus => status;
export const isScreen = (): boolean => screen !== null;
export const projectedUsage = (): Record<string, unknown> | null => screen?.currentUsage() ?? null;

function setStatus(s: ProjectionStatus): void {
  status = s;
  try {
    emit(s);
  } catch {
    /* never let a listener break projection */
  }
}

/**
 * Boot. Does nothing at all when there is no projection.json, which is the
 * default and the state the app ships in.
 */
export async function startProjection(opts: {
  onStatus: (s: ProjectionStatus) => void;
  onUsage: (usage: Record<string, unknown>) => void;
  notify: Notice;
}): Promise<void> {
  emit = opts.onStatus;
  notice = opts.notify;
  onProjectedUsage = opts.onUsage;

  const state = await loadProjection();
  if (!state) {
    console.log('[projection] off');
    setStatus({ role: 'off' });
    return;
  }
  await activate(state);
}

async function activate(state: ProjectionState): Promise<void> {
  stopAll();
  if (state.role === 'source') {
    source = new SourceProjector(state, setStatus, notice);
    source.start();
    console.log(`[projection] source, ${state.screens.length} screen(s) paired`);
  } else {
    screen = new ScreenReceiver(state, onProjectedUsage, setStatus, notice);
    await screen.start();
    console.log(`[projection] screen, showing ${state.sourceLabel || 'a paired source'}`);
  }
  setStatus(source ? source.status() : screen!.status());
}

function stopAll(): void {
  source?.stop();
  screen?.stop();
  source = null;
  screen = null;
}

export function stopProjection(): void {
  stopAll();
  setStatus({ role: 'off' });
}

/**
 * The consent gate.
 *
 * Shown once, before the first byte can ever leave. It names the exact host, it
 * says what is sent and what is not, and it says that nothing goes anywhere
 * until a screen is paired, which is literally true: without a paired screen
 * there is no key to encrypt for.
 */
function consent(role: 'source' | 'screen'): boolean {
  const detail =
    role === 'source'
      ? `${PRODUCT_NAME} will connect to the relay and send this machine's dashboard, encrypted, to screens you pair with a code.\n\n` +
        'Sent: token totals, daily and hourly activity, model names, session times, project folder names, Claude Code version.\n\n' +
        'Never sent: file paths, your Windows username, prompts, or any transcript text.\n\n' +
        'The relay forwards ciphertext it cannot read and stores nothing. Nothing is sent until you pair a screen, and you can stop from the tray at any time.'
      : `${PRODUCT_NAME} will connect to the relay and display a paired machine's dashboard.\n\n` +
        'While this machine is a screen it does not read its own Claude Code transcripts.\n\n' +
        'You can unpair from the tray at any time.';

  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Turn on', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Turn on projection?',
    message: role === 'source' ? 'Send this machine’s stats to another screen?' : 'Show another machine’s stats here?',
    detail,
  });
  return choice === 0;
}

/** Become a source. Generates a space and a secret; sends nothing yet. */
export async function enableSource(label: string): Promise<boolean> {
  if (!consent('source')) return false;
  const state: SourceState = {
    role: 'source',
    relayUrl: DEFAULT_RELAY,
    spaceId: newSpaceId(),
    sourceSecret: newSecret(),
    screens: [],
    pendingRevocations: [],
    label: label.slice(0, 40),
    shareProjectNames: true,
  };
  await saveProjection(state);
  await activate(state);
  return true;
}

/** Ask the user's consent to become a screen. Nothing is written until pairing. */
export function enableScreen(): boolean {
  return consent('screen');
}

export function beginPairing(): { code: string; expiresAt: number } | null {
  return source ? source.beginPairing() : null;
}

export function cancelPairing(): void {
  source?.cancelPairing();
}

export async function revokeScreen(screenId: string): Promise<void> {
  await source?.revoke(screenId);
}

export async function setShareProjectNames(share: boolean): Promise<void> {
  if (!source) return;
  const next = { ...source.current(), shareProjectNames: share };
  await saveProjection(next);
  source.update(next);
}

/**
 * Redeem a pairing code on the SCREEN.
 *
 * The only HTTP request in the whole feature. Everything after this is the
 * WebSocket. Returns a message suitable for showing verbatim in the pair
 * window, because the failure reasons are exactly what the user needs.
 */
export async function redeemCode(raw: string): Promise<{ ok: boolean; message: string }> {
  const code = normaliseCode(raw);
  if (!code) return { ok: false, message: 'That does not look like a pairing code. It is 12 characters.' };

  /*
   * scrypt runs HERE, once, and both the lookup sent to the relay and the key
   * derived below come from it. It blocks the main process for about 100 ms in
   * response to the user pressing Pair, which is acceptable, and it is not run
   * a second time inside deriveScreenKey.
   */
  const stretched = stretchCode(code);
  const lookup = lookupFromStretched(stretched);
  const keyPair = newKeyPair();

  let res: Response;
  try {
    res = await fetch(`${DEFAULT_RELAY}/v1/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lookup, pub: keyPair.publicKey }),
    });
  } catch (err) {
    return { ok: false, message: `Could not reach the relay: ${(err as Error).message}` };
  }

  if (res.status === 404) return { ok: false, message: 'No pairing is waiting for that code. Check it, or ask for a new one.' };
  if (res.status === 410) return { ok: false, message: 'That code has expired. Ask the source for a new one.' };
  if (res.status === 429) return { ok: false, message: 'Too many attempts. Wait a minute and try again.' };
  if (!res.ok) return { ok: false, message: `The relay refused the code (${res.status}).` };

  const body = (await res.json()) as { spaceId?: string; screenId?: string; token?: string; sourcePub?: string };
  if (!body.spaceId || !body.screenId || !body.token || !body.sourcePub) {
    return { ok: false, message: 'The relay sent an incomplete reply.' };
  }

  let key: Buffer;
  try {
    key = deriveScreenKey(keyPair.privateKey, body.sourcePub, stretched, lookup);
  } catch (err) {
    return { ok: false, message: `Could not complete the key exchange: ${(err as Error).message}` };
  }

  const state: ScreenState = {
    role: 'screen',
    relayUrl: DEFAULT_RELAY,
    spaceId: body.spaceId,
    screenId: body.screenId,
    screenToken: body.token,
    key: key.toString('base64'),
    sourceLabel: '',
    pairedAt: new Date().toISOString(),
  };
  await saveProjection(state);
  await activate(state);

  /*
   * Deliberately not "paired". Redeeming proves the relay accepted the code; it
   * does NOT prove this machine derived the right key. That is only known when
   * the source's first encrypted hello opens, which happens moments later.
   */
  return { ok: true, message: 'Code accepted. Waiting for the source to confirm...' };
}

export async function unpairScreen(): Promise<void> {
  await screen?.unpair();
  stopAll();
  setStatus({ role: 'off' });
}

/** Turn everything off. `forget` also tears the space down at the relay. */
export async function disableProjection(forget: boolean): Promise<void> {
  if (forget && source) source.destroy();
  if (screen) await screen.unpair();
  stopAll();
  await clearProjection();
  setStatus({ role: 'off' });
  console.log('[projection] off');
}

/** Called from pushUsage. Returns instantly when there is no source. */
export function offerUsage(index: unknown, indexing: boolean): void {
  source?.offer(index, indexing);
}

/** Whether the source is currently willing to send project folder names. */
export function shareProjectNames(): boolean {
  return source?.current().shareProjectNames ?? true;
}

export function relayHost(): string {
  try {
    return new URL(DEFAULT_RELAY).host;
  } catch {
    return DEFAULT_RELAY;
  }
}

/** The tray's one-line summary, honest in every state. */
export function projectionLabel(): string {
  const s = status;
  if (s.role === 'off') return 'Off (no network)';
  if (s.role === 'source') {
    if (s.phase !== 'open') return `Projecting: relay unreachable, retrying in ${s.retryIn ?? 0}s`;
    const online = s.screens.filter((x) => x.online).length;
    if (!s.screens.length) return 'Projecting: no screens paired yet';
    return `Projecting to ${online} of ${s.screens.length} screen${s.screens.length === 1 ? '' : 's'}`;
  }
  switch (s.phase) {
    case 'live':
      return `Showing ${s.sourceLabel} (live)`;
    case 'link-lost':
      return `Showing ${s.sourceLabel} (link lost)`;
    case 'offline':
      return `${s.sourceLabel} is offline`;
    case 'relay-unreachable':
      return 'Relay unreachable, retrying';
    case 'revoked':
      return 'Removed by the source';
    case 'space-closed':
      return 'The source stopped projecting';
    case 'key-mismatch':
      return 'Cannot decrypt: pair again';
    default:
      return 'Connecting...';
  }
}
