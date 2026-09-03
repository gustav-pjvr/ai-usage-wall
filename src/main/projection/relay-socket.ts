/**
 * One reconnecting WebSocket, shared by both roles.
 *
 * This is the ONLY file in the app that opens a network connection, and it is
 * constructed only from projection/index.ts when a role is configured. Nothing
 * else may import it. That is rule 25, and it is what makes "projection off
 * means no network" checkable by grep rather than by reading every file.
 *
 * Node's global WebSocket is used (verified present in Electron 44 / Node 24),
 * so there is no dependency and nothing new in the packaged bundle.
 *
 * Authentication is the FIRST MESSAGE, not a header: the global WebSocket
 * cannot set request headers, and a token in a URL ends up in logs at every hop
 * it passes through.
 */

export type SocketPhase = 'idle' | 'connecting' | 'open' | 'closed';

export interface SocketStatus {
  phase: SocketPhase;
  /** Set when the relay closed us deliberately, e.g. 4003 revoked. */
  closeCode?: number;
  /** Human-readable reason for the last failure, for the status strip. */
  reason?: string;
  attempt: number;
}

interface Options {
  url: string;
  /** The first message, sent the instant the socket opens. */
  auth: () => unknown;
  onMessage: (msg: Record<string, unknown>) => void;
  onStatus: (s: SocketStatus) => void;
  /** Codes that mean "stop trying", because retrying cannot help. */
  fatalCodes?: number[];
}

/** 512 KB. A frame is about 20 KB; this is a bound, not a target. */
const MAX_MESSAGE = 512 * 1024;

export class RelaySocket {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = true;
  private status: SocketStatus = { phase: 'idle', attempt: 0 };

  constructor(private readonly opts: Options) {}

  get phase(): SocketPhase {
    return this.status.phase;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(code = 1000, reason = 'stopped'): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
    this.setStatus({ phase: 'idle', attempt: 0 });
  }

  /** Returns false when the socket is not open, so callers can skip work. */
  send(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.warn('[projection] send failed:', (err as Error).message);
      return false;
    }
  }

  private setStatus(next: Partial<SocketStatus>): void {
    this.status = { ...this.status, ...next };
    this.opts.onStatus(this.status);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus({ phase: 'connecting', attempt: this.attempt, reason: undefined });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      // A malformed URL, which retrying will not fix. Report and back off
      // anyway rather than spinning.
      this.fail((err as Error).message);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus({ phase: 'open', attempt: 0, reason: undefined, closeCode: undefined });
      this.send(this.opts.auth());
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        return; // a relay that sends junk is ignored, never trusted
      }
      if (typeof msg !== 'object' || msg === null) return;
      try {
        this.opts.onMessage(msg as Record<string, unknown>);
      } catch (err) {
        // A handler bug must not take the socket down with it.
        console.error('[projection] message handler threw:', (err as Error).message);
      }
    };

    ws.onerror = () => {
      /* onclose always follows; handling it twice would double the backoff */
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return; // a superseded socket
      this.ws = null;

      const fatal = (this.opts.fatalCodes ?? []).includes(event.code);
      if (fatal || this.stopped) {
        this.setStatus({ phase: 'closed', closeCode: event.code, reason: event.reason || undefined });
        this.stopped = true;
        return;
      }
      this.fail(event.reason || `closed (${event.code})`, event.code);
    };
  }

  private fail(reason: string, closeCode?: number): void {
    this.ws = null;
    this.attempt += 1;
    this.setStatus({ phase: 'closed', reason, closeCode, attempt: this.attempt });
    if (this.stopped) return;

    /*
     * Exponential backoff to a minute, with jitter. The jitter matters even for
     * two machines: without it, a relay restart brings every client back at the
     * same instant, and the thundering herd is the thing that keeps it down.
     */
    const base = Math.min(60_000, 2000 * 2 ** Math.min(this.attempt - 1, 5));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref?.();
  }

  /** Seconds until the next attempt, for the status line. */
  retryInSeconds(): number {
    const base = Math.min(60_000, 2000 * 2 ** Math.min(Math.max(this.attempt - 1, 0), 5));
    return Math.round(base / 1000);
  }
}
