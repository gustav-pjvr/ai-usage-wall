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

import { cleanIncoming, cleanOutgoing, SOURCE_PEER } from '../../shared/chat';
import type { ChatWire } from '../../shared/chat';
import { forgetAll, markDelivered, recordIncoming, recordOutgoing, takeOutbox } from './chat-store';
import { fromWire, type ProjectedUsage } from '../../shared/projection-wire';
import { open, seal, newMessageId } from './crypto';
import { RelaySocket, type SocketStatus } from './relay-socket';
import { clearProjection, loadLastFrame, saveLastFrame, saveProjection, type ScreenState } from './store';

/** Two missed 30 s beats before liveness is withdrawn. */
const LIVE_MS = 90_000;
/** Past this, stop saying "reconnecting" and say the source is offline. */
const OFFLINE_MS = 5 * 60_000;

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
  /** The last frame's wire payload and its screen-clock arrival, for the cache. */
  private lastPayload: ProjectedUsage | null = null;
  private lastPayloadAt = 0;
  /** Cache writes queue behind each other so two cannot interleave on the temp file. */
  private cacheChain: Promise<void> = Promise.resolve();
  private badFrames = 0;
  private terminal: ScreenPhase | null = null;
  private clock: NodeJS.Timeout | null = null;
  private usage: Record<string, unknown> | null = null;

  constructor(
    private state: ScreenState,
    private readonly onUsage: (usage: Record<string, unknown>) => void,
    private readonly onStatus: (s: ScreenStatus) => void,
    private readonly onNotice: (title: string, body: string) => void,
    /** Told about a message that arrived, so the UI and tray can react. */
    private readonly onChat?: (peerId: string, label: string) => void,
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
      /*
       * The accepted sequence is restored BEFORE the socket opens. It used to
       * start at 0 on every launch, so after any restart the first retained
       * ciphertext with seq > 0 was accepted and shown as live: a relay that
       * kept yesterday's frames could replay them in order (rule 29, across
       * a restart).
       */
      this.lastSeq = cached.seq;
      if (cached.payload) {
        this.lastPayload = cached.payload as ProjectedUsage;
        this.lastPayloadAt = cached.receivedAt;
        this.usage = fromWire(this.lastPayload) as Record<string, unknown>;
        this.onUsage(this.usage);
      }
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
    // A dropped socket says nothing about the source, so stop claiming it does.
    if (s.phase !== 'open') this.sourceOnline = false;
    if (s.phase === 'closed' && s.closeCode === 4003) this.terminal = 'revoked';
    if (s.phase === 'closed' && s.closeCode === 4004) this.terminal = 'space-closed';
    if (this.terminal === 'revoked' || this.terminal === 'space-closed') {
      // Its key can decrypt nothing further, so keeping it buys nothing and
      // leaving it is a stale secret on disk.
      void clearProjection();
      /*
       * And the conversation goes with it. clearProjection() deletes the chat
       * file, but the threads were still in memory, so the next save recreated
       * the whole history: opening the window, typing, or a label change was
       * enough. The pairing is over, so the words from it do not linger.
       */
      forgetAll();
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
      /*
       * Presence is a HINT for the reason line, never proof of liveness: only a
       * decrypted frame sets lastAuthAt.
       *
       * It IS however the best available answer to "would a message I send now
       * arrive", because the relay forwards nothing to a source that is not
       * connected and stores nothing it could not forward. Trusting the relay
       * here is trusting it about its own connectivity, which is the one thing
       * it cannot be wrong about without simply dropping the message anyway.
       */
      if (msg.t === 'source-online') this.sourceOnline = true;
      else if (msg.t === 'source-offline') this.sourceOnline = false;
      else this.sourceOnline = msg.sourceOnline === true;
      if (this.sourceOnline) this.flushChat();
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

    // It opened, so the key is right. A key-mismatch verdict from an earlier
    // run of bad frames is stale, and left sticky it would hide a working feed.
    if (this.terminal === 'key-mismatch') this.terminal = null;

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
      // The link is proved as of this moment, so anything queued can go.
      this.flushChat();
      this.persist();
      this.publish();
      return;
    }

    if (body.t === 'chat') {
      const wire = cleanIncoming((body as { msg?: unknown }).msg);
      if (wire) {
        const saved = recordIncoming(SOURCE_PEER, this.state.sourceLabel || 'the source machine', wire);
        if (saved) this.onChat?.(SOURCE_PEER, this.state.sourceLabel || 'the source machine');
      }
      this.persist();
      this.publish();
      return;
    }

    if (body.t === 'frame' && body.usage) {
      this.usage = fromWire(body.usage) as Record<string, unknown>;
      this.onUsage(this.usage);
      this.lastPayload = body.usage;
      this.lastPayloadAt = Date.now();
    }

    this.persist();
    this.publish();
  }

  /**
   * Write the accepted sequence, with the last frame, after EVERY accepted
   * message, beats and hellos included.
   *
   * The cache used to be throttled to once a minute. That was fine for the
   * payload, which is a convenience, and wrong for the sequence, which is a
   * security boundary: every unpersisted second is a second of frames the
   * relay could replay after a restart. Frames arrive at most every 10 s and
   * beats every 30 s, so unthrottled is a few small writes a minute. The
   * residual replay window is whatever arrived after the last write that
   * completed, which is one message unless the disk is failing.
   */
  /**
   * Whether a message would actually reach the source right now.
   *
   * A screen has no equivalent of the source's confirmed flag: it proved the
   * key by opening the hello, and it only ever had one peer. So an open socket
   * is the whole condition.
   */
  /** Relay-reported presence of the source. See the handler for why it is used. */
  private sourceOnline = false;

  private deliverable(): boolean {
    return this.socket.phase === 'open' && this.sourceOnline;
  }

  /** Send a typed message to the source, or queue it if the socket is down. */
  sendChat(raw: unknown): { ok: boolean; delivered: boolean; message?: ChatWire } {
    const text = cleanOutgoing(raw);
    if (!text) return { ok: false, delivered: false };
    const label = this.state.sourceLabel || 'the source machine';
    const wire: ChatWire = { id: newMessageId(), text, at: Date.now() };
    const delivered = this.deliverable() && this.sendUp({ t: 'chat', msg: wire });
    recordOutgoing(SOURCE_PEER, label, wire, delivered);
    return { ok: true, delivered, message: wire };
  }

  /** Push anything written while the socket was down. */
  private flushChat(): void {
    if (!this.deliverable()) return;
    const waiting = takeOutbox(SOURCE_PEER);
    if (!waiting.length) return;
    const sent: string[] = [];
    for (const msg of waiting) {
      if (this.sendUp({ t: 'chat', msg })) sent.push(msg.id);
    }
    markDelivered(SOURCE_PEER, sent);
    if (sent.length) console.log(`[chat] delivered ${sent.length} queued message(s)`);
  }

  /** Seal for the source and put it on the up channel. */
  private sendUp(body: unknown): boolean {
    try {
      const ct = seal(this.key, Date.now(), body);
      return this.socket.send({ t: 'up', ct });
    } catch (err) {
      console.warn('[chat] could not seal a message:', (err as Error).message);
      return false;
    }
  }

  private persist(): void {
    const seq = this.lastSeq;
    const payload = this.lastPayload;
    const receivedAt = this.lastPayloadAt;
    this.cacheChain = this.cacheChain.then(() => saveLastFrame(payload, receivedAt, seq));
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
