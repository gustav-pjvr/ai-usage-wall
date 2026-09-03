/**
 * The SCREEN role: this machine shows another machine's dashboard.
 *
 * The whole file turns on one rule (rule 28):
 *
 *   LIVE is claimed only on the strength of a frame this machine DECRYPTED and
 *   VERIFIED, received within the last 90 seconds by its own clock.
 *
 * Not on the relay saying the source is online. Not on the socket being open.
 * Not on a `sentAt` inside the payload. The relay is not trusted to be honest
 * and the two machines' clocks are not trusted to agree, so the only thing that
 * counts is "I opened a real frame, and my own clock says it was recent".
 *
 * Everything else here follows from that: staleness is measured from receipt,
 * replays are rejected on a monotonic sequence, and numbers are never shown
 * without their age once they stop being live.
 */

import { fromWire, type ProjectedUsage } from '../../shared/projection-wire';
import { open, seal } from './crypto';
import { RelaySocket, type SocketStatus } from './relay-socket';
import { clearProjection, loadLastFrame, saveLastFrame, saveProjection, type ScreenState } from './store';

/** Two missed 30 s beats before liveness is withdrawn. */
const LIVE_MS = 90_000;
/** Past this, stop saying "reconnecting" and say the source is offline. */
const OFFLINE_MS = 5 * 60_000;
/** The cache is a convenience, not a record. Once a minute is plenty. */
const CACHE_MIN_INTERVAL_MS = 60_000;

export type ScreenPhase =
  | 'connecting'
  | 'live'
  | 'link-lost'
  | 'offline'
  | 'relay-unreachable'
  | 'revoked'
  | 'space-closed'
  | 'key-mismatch';

export interface ScreenStatus {
  role: 'screen';
  phase: ScreenPhase;
  sourceLabel: string;
  /** Milliseconds since the last verified frame, or null if there never was one. */
  ageMs: number | null;
  /** Wall-clock of the last verified frame, for "data as of 14:32". */
  lastAt: number | null;
  reason?: string;
  retryIn?: number;
}

export class ScreenReceiver {
  private socket: RelaySocket;
  private key: Buffer;
  private lastSeq = 0;
  /** Screen-clock time of the last frame this machine actually opened. */
  private lastAuthAt = 0;
  private lastCacheWrite = 0;
  private badFrames = 0;
  private terminal: ScreenPhase | null = null;
  private clock: NodeJS.Timeout | null = null;
  private usage: Record<string, unknown> | null = null;

  constructor(
    private state: ScreenState,
    private readonly onUsage: (usage: Record<string, unknown>) => void,
    private readonly onStatus: (s: ScreenStatus) => void,
    private readonly onNotice: (title: string, body: string) => void,
  ) {
    this.key = Buffer.from(state.key, 'base64');
    this.socket = new RelaySocket({
      url: `${state.relayUrl.replace(/\/$/, '').replace(/^https/, 'wss')}/v1/space/${state.spaceId}/screen`,
      auth: () => ({ t: 'auth', screenId: this.state.screenId, token: this.state.screenToken }),
      onMessage: (m) => void this.handle(m),
      onStatus: (s) => this.onSocket(s),
      // Revoked or space closed: retrying is pointless and the local record is
      // about to be deleted anyway.
      fatalCodes: [4003, 4004],
    });
  }

  async start(): Promise<void> {
    // Show something dated immediately rather than an empty wall, clearly
    // marked stale because lastAuthAt stays 0 until a real frame arrives.
    const cached = await loadLastFrame();
    if (cached) {
      this.usage = fromWire(cached.payload as ProjectedUsage) as Record<string, unknown>;
      this.onUsage(this.usage);
    }
    this.socket.start();
    // One timer for the age text. Nothing else polls.
    this.clock = setInterval(() => this.publish(), 15_000);
    this.clock.unref?.();
  }

  stop(): void {
    this.socket.stop();
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
  }

  /** Leave the space politely, so the source hears about it. */
  async unpair(): Promise<void> {
    this.socket.send({ t: 'leave' });
    this.stop();
    await clearProjection();
  }

  currentUsage(): Record<string, unknown> | null {
    return this.usage;
  }

