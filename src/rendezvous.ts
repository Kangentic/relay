import type { WebSocket } from 'ws';
import { CLOSE_CODE } from './closeCodes.js';
import type { RejectReason } from './closeCodes.js';
import type { Conn, PairedSlotState, SlotState } from './types.js';
import type { Metrics } from './http/metrics.js';
import type { Logger } from './logging.js';
import type { SlotConnectionCaps } from './guards/caps.js';
import { byteLengthOfRawData, BINARY_SEND_OPTIONS, TEXT_SEND_OPTIONS } from './wireData.js';

export interface RendezvousDeps {
  readonly slotCaps: SlotConnectionCaps;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly parkTimeoutMs: number;
  readonly maxSessionMs: number;
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
      this.rejectBusy(conn);
      return;
    }

    if (existing?.status === 'waiting' && existing.peer.socket.readyState === existing.peer.socket.OPEN) {
      if (!this.deps.slotCaps.tryReserve(conn.slot)) {
        this.rejectBusy(conn);
        return;
      }
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
    this.park(conn);
  }

  /** Called from the connection's 'close' handler, for every connection. */
  handleClose(conn: Conn): void {
    if (conn.torndown) return;
    conn.torndown = true;

    clearTimer(conn, 'parkTimer');
    clearTimer(conn, 'sessionTimer');
    this.deps.slotCaps.release(conn.slot);

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
    for (const frame of waiting.pending) {
      if (incoming.socket.readyState === incoming.socket.OPEN) {
        incoming.socket.send(frame.data, frame.isBinary ? BINARY_SEND_OPTIONS : TEXT_SEND_OPTIONS);
        this.deps.metrics.onForward(byteLengthOfRawData(frame.data));
      }
    }
    waiting.pending = [];
    waiting.pendingBytes = 0;
  }
}
