import type { WebSocket } from 'ws';
import { CLOSE_CODE } from './closeCodes.js';
import type { RejectReason } from './closeCodes.js';
import type { Conn, PairedSlotState, SlotState } from './types.js';
import type { Metrics } from './http/metrics.js';
import type { Logger } from './logging.js';
import type { SlotConnectionCaps, UnpairedConnectionCap } from './guards/caps.js';
import { byteLengthOfRawData, BINARY_SEND_OPTIONS, TEXT_SEND_OPTIONS } from './wireData.js';

export interface RendezvousDeps {
  readonly slotCaps: SlotConnectionCaps;
  readonly unpairedCap: UnpairedConnectionCap;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly parkTimeoutMs: number;
  /** Grace window for the contended-slot liveness probe; 0 disables it. */
  readonly contentionProbeTimeoutMs: number;
  readonly maxSessionMs: number;
  /** Session byte cap, applied to the pre-pair flush as well as the live path. */
  readonly maxSessionBytes: number;
  /** Slow-consumer ceiling, applied to the pre-pair flush as well as the live path. */
  readonly maxBufferedBytes: number;
}

function closeIfOpen(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
    try {
      socket.close(code, reason);
    } catch {
      // best-effort; the socket may already be tearing down
    }
  }
}

function clearTimer(conn: Conn, field: 'parkTimer' | 'sessionTimer'): void {
  const timer = conn[field];
  if (timer) {
    clearTimeout(timer);
    conn[field] = null;
  }
}

/**
 * Owns the single in-process slot table: which connections are waiting for
 * a partner and which are paired. The rendezvous decision inside
 * handleConnection() is fully synchronous - no `await` between reading and
 * mutating slots.get(slot) - so two connections racing for the same slot
 * can never both believe they are the second arrival (Node's single
 * thread makes this race-free without a lock).
 */