  private onSocket(s: SocketStatus): void {
    if (s.phase === 'closed' && s.closeCode === 4003) this.terminal = 'revoked';
    if (s.phase === 'closed' && s.closeCode === 4004) this.terminal = 'space-closed';
    if (this.terminal === 'revoked' || this.terminal === 'space-closed') {
      // Its key can decrypt nothing further, so keeping it buys nothing and
      // leaving it is a stale secret on disk.
      void clearProjection();
      this.onNotice(
        this.terminal === 'revoked' ? 'Removed by the source' : 'Projection stopped',
        this.terminal === 'revoked'
          ? 'This screen was unpaired. Pair again with a new code to reconnect.'
          : 'The source machine stopped projecting.',
      );
    }
    this.publish();
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    if (msg.t === 'source-online' || msg.t === 'source-offline' || msg.t === 'ready') {
      // Presence is a HINT for the reason line, never proof of liveness.
      this.publish();
      return;
    }
    if (msg.t !== 'frame' || typeof msg.ct !== 'string') return;

    let opened;
    try {
      opened = open(this.key, msg.ct);
    } catch {
      /*
       * Cannot open it. Either the key is wrong (paired against a different
       * source) or someone tampered with it. Either way it is discarded and
       * never rendered. A single failure is noise; ten in a row is a state.
       */
      this.badFrames += 1;
      if (this.badFrames >= 10) this.terminal = 'key-mismatch';
      this.publish();
      return;
    }

    // Replay: the relay can resend an old frame, and yesterday's numbers must
    // never refresh liveness. See rule 29.
    if (opened.seq <= this.lastSeq) {
      console.warn('[projection] a frame arrived out of order and was discarded');
      return;
    }
    this.lastSeq = opened.seq;
    this.badFrames = 0;

    const payload = opened.payload as { body?: { t?: string; usage?: ProjectedUsage; label?: string } };
    const body = payload?.body;
    if (!body || typeof body.t !== 'string') return;

    // A beat carries no data; its whole job is to prove the source is alive.
    this.lastAuthAt = Date.now();

    if (body.t === 'hello') {
      /*
       * Opening this is the proof that BOTH sides derived the same key, so the
       * ack is what lets the source mark this screen confirmed. Nothing before
       * this point proves anything to either side.
       */
      if (typeof body.label === 'string' && body.label.trim()) {
        this.state = { ...this.state, sourceLabel: body.label.trim().slice(0, 40) };
        await saveProjection(this.state);
      }
      const ct = seal(this.key, Date.now(), { t: 'hello-ack', label: hostLabel() });
      this.socket.send({ t: 'up', ct });
      this.publish();
      return;
    }

    if (body.t === 'frame' && body.usage) {
      this.usage = fromWire(body.usage) as Record<string, unknown>;
      this.onUsage(this.usage);
      const now = Date.now();
      if (now - this.lastCacheWrite > CACHE_MIN_INTERVAL_MS) {
        this.lastCacheWrite = now;
        void saveLastFrame(body.usage, now);
      }
    }

    this.publish();
  }

  status(): ScreenStatus {
    const age = this.lastAuthAt ? Date.now() - this.lastAuthAt : null;
    const base = {
      role: 'screen' as const,
      sourceLabel: this.state.sourceLabel || 'the source machine',
      ageMs: age,
      lastAt: this.lastAuthAt || null,
    };

    if (this.terminal) return { ...base, phase: this.terminal };

    // Liveness first, and ONLY from a decrypted frame. A socket that is open
    // while nothing arrives is not live, whatever the relay says.
    if (age !== null && age < LIVE_MS) return { ...base, phase: 'live' };

    if (this.socket.phase !== 'open') {
      return {
        ...base,
        phase: age === null ? 'connecting' : 'relay-unreachable',
        reason: 'cannot reach the relay',
        retryIn: this.socket.retryInSeconds(),
      };
    }
    if (age === null) return { ...base, phase: 'connecting' };
    return { ...base, phase: age < OFFLINE_MS ? 'link-lost' : 'offline' };
  }

  private publish(): void {
    try {
      this.onStatus(this.status());
    } catch {
      /* a status listener must never break the receiver */
    }
  }
}

/**
 * What this screen calls itself to the source.
 *
 * The hostname, and ONLY inside the encrypted ack: it identifies the machine,
 * so it must not travel where the relay can read it (rule 33).
 */
function hostLabel(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('node:os') as typeof import('node:os');
    return os.hostname().slice(0, 40);
  } catch {
    return 'Screen';
  }
}
