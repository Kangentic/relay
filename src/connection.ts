import { randomUUID } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import { CLOSE_CODE } from './closeCodes.js';
import type { Conn, Config } from './types.js';
import type { SlotTable } from './rendezvous.js';
import type { Metrics } from './http/metrics.js';
import type { Logger } from './logging.js';
import { byteLengthOfRawData, BINARY_SEND_OPTIONS, TEXT_SEND_OPTIONS } from './wireData.js';

export interface ConnectionDeps {
  readonly slotTable: SlotTable;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly config: Pick<Config, 'maxParkedBufferBytes' | 'maxBufferedBytes' | 'maxSessionBytes'>;
  /** Releases this connection's per-IP/global cap reservation and drops it from the live-connection set. */
  readonly onClosed: () => void;
}

export function createConn(socket: WebSocket, slot: string, ip: string): Conn {
  return {
    id: randomUUID(),
    socket,
    slot,
    ip,
    connectedAt: Date.now(),
    state: 'waiting',
    partner: null,
    isAlive: true,
    pending: [],
    pendingBytes: 0,
    parkTimer: null,
    sessionTimer: null,
    torndown: false,
    pairState: null,
  };
}

/**
 * Wires up the message/pong/close/error handlers for a connection. Handlers
 * are attached before the caller hands the connection to the slot table, so
 * no frame the peer sends immediately on open is ever lost, whether the
 * connection ends up parked or paired.
 */
export function attachConnectionHandlers(conn: Conn, deps: ConnectionDeps): void {
  deps.metrics.onConnectionOpened();

  conn.socket.on('message', (data: RawData, isBinary: boolean) => {
    onMessage(conn, data, isBinary, deps);
  });

  conn.socket.on('pong', () => {
    conn.isAlive = true;
  });

  conn.socket.on('close', () => {
    deps.metrics.onConnectionClosed();
    deps.onClosed();
    deps.slotTable.handleClose(conn);
  });

  conn.socket.on('error', (error: Error) => {
    deps.logger.debug('socket error', { connId: conn.id, error: error.message });
    conn.socket.terminate();
  });
}

function onMessage(conn: Conn, data: RawData, isBinary: boolean, deps: ConnectionDeps): void {
  if (conn.state === 'paired' && conn.partner) {
    forward(conn, conn.partner, data, isBinary, deps);
    return;
  }

  if (conn.state === 'waiting') {
    const size = byteLengthOfRawData(data);
    if (conn.pendingBytes + size > deps.config.maxParkedBufferBytes) {
      // Counted as 'parked_overflow' (a single parked socket closed), not
      // 'backpressure' (a pair teardown), so /metricz never mixes units.
      // The wire close code and reason are unchanged.
      deps.metrics.onReject('parked_overflow');
      conn.socket.close(CLOSE_CODE.BACKPRESSURE, 'backpressure');
      return;
    }
    conn.pending.push({ data, isBinary });
    conn.pendingBytes += size;
  }
}

function forward(conn: Conn, partner: Conn, data: RawData, isBinary: boolean, deps: ConnectionDeps): void {
  if (partner.socket.readyState !== partner.socket.OPEN) return;

  // A byte-forwarder cannot drop frames without corrupting the Noise
  // stream, so a slow consumer tears the tunnel down instead of buffering
  // without limit.
  if (partner.socket.bufferedAmount > deps.config.maxBufferedBytes) {
    deps.slotTable.enforceGuardTeardown(conn, CLOSE_CODE.BACKPRESSURE, 'backpressure');
    return;
  }

  // Session-byte accounting reads the pair state cached on the connection
  // (set at pair time, cleared at teardown) instead of a per-frame slot
  // table lookup, keeping the hot path free of map hashing on a 64-char key.
  const size = byteLengthOfRawData(data);
  const pairState = conn.pairState;
  if (pairState) {
    pairState.sessionBytes += size;
    if (pairState.sessionBytes > deps.config.maxSessionBytes) {
      deps.slotTable.enforceGuardTeardown(conn, CLOSE_CODE.SESSION_BYTE_CAP, 'session_byte_cap');
      return;
    }
  }

  partner.socket.send(data, isBinary ? BINARY_SEND_OPTIONS : TEXT_SEND_OPTIONS);
  deps.metrics.onForward(size);
}