export class SlotTable {
  private readonly slots = new Map<string, SlotState>();
  /** In-flight contention probes, at most one per slot. */
  private readonly probeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: RendezvousDeps) {}

  get waitingCount(): number {
    let count = 0;
    for (const state of this.slots.values()) if (state.status === 'waiting') count += 1;
    return count;
  }

  get pairedCount(): number {
    let count = 0;
    for (const state of this.slots.values()) if (state.status === 'paired') count += 1;
    return count;
  }

  /** The single entry point invoked right after a WebSocket connection is accepted. */
  handleConnection(conn: Conn): void {
    const existing = this.slots.get(conn.slot);

    if (existing?.status === 'paired') {
      this.probePairedSlot(conn.slot, existing);
      this.rejectBusy(conn);
      return;
    }

    if (existing?.status === 'waiting' && existing.peer.socket.readyState === existing.peer.socket.OPEN) {
      if (!this.deps.slotCaps.tryReserve(conn.slot)) {
        this.rejectBusy(conn);
        return;
      }
      conn.slotReserved = true;
      this.pair(existing.peer, conn);
      return;
    }

    // No live waiting peer: either no entry, or a stale one whose close
    // event has not fired yet. Park fresh, overwriting any stale entry;
    // the stale connection's own handleClose() becomes a no-op once it
    // fires because it no longer owns this slot table entry.
    if (!this.deps.slotCaps.tryReserve(conn.slot)) {
      this.rejectBusy(conn);
      return;
    }
    conn.slotReserved = true;
    this.park(conn);
  }

  /** Called from the connection's 'close' handler, for every connection. */
  handleClose(conn: Conn): void {
    if (conn.torndown) return;
    conn.torndown = true;

    clearTimer(conn, 'parkTimer');
    clearTimer(conn, 'sessionTimer');
    // A torn-down connection has no pending probe. What actually keeps a stale
    // flag harmless is probePairedSlot's identity check, which returns before
    // reading the flag once this pair no longer owns the slot entry; clearing
    // here keeps every per-connection latch released in one place rather than
    // leaving this one to be reasoned about from the probe's side.
    conn.probePending = false;
    // Only release what this connection actually holds. A connection rejected
    // by rejectBusy never reserved, so releasing unconditionally would
    // decrement the reservation held by a peer that is still connected and
    // erode the per-slot cap toward zero.
    this.releaseSlotReservation(conn);
    this.releaseUnpairedReservation(conn);

    if (conn.state === 'waiting') {
      const state = this.slots.get(conn.slot);
      if (state?.status === 'waiting' && state.peer === conn) {
        this.slots.delete(conn.slot);
        this.deps.metrics.waitingSlots.decrement();
      }
      return;
    }

    if (conn.state === 'paired' && conn.partner) {
      const partner = conn.partner;
      const state = this.slots.get(conn.slot);
      // Identity check, mirroring the waiting branch above: a ws close
      // event can trail its teardown (up to ws's close timeout), by which
      // time the slot may already belong to a brand-new pair. A stale
      // close must never delete that new pair's entry or count a
      // peer-closed teardown for it.
      if (state?.status === 'paired' && (state.a === conn || state.b === conn)) {
        this.slots.delete(conn.slot);
        this.deps.metrics.onUnpair();
        this.deps.metrics.onPeerClosed();
      }
      conn.pairState = null;
      partner.pairState = null;
      closeIfOpen(partner.socket, CLOSE_CODE.PEER_CLOSED, 'peer_closed');
    }
  }

  /**
   * Tears down an established pair because a guard (byte cap, session cap,
   * backpressure) tripped. Acts on the tripping connection's own pair,
   * never on whatever currently owns the slot table entry: both of the
   * pair's sockets are closed directly, and the slot entry is deleted only
   * when it still points at this same pair, so a stale trip can never
   * black-hole the pair or tear down an innocent new pair on the same
   * slot. No-ops when the pair is already torn down.
   */
  enforceGuardTeardown(conn: Conn, closeCode: number, reason: RejectReason): void {
    const pairState = conn.pairState;
    if (!pairState) return;

    const tableEntry = this.slots.get(conn.slot);
    if (tableEntry === pairState) {
      this.slots.delete(conn.slot);
      this.deps.metrics.onUnpair();
    }
    this.deps.metrics.onReject(reason);
    pairState.a.pairState = null;
    pairState.b.pairState = null;
    clearTimer(pairState.a, 'sessionTimer');
    clearTimer(pairState.b, 'sessionTimer');
    closeIfOpen(pairState.a.socket, closeCode, reason);
    closeIfOpen(pairState.b.socket, closeCode, reason);
  }

  /**
   * Cancels any in-flight contention probes. Called on shutdown, before the
   * relay closes its live connections gracefully, so a probe can never
   * terminate() a socket that is already on its way out politely.
   */
  stopContentionProbes(): void {
    for (const timer of this.probeTimers.values()) clearTimeout(timer);
    this.probeTimers.clear();
  }

  /**
   * A newcomer on a paired slot is usually a peer whose old socket went
   * half-open without a FIN (a phone that roamed off wifi, a laptop that
   * slept), but the relay cannot tell that from a genuine third party by
   * looking: a dead TCP peer still reads OPEN. So it asks. Both incumbents
   * are pinged and given contentionProbeTimeoutMs to answer, and whichever
   * stays silent is terminated exactly as the keepalive loop would have
   * terminated it a full ping cycle later. Nothing is ever evicted for being
   * older, only for failing a liveness check.
   *
   * That is a liveness check, not a proof of death, and the window is short.
   * A ping is written behind whatever is already queued to the socket, so an
   * incumbent with a large outbound backlog (maxBufferedBytes allows 16 MiB)
   * can miss a 2s window while perfectly alive. Contention is therefore a
   * lever a slot-id holder can pull against a backlogged peer, which the
   * keepalive loop's 30s cadence effectively did not offer.
   *
   * The newcomer is still rejected either way. Letting it take the slot in
   * place would swap the survivor's peer out from under an open socket, which
   * the desktop client cannot absorb - it re-handshakes on transport
   * reconnect, not on a peer change.
   */
  private probePairedSlot(slot: string, pairState: PairedSlotState): void {
    if (this.deps.contentionProbeTimeoutMs <= 0) return;
    // One probe in flight per slot. A rejected client retrying on its own
    // backoff would otherwise arm a fresh timer on every dial.
    if (this.probeTimers.has(slot)) return;

    const probed = [pairState.a, pairState.b].filter((half) => half.socket.readyState === half.socket.OPEN);
    if (probed.length === 0) return;

    for (const half of probed) {
      half.probePending = true;
      try {
        half.socket.ping();
      } catch {
        // best-effort; the socket may already be tearing down
      }
    }

    const timer = setTimeout(() => {
      this.probeTimers.delete(slot);
      // The pair may have been torn down and the slot re-paired inside the
      // window. A stale probe must never reach a pair it did not test.
      if (this.slots.get(slot) !== pairState) return;

      for (const half of probed) {
        if (!half.probePending) continue;
        half.probePending = false;
        // Counted in two namespaces on purpose. onPongTimeout keeps the
        // `heartbeat` teardown cause honest: this is a genuinely failed ping,
        // and one the keepalive loop would have counted there anyway a cycle
        // later, so the bucket's meaning and its per-socket unit are
        // unchanged and only its timing moves. One case is not identical: the
        // keepalive loop skips a socket that is no longer OPEN, while this
        // loop gates on probePending alone, so a half still finishing a close
        // handshake it began after the probe armed is counted here where the
        // loop would have counted nothing. 'probe_evicted' lands in
        // rejectsByReason, which closedByCause never reads, and is what lets
        // an operator tell contention-triggered reaps from routine ones.
        this.deps.metrics.onPongTimeout();
        this.deps.metrics.onReject('probe_evicted');
        half.socket.terminate();
      }
    }, this.deps.contentionProbeTimeoutMs);
    timer.unref?.();
    this.probeTimers.set(slot, timer);
  }

  private releaseSlotReservation(conn: Conn): void {
    if (!conn.slotReserved) return;
    conn.slotReserved = false;
    this.deps.slotCaps.release(conn.slot);
  }

  private releaseUnpairedReservation(conn: Conn): void {
    if (!conn.unpairedReserved) return;
    conn.unpairedReserved = false;
    this.deps.unpairedCap.release();
  }

  private rejectBusy(conn: Conn): void {
    this.deps.metrics.onReject('slot_busy');
    conn.socket.close(CLOSE_CODE.SLOT_BUSY, 'slot_busy');
  }

  private park(conn: Conn): void {
    this.slots.set(conn.slot, { status: 'waiting', peer: conn });
    conn.state = 'waiting';
    this.deps.metrics.waitingSlots.increment();

    const timer = setTimeout(() => {
      conn.parkTimer = null;
      const state = this.slots.get(conn.slot);
      if (state?.status === 'waiting' && state.peer === conn) {
        this.slots.delete(conn.slot);
        this.deps.metrics.waitingSlots.decrement();
      }
      this.deps.metrics.onReject('park_timeout');
      conn.socket.close(CLOSE_CODE.PARK_TIMEOUT, 'park_timeout');
    }, this.deps.parkTimeoutMs);
    timer.unref?.();
    conn.parkTimer = timer;
  }

  private pair(waiting: Conn, incoming: Conn): void {
    clearTimer(waiting, 'parkTimer');
    this.deps.metrics.waitingSlots.decrement();

    // Both halves stop being unpaired here, not when they eventually close.
    // Releasing only on close would let the unpaired count track total live
    // connections instead of parked ones, and a healthy busy relay would
    // drift up into refusing every new pairing.
    this.releaseUnpairedReservation(waiting);
    this.releaseUnpairedReservation(incoming);

    waiting.state = 'paired';
    incoming.state = 'paired';
    waiting.partner = incoming;
    incoming.partner = waiting;

    const pairState: PairedSlotState = { status: 'paired', a: waiting, b: incoming, sessionBytes: 0 };
    this.slots.set(waiting.slot, pairState);
    waiting.pairState = pairState;
    incoming.pairState = pairState;
    this.deps.metrics.onPair();

    if (this.deps.maxSessionMs > 0) {
      const timer = setTimeout(() => {
        this.enforceGuardTeardown(waiting, CLOSE_CODE.SESSION_TIME_CAP, 'session_time_cap');
      }, this.deps.maxSessionMs);
      timer.unref?.();
      waiting.sessionTimer = timer;
      incoming.sessionTimer = timer;
    }

    // Flush the waiting peer's buffered pre-pair frames to the newcomer,
    // in order, before any live traffic. The newcomer cannot have
    // buffered anything itself: pairing happens synchronously inside its
    // own connection handler, before its 'message' listener can fire.
    //
    // These bytes are charged against the session and checked for
    // backpressure exactly as the live path charges them, in the same order
    // (connection.ts's forward()). Flushing outside that accounting would
    // let a parked peer push a whole MAX_PARKED_BUFFER_BYTES past both caps
    // on every pairing.
    for (const frame of waiting.pending) {
      if (incoming.socket.readyState !== incoming.socket.OPEN) break;

      if (incoming.socket.bufferedAmount > this.deps.maxBufferedBytes) {
        this.enforceGuardTeardown(waiting, CLOSE_CODE.BACKPRESSURE, 'backpressure');
        break;
      }

      const size = byteLengthOfRawData(frame.data);
      pairState.sessionBytes += size;
      if (pairState.sessionBytes > this.deps.maxSessionBytes) {
        this.enforceGuardTeardown(waiting, CLOSE_CODE.SESSION_BYTE_CAP, 'session_byte_cap');
        break;
      }

      incoming.socket.send(frame.data, frame.isBinary ? BINARY_SEND_OPTIONS : TEXT_SEND_OPTIONS);
      this.deps.metrics.onForward(size);
    }
    waiting.pending = [];
    waiting.pendingBytes = 0;
  }
}
