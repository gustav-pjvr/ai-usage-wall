/**
 * Work mode's inbox: every connected account in one place, in the main
 * process (docs/work-mode.md, "Mail").
 *
 *   - Accounts are the three Gustav decided on (src/shared/mail-view.ts):
 *     Gmail and GoDaddy over IMAP (imap.ts), Microsoft 365 over Graph
 *     (graph.ts). Each runs on its own; one failing never stops the others.
 *   - The renderer gets MailPayload: account views and rows. Never a password,
 *     a token, a raw header, an HTML body or a server's own words.
 *   - Every action answers with the server's read-back or a plain failure.
 *   - A refused sign-in stops that account until it is reconnected (no retry
 *     loop against a wrong password).
 *   - A paired projection screen does not sync mail at all.
 */

import {
  MAIL_ACCOUNTS, MAIL_ROWS, accountInfo,
  type MailAccountStatus, type MailAccountView, type MailActionKind, type MailActionResult, type MailBody, type MailEvent,
  type MailOpenResult, type MailPayload, type MailPresetId, type MailRow,
} from '../../shared/mail-view';
import { MailError, type MailAccount, type MailCredential, type MailErrorKind, type MailPreset } from './mail-accounts';

/** What every provider can do. imap.ts and graph.ts both return this shape. */
export interface MailProvider {
  start(receive: (snapshot: { account: MailAccountView; rows: MailRow[] }, events: MailEvent[]) => void, failed?: (error: MailError) => void): void;
  stop(): void;
  sync(): Promise<{ account: MailAccountView; rows: MailRow[] }>;
  markRead(handle: string): Promise<MailRow>;
  markUnread(handle: string): Promise<MailRow>;
  flag(handle: string): Promise<MailRow>;
  unflag(handle: string): Promise<MailRow>;
  archive(handle: string): Promise<{ undo: string }>;
  trash(handle: string): Promise<{ undo: string }>;
  undo(token: string): Promise<{ handle: string }>;
  open(handle: string): Promise<MailBody>;
  webUrl(handle: string): string;
}

/** The stored IMAP accounts (createMailAccountStore in mail-accounts.ts). */
export interface ImapStore {
  save(input: { id: string; preset: MailPreset; label: string; colour: string; user: string }, password: string): Promise<MailAccount>;
  load(id: string): Promise<{ account: MailAccount; credential: MailCredential } | null>;
  remove(id: string): Promise<void>;
}

/** The stored Microsoft 365 account (createGraphAccount in graph.ts), with the session kept opaque. */
export interface GraphStore<S> {
  load(): Promise<S | null>;
  signIn(): Promise<S>;
  cancel(): void;
  remove(): Promise<void>;
}

/** Plain words for every failure kind. Never server text. */
export const MAIL_PROBLEM: Record<MailErrorKind, string> = {
  auth: 'The mail server refused the sign-in. Use Reconnect in the tray.',
  offline: 'Could not reach the mail server. Check the connection and try again.',
  tls: "The mail server's certificate did not check out, so the wall did not connect.",
  rate: 'The mail server is rate limiting the wall. Try again in a minute.',
  server: 'The mail server had a problem. Try again shortly.',
  invalid: 'That message has changed or gone. The inbox is refreshing.',
  storage: 'The password could not be stored securely on this PC, so it was not saved.',
  mismatch: 'The server did not confirm the change. It may not have been made.',
  unsupported: 'This mail server cannot move messages safely, so the wall did not try.',
};

const kindOf = (error: unknown): MailErrorKind => (error instanceof MailError ? error.kind : 'server');
export const mailProblem = (error: unknown): string => MAIL_PROBLEM[kindOf(error)];

const STATUS: Record<MailErrorKind, MailAccountStatus> = {
  auth: 'auth', tls: 'tls', offline: 'offline', rate: 'rate',
  server: 'error', invalid: 'error', storage: 'error', mismatch: 'error', unsupported: 'error',
};

/** Only these hosts are ever opened for "Open in Outlook / Gmail / webmail". */
const WEB_MAIL = /^https:\/\/(?:mail\.google\.com|email\.godaddy\.com|outlook\.office\.com|outlook\.office365\.com)\/[\x21-\x7e]{0,4000}$/;
export const isWebMailUrl = (url: unknown): url is string => typeof url === 'string' && WEB_MAIL.test(url);

interface Slot {
  id: string;
  provider: MailProvider | null;
  view: MailAccountView;
  rows: MailRow[];
}

