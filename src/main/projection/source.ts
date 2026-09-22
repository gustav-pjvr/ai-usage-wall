/**
 * The SOURCE role: this machine reads ~/.claude and broadcasts to its screens.
 *
 * Three things this file is careful about, in order of how badly they would
 * hurt if they were wrong:
 *
 *   1. It never blocks the local dashboard. `offer()` returns synchronously
 *      after setting a flag; encryption and sending happen on a later tick
 *      inside their own try/catch. A relay outage is a status pill, never an
 *      error path through pushUsage(). See rule 30.
 *
 *   2. It only ever encrypts for screens in its OWN file. A relay that invents
 *      a screen id gets nothing, because there is no key for it here.
 *
 *   3. Nothing reaches the wire except through toWire(), which strips paths,
 *      usernames and session ids. See rule 26.
 */

import { cleanIncoming, cleanLabel, cleanOutgoing } from '../../shared/chat';
import type { ChatWire } from '../../shared/chat';
import { forgetPeer, markDelivered, recordIncoming, recordOutgoing, takeOutbox } from './chat-store';
import type { KeyObject } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { frameKey, toWire, type ProjectedUsage } from '../../shared/projection-wire';
import { CODE_TTL_MS, formatCode, generateCode } from '../../shared/pairing-code';
import { deriveScreenKey, lookupFromStretched, newKeyPair, open, randomBytes, seal, stretchCode, newMessageId } from './crypto';
import { RelaySocket, type SocketStatus } from './relay-socket';
import { saveProjection, type SourceState } from './store';

/**
 * The floor on anything crossing the network, set by Gustav at 10 seconds.
 *
 * The LOCAL dashboard keeps its own 4 s coalescing: that costs nothing and the
 * wall in front of you should feel live. This is push-on-change rate limited,
 * not a timer, so an idle machine sends nothing at all.
 */
const WIRE_MIN_INTERVAL_MS = 10_000;

/**
 * A tiny encrypted beat while screens are connected and nothing has changed.
 *
 * Without it, "no frame for a while" is ambiguous between an idle source and a
 * dead one, and the screen would have to either lie or nag. Thirty seconds
 * against the screen's 90 second liveness threshold leaves room for two to be
 * missed before anything is claimed.
 */
const BEAT_MS = 30_000;

/**
 * The leaf of the home directory, which on Windows IS the username. It goes to
 * toWire so a label equal to it is masked: running Claude Code from the home
 * folder made the username the project label, and the consent dialog promises
 * the username is never sent.
 */
const HOME_DIR_NAME = ((): string => {
  try {
    return path.basename(os.homedir());
  } catch {
    return '';
  }
})();

export interface SourceScreenStatus {
  screenId: string;
  label: string;
  online: boolean;
  confirmed: boolean;
}

export interface SourceStatus {
  role: 'source';
  phase: SocketStatus['phase'];
  reason?: string;
  retryIn?: number;
  screens: SourceScreenStatus[];
  pairing: { code: string; expiresAt: number } | null;
  lastSentAt: number | null;
  lastFrameBytes: number | null;
}

interface PendingOffer {
  code: string;
  /** scrypt of the code, computed once in beginPairing and reused for the key. */
  stretched: Buffer;
  lookup: string;
  keyPair: { privateKey: KeyObject; publicKey: string };
  expiresAt: number;
}

export class SourceProjector {
  private socket: RelaySocket;
  private pending: PendingOffer | null = null;
  private online = new Set<string>();
  private dirty = false;
  private lastSend = 0;
  private timer: NodeJS.Timeout | null = null;
  private beat: NodeJS.Timeout | null = null;
  private latest: ProjectedUsage | null = null;
  /** The last frame sent, minus the fields that change on every build. See frameKey. */
  private lastKey = '';
  private seq = 0;
  private lastSentAt: number | null = null;
  private lastFrameBytes: number | null = null;

