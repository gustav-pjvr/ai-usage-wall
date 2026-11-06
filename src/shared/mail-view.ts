/**
 * Work mode's mail: the only shapes the renderer sees, and the pure rules both
 * sides share (docs/work-mode.md, "Mail"). Full build only: nothing in the
 * stats edition imports this file.
 *
 * Every string here came from a mail server and is untrusted. Main has already
 * reduced it to plain text (src/main/work/mail-text.ts); the renderer still
 * inserts all of it with textContent. No password, token, raw header or HTML
 * body is ever in any of these shapes.
 */

export type MailAccountStatus = 'ready' | 'syncing' | 'offline' | 'auth' | 'tls' | 'rate' | 'error';

export interface MailAccountView {
  id: string;
  label: string;
  colour: string;
  /** Unread messages in the whole INBOX, as the server counts them. */
  unread: number;
  status: MailAccountStatus;
  syncedAt: string | null;
  /** Which way the account is read: IMAP (Gmail, GoDaddy) or Microsoft Graph. */
  provider?: 'imap' | 'graph';
}

export interface MailRow {
  account: string;
  /** Opaque to the renderer: main maps it back to the message. */
  handle: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  snippet: string;
  /** When the message arrived, ISO. */
  date: string;
  seen: boolean;
  flagged: boolean;
  /** Newsletter or automated mail (List-Unsubscribe, no-reply, Gmail Promotions or Social, Outlook Other). */
  bulk: boolean;
}

export interface MailBody {
  handle: string;
  /** Plain text only. Links are written out as "text (https://...)" and never opened by the wall. */
  text: string;
  attachments: { name: string; size: number }[];
}

/** A new message seen by a sync after the first. Main only: notices are decided from it. */
export interface MailEvent {
  kind: 'person' | 'bulk';
  account: string;
  handle: string;
  fromName: string;
  /** For the VIP list. Never shown in a notice. */
  fromAddress?: string;
  subject: string;
  /** Stable across restarts (account, folder generation, server id), for de-duplication. */
  key?: string;
}

/** Everything the inbox panel is sent. */
export interface MailPayload {
  /** False until the stored accounts have been looked at: the panel shows loading, not "no accounts". */
  known: boolean;
  accounts: MailAccountView[];
  /** Newest first, at most MAIL_ROWS per account. */
  rows: MailRow[];
}

export const MAIL_ROWS = 200;

export type MailActionKind = 'read' | 'unread' | 'flag' | 'unflag' | 'archive' | 'trash';
export const MAIL_ACTIONS: readonly MailActionKind[] = ['read', 'unread', 'flag', 'unflag', 'archive', 'trash'];

export type MailActionResult =
  | { ok: true; row?: MailRow; undo?: string }
  | { ok: false; message: string };

export type MailOpenResult = { ok: true; body: MailBody } | { ok: false; message: string };

/** The three accounts Gustav decided on (2026-11-06). No Titan. */
export type MailPresetId = 'gmail' | 'godaddy' | 'm365';

export interface MailPresetInfo {
  preset: MailPresetId;
  id: string;
  label: string;
  colour: string;
  address: string;
}

export const MAIL_ACCOUNTS: readonly MailPresetInfo[] = [
  { preset: 'm365', id: 'muchbetter', label: 'MuchBetter', colour: '#4f8fe8', address: 'gustav@muchbetter.world' },
  { preset: 'gmail', id: 'gmail', label: 'Gmail', colour: '#e8574f', address: 'gustavpjvr@gmail.com' },
  { preset: 'godaddy', id: 'pickleplay', label: 'PicklePlay', colour: '#4fc27a', address: 'gustav@pickleplaysouthafrica.org' },
];

export const accountInfo = (id: string): MailPresetInfo | undefined => MAIL_ACCOUNTS.find((a) => a.id === id);

/** "Open in Outlook" and so on: what the web mail of an account is called. */
export function webMailName(accountId: string): string {
  const preset = accountInfo(accountId)?.preset;
  return preset === 'm365' ? 'Outlook' : preset === 'gmail' ? 'Gmail' : 'webmail';
}

const STATUS_WORDS: Record<MailAccountStatus, string> = {
  ready: 'synced',
  syncing: 'syncing',
  offline: 'unreachable, retrying',
  auth: 'sign-in refused, use Reconnect in the tray',
  tls: 'certificate check failed, not connected',
  rate: 'rate limited, retrying',
  error: 'server problem, retrying',
};

function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** The status strip's line for one account, read off the clock. */
export function mailSyncLabel(a: MailAccountView, now: number): { text: string; tone: 'ok' | 'bad' | 'off' } {
  const synced = a.syncedAt ? Date.parse(a.syncedAt) : NaN;
  if (a.status === 'ready' && Number.isFinite(synced)) return { text: `${a.label} synced ${age(now - synced)} ago`, tone: 'ok' };
  if (a.status === 'ready' || a.status === 'syncing') return { text: `${a.label} syncing`, tone: 'off' };
  return { text: `${a.label} ${STATUS_WORDS[a.status]}`, tone: 'bad' };
}

/** "09:42" today, "Yest", a weekday this week, else "5 Nov". Local time. */
export function mailTime(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const n = new Date(now);
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(n) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days === 1) return 'Yest';
  if (days < 7) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