export function createMailCenter<S>(deps: {
  now: () => number;
  imap: ImapStore;
  graph: GraphStore<S>;
  makeImap: (account: MailAccount, credential: MailCredential) => MailProvider;
  makeGraph: (session: S) => MailProvider;
  onChange: (payload: MailPayload) => void;
  onEvents: (events: MailEvent[]) => void;
  paused?: () => boolean;
  log?: (line: string) => void;
}) {
  const log = deps.log ?? (() => undefined);
  const paused = deps.paused ?? (() => false);
  const slots = new Map<string, Slot>();
  /** handle -> account id, for every row shown and every message an undo brought back. */
  const owner = new Map<string, string>();
  const undoOwner = new Map<string, string>();
  let known = false;
  let stopped = false;
  /**
   * Bumped by every start() and suspend(). A start that finds it changed after
   * an await (a second start, or the machine became a screen meanwhile) starts
   * nothing more.
   */
  let generation = 0;

  const emptyView = (id: string, status: MailAccountStatus): MailAccountView => {
    const info = accountInfo(id)!;
    return { id, label: info.label, colour: info.colour, unread: 0, status, syncedAt: null, provider: info.preset === 'm365' ? 'graph' : 'imap' };
  };

  function payload(): MailPayload {
    const accounts: MailAccountView[] = [];
    const rows: MailRow[] = [];
    // The order Gustav's accounts are listed in, whatever order they connected in.
    for (const info of MAIL_ACCOUNTS) {
      const slot = slots.get(info.id);
      if (!slot) continue;
      accounts.push({ ...slot.view });
      rows.push(...slot.rows.slice(0, MAIL_ROWS).map((r) => ({ ...r })));
    }
    rows.sort((a, b) => b.date.localeCompare(a.date));
    return { known, accounts, rows };
  }

  const emit = (): void => {
    if (!stopped) deps.onChange(payload());
  };

  function remember(slot: Slot): void {
    for (const [h, id] of owner) if (id === slot.id) owner.delete(h);
    for (const r of slot.rows) owner.set(r.handle, slot.id);
  }

  function run(slot: Slot, provider: MailProvider): void {
    // Never two providers for one account: the one being replaced stops first.
    if (slot.provider && slot.provider !== provider) slot.provider.stop();
    slot.provider = provider;
    slot.view = { ...slot.view, status: 'syncing' };
    provider.start((snapshot, events) => {
      if (slots.get(slot.id) !== slot || slot.provider !== provider) return;
      slot.view = { ...snapshot.account, label: slot.view.label, colour: slot.view.colour, status: 'ready' };
      slot.rows = snapshot.rows.filter((r) => r.account === slot.id).slice(0, MAIL_ROWS);
      remember(slot);
      emit();
      // Counts only in the log: never an address, a subject or a server word.
      log(`[mail] ${slot.id} synced: ${slot.rows.length} rows, ${events.length} new`);
      if (events.length && !paused()) deps.onEvents(events.filter((e) => e.account === slot.id));
    }, (error) => {
      if (slots.get(slot.id) !== slot || slot.provider !== provider) return;
      const kind = kindOf(error);
      slot.view = { ...slot.view, status: STATUS[kind] };
      if (kind === 'auth') {
        // A refused password or token is not retried: Reconnect replaces it.
        provider.stop();
        slot.provider = null;
      }
      emit();
      log(`[mail] ${slot.id} sync failed: ${kind}${kind === 'auth' ? ', stopped until reconnected' : ''}`);
    });
  }

  function slotFor(id: string): Slot {
    let slot = slots.get(id);
    if (!slot) {
      slot = { id, provider: null, view: emptyView(id, 'syncing'), rows: [] };
      slots.set(id, slot);
    }
    return slot;
  }

  function drop(id: string): void {
    const slot = slots.get(id);
    if (!slot) return;
    slot.provider?.stop();
    slots.delete(id);
    for (const [h, owned] of owner) if (owned === id) owner.delete(h);
    for (const [t, owned] of undoOwner) if (owned === id) undoOwner.delete(t);
  }

  async function startImap(id: string, gen: number): Promise<void> {
    let saved: Awaited<ReturnType<ImapStore['load']>> = null;
    try {
      saved = await deps.imap.load(id);
    } catch {
      if (gen !== generation) return;
      slotFor(id).view = emptyView(id, 'error');
      log(`[mail] ${id}: the stored password could not be read; connect it again`);
      return;
    }
    if (!saved || gen !== generation) return;
    run(slotFor(id), deps.makeImap(saved.account, saved.credential));
  }

  async function startGraph(id: string, gen: number): Promise<void> {
    let session: S | null = null;
    try {
      session = await deps.graph.load();
    } catch {
      if (gen !== generation) return;
      slotFor(id).view = emptyView(id, 'error');
      log(`[mail] ${id}: the stored Microsoft sign-in could not be read; connect it again`);
      return;
    }
    if (!session) return;
    if (gen !== generation) {
      // Loaded for a start that no longer counts: close it rather than leave it open.
      (session as { close?: () => void }).close?.();
      return;
    }
    run(slotFor(id), deps.makeGraph(session));
  }

  function find(handle: unknown): { slot: Slot; provider: MailProvider; handle: string } {
    if (typeof handle !== 'string' || handle.length > 256 || !/^[A-Za-z0-9_-]+$/.test(handle)) throw new MailError('invalid');
    const id = owner.get(handle);
    const slot = id ? slots.get(id) : undefined;
    if (!slot?.provider) throw new MailError(slot ? 'auth' : 'invalid');
    return { slot, provider: slot.provider, handle };
  }

  /** Put a read-back row in place. The unread count follows the row now; the next sync has the server's own. */
  function replaceRow(slot: Slot, row: MailRow): MailRow {
    const i = slot.rows.findIndex((r) => r.handle === row.handle);
    if (i < 0) return { ...row };
    const before = slot.rows[i];
    const next = { ...row, snippet: row.snippet || before.snippet, bulk: before.bulk };
    slot.rows[i] = next;
    if (before.seen !== next.seen) slot.view = { ...slot.view, unread: Math.max(0, slot.view.unread + (next.seen ? -1 : 1)) };
    return { ...next };
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      const gen = ++generation;
      if (paused()) {
        known = true;
        emit();
        return;
      }
      for (const info of MAIL_ACCOUNTS) {
        if (gen !== generation) return;
        if (info.preset === 'm365') await startGraph(info.id, gen);
        else await startImap(info.id, gen);
      }
      if (gen !== generation) return;
      known = true;
      emit();
    },

    stop(): void {
      stopped = true;
      for (const slot of slots.values()) slot.provider?.stop();
    },

    /**
     * The machine became a paired projection screen: every account stops and
     * nothing about the inbox is kept in memory. start() again when it stops
     * being one (the stored accounts are read afresh).
     */
    suspend(): void {
      generation++;
      for (const id of [...slots.keys()]) drop(id);
      known = false;
      log('[mail] stopped: this machine is a paired screen');
    },

    payload,
    known: (): boolean => known,

    /** The row behind a handle (Make a task names the task after its subject). */
    row(handle: unknown): MailRow | null {
      if (typeof handle !== 'string') return null;
      const id = owner.get(handle);
      return (id && slots.get(id)?.rows.find((r) => r.handle === handle)) || null;
    },

    /** For the tray: every account Gustav has, whether it is connected and whether it needs a new sign-in. */
    accounts(): { id: string; label: string; preset: MailPresetId; connected: boolean; refused: boolean }[] {
      return MAIL_ACCOUNTS.map((info) => {
        const slot = slots.get(info.id);
        return { id: info.id, label: info.label, preset: info.preset, connected: !!slot, refused: slot?.view.status === 'auth' };
      });
    },

    async open(handle: unknown): Promise<MailOpenResult> {
      try {
        const { provider, handle: h } = find(handle);
        const body = await provider.open(h);
        return { ok: true, body: { handle: h, text: String(body.text), attachments: body.attachments.map((a) => ({ name: String(a.name), size: Number(a.size) || 0 })) } };
      } catch (error) {
        log(`[mail] open failed: ${kindOf(error)}`);
        return { ok: false, message: mailProblem(error) };
      }
    },

    async act(handle: unknown, kind: MailActionKind): Promise<MailActionResult> {
      try {
        const { slot, provider, handle: h } = find(handle);
        if (kind === 'archive' || kind === 'trash') {
          const { undo } = await (kind === 'archive' ? provider.archive(h) : provider.trash(h));
          slot.rows = slot.rows.filter((r) => r.handle !== h);
          undoOwner.set(undo, slot.id);
          owner.delete(h);
          emit();
          return { ok: true, undo };
        }
        const row = await (kind === 'read' ? provider.markRead(h) : kind === 'unread' ? provider.markUnread(h) : kind === 'flag' ? provider.flag(h) : provider.unflag(h));
        const next = replaceRow(slot, row);
        emit();
        return { ok: true, row: next };
      } catch (error) {
        log(`[mail] ${kind} failed: ${kindOf(error)}`);
        return { ok: false, message: mailProblem(error) };
      }
    },

    async undo(token: unknown): Promise<MailActionResult> {
      try {
        if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(token)) throw new MailError('invalid');
        const id = undoOwner.get(token);
        const slot = id ? slots.get(id) : undefined;
        if (!slot?.provider) throw new MailError('invalid');
        const { handle } = await slot.provider.undo(token);
        undoOwner.delete(token);
        owner.set(handle, slot.id);
        // The row comes back with the next sync, which the provider has already asked for.
        return { ok: true };
      } catch (error) {
        log(`[mail] undo failed: ${kindOf(error)}`);
        return { ok: false, message: kindOf(error) === 'invalid' ? 'Too late to undo: it has been more than 5 seconds.' : mailProblem(error) };
      }
    },

    /** The web mail URL for one message, from the provider's fixed hosts, checked again here. */
    webUrl(handle: unknown): string | null {
      try {
        const { provider, handle: h } = find(handle);
        const url = provider.webUrl(h);
        return isWebMailUrl(url) ? url : null;
      } catch {
        return null;
      }
    },

    /**
     * Connect Gmail or GoDaddy: a real IMAP login and INBOX read with the
     * password BEFORE it is stored. The reply never contains the password.
     */
    async connectImap(preset: unknown, password: unknown, verify: (account: MailAccount, password: string) => Promise<MailProvider>): Promise<{ ok: boolean; message: string }> {
      const info = MAIL_ACCOUNTS.find((a) => a.preset === preset && a.preset !== 'm365');
      if (!info) return { ok: false, message: 'Choose Gmail or GoDaddy first.' };
      if (typeof password !== 'string' || !password || password.length > 8192 || /[\u0000-\u001f\u007f]/.test(password)) {
        return { ok: false, message: 'Paste the password first, on one line.' };
      }
      // Google shows an app password as four groups of four letters; the spaces are not part of it.
      const secret = info.preset === 'gmail' && /^[a-z]{4}( ?[a-z]{4}){3}$/i.test(password.trim()) ? password.replace(/\s+/g, '') : password;
      const account: MailAccount = { id: info.id, kind: 'imap', label: info.label, colour: info.colour, host: info.preset === 'gmail' ? 'imap.gmail.com' : 'imap.secureserver.net', port: 993, user: info.address };
      let provider: MailProvider;
      try {
        provider = await verify(account, secret);
      } catch (error) {
        const kind = kindOf(error);
        log(`[mail] ${info.id} connect refused: ${kind}`);
        const message = kind === 'auth'
          ? info.preset === 'gmail'
            ? 'Gmail did not accept that app password. Make a new one in your Google account (2-Step Verification must be on) and paste it here.'
            : 'GoDaddy did not accept that password. Check it in GoDaddy webmail and paste it again.'
          : MAIL_PROBLEM[kind];
        return { ok: false, message };
      }
      try {
        await deps.imap.save({ id: info.id, preset: info.preset as MailPreset, label: info.label, colour: info.colour, user: info.address }, secret);
      } catch {
        provider.stop();
        return { ok: false, message: MAIL_PROBLEM.storage };
      }
      drop(info.id);
      run(slotFor(info.id), provider);
      emit();
      log(`[mail] ${info.id} connected`);
      return { ok: true, message: `${info.label} connected.` };
    },

    /** Connect Microsoft 365: the browser sign-in in graph.ts, then sync. */
    async connectMicrosoft(): Promise<{ ok: boolean; message: string }> {
      const info = MAIL_ACCOUNTS.find((a) => a.preset === 'm365')!;
      let session: S;
      try {
        session = await deps.graph.signIn();
      } catch (error) {
        const reason = (error as { reason?: string })?.reason ?? 'refused';
        log(`[mail] ${info.id} sign-in did not finish: ${reason}`);
        const words: Record<string, string> = {
          state: 'The sign-in answer did not match this request, so it was refused. Try again.',
          denied: 'Microsoft did not grant access. Try again, or check the app consent in Entra.',
          timeout: 'The browser sign-in took longer than 3 minutes. Try again.',
          cancelled: 'Sign-in cancelled.',
          account: `That was not ${info.address}. Sign in with that account.`,
          offline: 'Could not reach Microsoft. Check the connection and try again.',
          rate: 'Microsoft is rate limiting sign-ins. Try again in a minute.',
          storage: 'The sign-in could not be stored securely on this PC, so it was not saved.',
          invalid: 'The sign-in answer could not be read. Try again.',
          refused: 'Microsoft refused the sign-in. Try again.',
        };
        return { ok: false, message: words[reason] ?? words.refused };
      }
      drop(info.id);
      run(slotFor(info.id), deps.makeGraph(session));
      emit();
      log(`[mail] ${info.id} connected`);
      return { ok: true, message: `${info.label} connected.` };
    },

    cancelMicrosoft: (): void => deps.graph.cancel(),

    /** Forget an account: stop it and delete its stored password or token. */
    async disconnect(id: string): Promise<boolean> {
      const info = accountInfo(id);
      if (!info) return false;
      drop(id);
      emit();
      try {
        if (info.preset === 'm365') await deps.graph.remove();
        else await deps.imap.remove(id);
        log(`[mail] ${id} disconnected, credentials deleted`);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type MailCenter = ReturnType<typeof createMailCenter>;