  constructor(
    private state: SourceState,
    private readonly onStatus: (s: SourceStatus) => void,
    private readonly onNotice: (title: string, body: string) => void,
    /** Told about a message that arrived, so the UI and tray can react. */
    private readonly onChat?: (peerId: string, label: string) => void,
  ) {
    this.socket = new RelaySocket({
      url: `${state.relayUrl.replace(/\/$/, '').replace(/^https/, 'wss')}/v1/space/${state.spaceId}/source`,
      auth: () => ({ t: 'auth', secret: this.state.sourceSecret }),
      onMessage: (m) => this.handle(m),
      onStatus: () => this.publish(),
      // 4001 means the relay does not accept this secret. Retrying cannot fix
      // it and would hammer the relay forever.
      fatalCodes: [4001],
    });
  }

  start(): void {
    this.socket.start();
    this.beat = setInterval(() => this.sendBeat(), BEAT_MS);
    this.beat.unref?.();
  }

  stop(): void {
    this.socket.stop();
    if (this.timer) clearTimeout(this.timer);
    if (this.beat) clearInterval(this.beat);
    this.timer = null;
    this.beat = null;
  }

  /** Tear the space down at the relay as well as locally. */
  destroy(): void {
    this.socket.send({ t: 'destroy' });
    this.stop();
  }

  status(): SourceStatus {
    return {
      role: 'source',
      phase: this.socket.phase,
      retryIn: this.socket.phase === 'closed' ? this.socket.retryInSeconds() : undefined,
      screens: this.state.screens.map((s) => ({
        screenId: s.screenId,
        label: s.label,
        online: this.online.has(s.screenId),
        confirmed: s.confirmed,
      })),
      pairing: this.pending ? { code: formatCode(this.pending.code), expiresAt: this.pending.expiresAt } : null,
      lastSentAt: this.lastSentAt,
      lastFrameBytes: this.lastFrameBytes,
    };
  }

  private publish(): void {
    try {
      this.onStatus(this.status());
    } catch {
      /* a status listener must never break the projector */
    }
  }

  // ── Pairing ──────────────────────────────────────────────────────────────

  beginPairing(): { code: string; expiresAt: number } {
    const code = generateCode(randomBytes);
    /*
     * scrypt runs HERE, once per pairing, and the result serves both the
     * lookup sent now and the key derived when the screen pairs. About 100 ms
     * on the main thread in response to a click, which is acceptable; it must
     * never move into the per-message path, and 'paired' must not run it again.
     */
    const stretched = stretchCode(code);
    const keyPair = newKeyPair();
    const expiresAt = Date.now() + CODE_TTL_MS;
    this.pending = { code, stretched, lookup: lookupFromStretched(stretched), keyPair, expiresAt };

    this.socket.send({
      t: 'offer',
      lookup: this.pending.lookup,
      pub: keyPair.publicKey,
      exp: expiresAt,
      spaceId: this.state.spaceId,
    });
    this.publish();
    return { code: formatCode(code), expiresAt };
  }

  cancelPairing(): void {
    this.pending = null;
    this.socket.send({ t: 'cancel-offer' });
    this.publish();
  }

  async revoke(screenId: string): Promise<void> {
    /*
     * Delete the key FIRST, then tell the relay.
     *
     * The local key is what actually revokes: without it nothing new can ever
     * be encrypted for that screen, whatever the relay does or fails to do. The
     * relay message is a courtesy that closes the socket promptly.
     */
    this.state = { ...this.state, screens: this.state.screens.filter((s) => s.screenId !== screenId) };
    if (!this.socket.send({ t: 'revoke', screenId })) {
      this.state.pendingRevocations = [...this.state.pendingRevocations, screenId];
    }
    this.online.delete(screenId);
    await saveProjection(this.state);
    this.publish();
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    switch (msg.t) {
      case 'ready': {
        // The relay's view of who exists. Ours is authoritative, so push any
        // revocations that happened while we were offline.
        for (const screenId of this.state.pendingRevocations) this.socket.send({ t: 'revoke', screenId });
        if (this.state.pendingRevocations.length) {
          this.state = { ...this.state, pendingRevocations: [] };
          await saveProjection(this.state);
        }
        const list = Array.isArray(msg.screens) ? (msg.screens as Record<string, unknown>[]) : [];
        this.online = new Set(
          list.filter((s) => s.online === true).map((s) => String(s.screenId)),
        );
        this.publish();
        return;
      }

      case 'paired': {
        const pending = this.pending;
        if (!pending) return;
        if (Date.now() > pending.expiresAt) {
          this.pending = null;
          return;
        }
        const screenId = String(msg.screenId ?? '');
        const screenPub = String(msg.screenPub ?? '');
        if (!screenId || !screenPub) return;

        let key: Buffer;
        try {
          key = deriveScreenKey(pending.keyPair.privateKey, screenPub, pending.stretched, pending.lookup);
        } catch (err) {
          console.warn('[projection] could not derive a key for the new screen:', (err as Error).message);
          return;
        }

        this.state = {
          ...this.state,
          screens: [
            ...this.state.screens,
            {
              screenId,
              key: key.toString('base64'),
              label: `Screen ${this.state.screens.length + 1}`,
              pairedAt: new Date().toISOString(),
              // Not confirmed until it proves it derived the same key.
              confirmed: false,
            },
          ],
        };
        this.pending = null;
        await saveProjection(this.state);

        // No hello here: the screen has not connected yet. It is sent from the
        // 'screen-online' handler, which is the first moment it can arrive.
        this.publish();
        return;
      }

      case 'screen-online': {
        const screenId = String(msg.screenId ?? '');
        this.online.add(screenId);

        /*
         * The hello goes HERE, not when the relay says "paired".
         *
         * Redemption happens over HTTP, before the screen has opened its
         * socket, and the relay stores no frames: a hello sent at pairing time
         * is addressed to a socket that does not exist yet and is dropped. The
         * screen then received frames and worked, but was never marked
         * confirmed, because the proof-of-key exchange had silently gone
         * nowhere. Sending it on connect also covers every later reconnect.
         */
        const record = this.state.screens.find((sc) => sc.screenId === screenId);
        if (record && !record.confirmed) this.sendTo(screenId, { t: 'hello', label: this.state.label });

        // Send the data immediately too, or a screen connecting to an idle
        // source stares at nothing until something changes.
        this.pushNow(screenId);
        this.flushChat(screenId);
        this.publish();
        return;
      }

      case 'screen-offline':
        this.online.delete(String(msg.screenId ?? ''));
        this.publish();
        return;

      case 'screen-left': {
        const screenId = String(msg.screenId ?? '');
        this.state = { ...this.state, screens: this.state.screens.filter((s) => s.screenId !== screenId) };
        this.online.delete(screenId);
        await saveProjection(this.state);
        // The key is gone, so this screen can never be reached again. Leaving
        // its thread would keep a conversation on disk for a pairing that no
        // longer exists, and show it in the window as permanently offline.
        forgetPeer(screenId);
        this.onNotice('Screen unpaired', 'A screen removed itself from this space.');
        this.publish();
        return;
      }

      case 'up': {
        // The only thing a screen can say that this source acts on.
        const from = String(msg.from ?? '');
        const record = this.state.screens.find((s) => s.screenId === from);
        if (!record || typeof msg.ct !== 'string') return;
        try {
          // Statically imported, NOT require()d at runtime: esbuild bundles this
          // file, and a runtime require of a relative path does not survive
          // bundling. That silently broke the hello-ack, so a screen paired and
          // received frames but was never marked confirmed.
          const opened = open(Buffer.from(record.key, 'base64'), msg.ct);

          /*
           * Replay boundary for the up channel.
           *
           * Dedupe by message id catches a replay while the id is still
           * remembered, but that set is bounded, so a relay holding an old
           * sealed frame could re-present it once the original had scrolled out
           * of history. The sequence is in the authenticated header and the
           * screen derives it from its clock, so it only ever rises. Anything
           * not strictly newer is a frame this source has already seen.
           */
          const lastUp = record.lastUpSeq ?? 0;
          if (opened.seq <= lastUp) {
            console.warn('[projection] ignoring an out-of-order or replayed message from a screen');
            return;
          }
          this.state = {
            ...this.state,
            screens: this.state.screens.map((sc) =>
              sc.screenId === from ? { ...sc, lastUpSeq: opened.seq } : sc,
            ),
          };
          await saveProjection(this.state);

          const payload = opened.payload as { t?: string; label?: string; msg?: unknown };

          if (payload?.t === 'chat') {
            /*
             * No sequence check on this channel, by the design that predates
             * chat: the source does not track a per-screen sequence for
             * incoming. Dedupe is by message id instead, so a relay replaying
             * an old up frame delivers nothing new.
             */
            const wire = cleanIncoming(payload.msg);
            if (!wire) return;
            const saved = recordIncoming(from, record.label, wire);
            if (saved) this.onChat?.(from, record.label);
            return;
          }

          if (payload?.t !== 'hello-ack') return;

          const label = cleanLabel(payload.label, record.label);
          this.state = {
            ...this.state,
            screens: this.state.screens.map((s) =>
              s.screenId === from ? { ...s, confirmed: true, label } : s,
            ),
          };
          await saveProjection(this.state);
          this.onNotice('Screen paired', `${label} is now showing this machine.`);
          this.pushNow(from);
          // Now that the key is proved, anything queued can go.
          this.flushChat(from);
          this.publish();
        } catch {
          // Could not open it: this is not a screen that had the code. Ignore
          // it, and never let it near anything that matters.
          console.warn('[projection] a screen sent something this source cannot open; ignoring');
        }
        return;
      }

      case 'offer-expired':
        this.pending = null;
        this.publish();
        return;

      default:
        return;
    }
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /**
   * Called from pushUsage on every local change. Returns immediately: this must
   * never be on the critical path of the local dashboard.
   */
  offer(index: unknown, indexing: boolean): void {
    try {
      this.latest = toWire(index, {
        shareProjectNames: this.state.shareProjectNames,
        sourceLabel: this.state.label,
        indexing,
        homeDirName: HOME_DIR_NAME,
      });
    } catch (err) {
      console.warn('[projection] could not build a frame:', (err as Error).message);
      return;
    }
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    const since = Date.now() - this.lastSend;
    const wait = Math.max(0, WIRE_MIN_INTERVAL_MS - since);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  private flush(): void {
    if (!this.dirty || !this.latest) return;
    /*
     * Skip a send when nothing a screen can SEE has changed. The local index
     * changes whenever a byte is appended, but the wire format has offsets and
     * paths stripped, so many of those changes are invisible downstream, and the
     * periodic sweep refreshes even when nothing was appended at all.
     *
     * This never fired before: see frameKey for why, and for why the old
     * length-plus-ends comparison could not simply be kept once it did.
     */
    const key = frameKey(this.latest);
    if (key === this.lastKey) {
      this.dirty = false;
      return;
    }
    this.lastKey = key;
    this.dirty = false;
    this.lastSend = Date.now();

    for (const screen of this.state.screens) {
      if (!this.online.has(screen.screenId) || !screen.confirmed) continue;
      this.sendTo(screen.screenId, { t: 'frame', usage: this.latest });
    }
  }

  /**
   * Nothing but the hello goes to a screen that has not proved its key.
   *
   * The hello-ack is the proof that both sides derived the same key. Before
   * this gate the whole dashboard went out on connect and on every change
   * regardless, so the confirmed flag only ever changed a tray label. A screen
   * that cannot open the hello could not open a frame either, so withholding
   * them costs a real screen nothing: the ack arrives within a second and the
   * push in the 'up' handler sends the first frame the moment it does.
   */
  private pushNow(screenId: string): void {
    if (!this.latest) return;
    const record = this.state.screens.find((s) => s.screenId === screenId);
    if (!record?.confirmed) return;
    this.sendTo(screenId, { t: 'frame', usage: this.latest });
  }

  private sendBeat(): void {
    if (!this.online.size) return;
    // Only if nothing has gone out recently: a real frame is a better beat.
    if (Date.now() - this.lastSend < BEAT_MS) return;
    for (const screen of this.state.screens) {
      // Same gate as the frames: an unconfirmed screen gets the hello and nothing else.
      if (this.online.has(screen.screenId) && screen.confirmed) this.sendTo(screen.screenId, { t: 'beat' });
    }
  }

  private sendTo(screenId: string, payload: unknown): boolean {
    const record = this.state.screens.find((s) => s.screenId === screenId);
    if (!record) return false; // no key, no send. A relay-invented id lands here.
    try {
      // Monotonic and clock-derived, so it keeps rising across a restart and a
      // replayed frame is always detectable as old.
      this.seq = Math.max(this.seq + 1, Date.now());
      const ct = seal(Buffer.from(record.key, 'base64'), this.seq, { sentAt: Date.now(), body: payload });
      if (this.socket.send({ t: 'frame', to: screenId, ct })) {
        this.lastSentAt = Date.now();
        this.lastFrameBytes = ct.length;
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[projection] could not seal a frame:', (err as Error).message);
      return false;
    }
  }

  /**
   * Whether a message put on the wire right now would actually arrive.
   *
   * All three conditions matter. The relay stores nothing, so a frame addressed
   * to a screen that is not connected is discarded in transit with no error
   * raised anywhere, and an unconfirmed screen has not proved it holds the key.
   */
  private deliverableTo(screenId: string): boolean {
    const record = this.state.screens.find((s) => s.screenId === screenId);
    return !!record && record.confirmed && this.online.has(screenId) && this.socket.phase === 'open';
  }

  /**
   * Send a typed message to one screen.
   *
   * A message that cannot be delivered is queued rather than dropped, and the
   * caller is told which happened so the UI can say so. Silently accepting a
   * message that went nowhere is the failure this whole path is shaped to
   * avoid.
   */
  sendChat(screenId: string, raw: unknown): { ok: boolean; delivered: boolean; message?: ChatWire } {
    const text = cleanOutgoing(raw);
    if (!text) return { ok: false, delivered: false };
    const record = this.state.screens.find((s) => s.screenId === screenId);
    if (!record) return { ok: false, delivered: false };

    const wire: ChatWire = { id: newMessageId(), text, at: Date.now() };
    const delivered = this.deliverableTo(screenId) && this.sendTo(screenId, { t: 'chat', msg: wire });
    recordOutgoing(screenId, record.label, wire, delivered);
    return { ok: true, delivered, message: wire };
  }

  /** Push anything that was written while a screen was away. */
  private flushChat(screenId: string): void {
    if (!this.deliverableTo(screenId)) return;
    const waiting = takeOutbox(screenId);
    if (!waiting.length) return;
    const sent: string[] = [];
    for (const msg of waiting) {
      if (this.sendTo(screenId, { t: 'chat', msg })) sent.push(msg.id);
    }
    markDelivered(screenId, sent);
    if (sent.length) console.log(`[chat] delivered ${sent.length} queued message(s)`);
  }

  /** Settings changed under us, e.g. the share-project-names toggle. */
  update(state: SourceState): void {
    this.state = state;
    this.lastKey = ''; // force the next frame through
    this.dirty = true;
    this.schedule();
  }

  current(): SourceState {
    return this.state;
  }
}
