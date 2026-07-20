import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { attachConnectionHandlers, createConn } from '../src/connection.js';
import { SlotTable } from '../src/rendezvous.js';
import { SlotConnectionCaps } from '../src/guards/caps.js';
import { createMetrics, type Metrics } from '../src/http/metrics.js';
import type { Logger } from '../src/logging.js';
import type { Config, Conn } from '../src/types.js';
import type { WebSocket } from 'ws';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CONNECTING = 0;
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
  ping = vi.fn();
}

interface Harness {
  readonly slotTable: SlotTable;
  readonly metrics: Metrics;
  connect(slot: string): { conn: Conn; socket: FakeSocket };
}

const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  slotRef: (slotId) => slotId,
};

function createHarness(
  configOverrides: Partial<Pick<Config, 'maxParkedBufferBytes' | 'maxBufferedBytes' | 'maxSessionBytes'>> = {},
  maxConnectionsPerSlot = 2,
): Harness {
  const metrics = createMetrics();
  const slotTable = new SlotTable({
    slotCaps: new SlotConnectionCaps(maxConnectionsPerSlot),
    metrics,
    logger: silentLogger,
    parkTimeoutMs: 60_000,
    maxSessionMs: 0,
  });
  const config = {
    maxParkedBufferBytes: 1_048_576,
    maxBufferedBytes: 4_194_304,
    maxSessionBytes: 1_073_741_824,
    ...configOverrides,
  };

  return {
    slotTable,
    metrics,
    connect: (slot: string) => {
      const socket = new FakeSocket();
      const conn = createConn(socket as unknown as WebSocket, slot, '127.0.0.1');
      attachConnectionHandlers(conn, { slotTable, metrics, logger: silentLogger, config, onClosed: () => {} });
      slotTable.handleConnection(conn);
      return { conn, socket };
    },
  };
}

const SLOT = 'a'.repeat(64);

describe('forwarding hot path', () => {
  it('forwards a paired frame to the partner unchanged and counts it', () => {
    const harness = createHarness();
    const a = harness.connect(SLOT);
    const b = harness.connect(SLOT);

    const frame = Buffer.from('opaque ciphertext bytes');
    a.socket.emit('message', frame, true);

    expect(b.socket.send).toHaveBeenCalledTimes(1);
    expect(b.socket.send).toHaveBeenCalledWith(frame, { binary: true });
    expect(harness.metrics.snapshot().framesForwardedTotal).toBe(1);
    expect(harness.metrics.snapshot().bytesForwardedTotal).toBe(frame.byteLength);
  });

  it('accounts session bytes on the cached pair state without a slot-table lookup', () => {
    const harness = createHarness();
    const a = harness.connect(SLOT);
    harness.connect(SLOT);

    a.socket.emit('message', Buffer.alloc(10), true);
    a.socket.emit('message', Buffer.alloc(5), true);

    expect(a.conn.pairState).not.toBeNull();
    expect(a.conn.pairState?.sessionBytes).toBe(15);
    expect(a.conn.pairState).toBe(a.conn.partner?.pairState);
  });

  it('tears both halves down with 4431 when the partner socket buffer exceeds MAX_BUFFERED_BYTES', () => {
    const harness = createHarness({ maxBufferedBytes: 1000 });
    const a = harness.connect(SLOT);
    const b = harness.connect(SLOT);

    b.socket.bufferedAmount = 1001;
    a.socket.emit('message', Buffer.alloc(8), true);

    expect(b.socket.send).not.toHaveBeenCalled();
    expect(a.socket.close).toHaveBeenCalledWith(4431, 'backpressure');
    expect(b.socket.close).toHaveBeenCalledWith(4431, 'backpressure');
    expect(harness.metrics.snapshot().rejectsByReason.backpressure).toBe(1);
    expect(a.conn.pairState).toBeNull();
    expect(b.conn.pairState).toBeNull();
  });

  it('tears both halves down with 4432 when the session byte cap is exceeded', () => {
    const harness = createHarness({ maxSessionBytes: 10 });
    const a = harness.connect(SLOT);
    const b = harness.connect(SLOT);

    a.socket.emit('message', Buffer.alloc(8), true);
    expect(b.socket.send).toHaveBeenCalledTimes(1);

    a.socket.emit('message', Buffer.alloc(8), true);
    expect(b.socket.send).toHaveBeenCalledTimes(1);
    expect(a.socket.close).toHaveBeenCalledWith(4432, 'session_byte_cap');
    expect(b.socket.close).toHaveBeenCalledWith(4432, 'session_byte_cap');
    expect(harness.metrics.snapshot().rejectsByReason.session_byte_cap).toBe(1);
  });

  it('drops nothing sent while parked below the cap, then flushes on pairing', () => {
    const harness = createHarness();
    const a = harness.connect(SLOT);

    const first = Buffer.from('first');
    const second = Buffer.from('second');
    a.socket.emit('message', first, true);
    a.socket.emit('message', second, true);

    const b = harness.connect(SLOT);
    expect(b.socket.send).toHaveBeenCalledTimes(2);
    expect(b.socket.send).toHaveBeenNthCalledWith(1, first, { binary: true });
    expect(b.socket.send).toHaveBeenNthCalledWith(2, second, { binary: true });
    expect(a.conn.pending).toHaveLength(0);
    expect(a.conn.pendingBytes).toBe(0);
  });

  it('closes a parked connection with 4431 when its buffered frames exceed MAX_PARKED_BUFFER_BYTES', () => {
    const harness = createHarness({ maxParkedBufferBytes: 100 });
    const a = harness.connect(SLOT);

    a.socket.emit('message', Buffer.alloc(60), true);
    a.socket.emit('message', Buffer.alloc(60), true);

    expect(a.socket.close).toHaveBeenCalledWith(4431, 'backpressure');
    expect(harness.metrics.snapshot().rejectsByReason.backpressure).toBe(1);
  });

  it('closes the partner with 4000 and counts a peer-closed teardown when one half closes', () => {
    const harness = createHarness();
    const a = harness.connect(SLOT);
    const b = harness.connect(SLOT);

    a.socket.readyState = 3; // CLOSED
    a.socket.emit('close');

    expect(b.socket.close).toHaveBeenCalledWith(4000, 'peer_closed');
    expect(harness.metrics.snapshot().peerClosedTotal).toBe(1);
    expect(a.conn.pairState).toBeNull();
    expect(b.conn.pairState).toBeNull();
  });
});

describe('stale teardown races against a re-paired slot', () => {
  // A ws close event can trail its teardown by up to ws's close timeout, so
  // a slot can re-pair (with a raised MAX_CONNECTIONS_PER_SLOT) while the
  // torn-down pair's sockets still linger in CLOSING. Nothing the old pair
  // does after that point may touch the new pair.

  it('a stale close from a torn-down pair leaves the new pair\'s slot entry and metrics untouched', () => {
    const harness = createHarness({ maxSessionBytes: 100 }, 4);
    const oldA = harness.connect(SLOT);
    const oldB = harness.connect(SLOT);

    // Trip the session byte cap: the guard tears the old pair down, but the
    // old sockets' close events have not fired yet.
    oldA.socket.emit('message', Buffer.alloc(128), true);
    expect(oldA.socket.close).toHaveBeenCalledWith(4432, 'session_byte_cap');
    expect(oldB.socket.close).toHaveBeenCalledWith(4432, 'session_byte_cap');
    expect(harness.metrics.snapshot().pairedSlots).toBe(0);

    // The slot re-pairs with two fresh connections.
    const newA = harness.connect(SLOT);
    const newB = harness.connect(SLOT);
    newA.socket.emit('message', Buffer.from('fresh'), true);
    expect(newB.socket.send).toHaveBeenCalledTimes(1);

    // The OLD socket's close event finally fires.
    oldA.socket.readyState = 3; // CLOSED
    oldA.socket.emit('close');

    expect(harness.metrics.snapshot().peerClosedTotal).toBe(0);
    expect(harness.metrics.snapshot().pairedSlots).toBe(1);
    expect(newA.conn.pairState).not.toBeNull();
    expect(newA.socket.close).not.toHaveBeenCalled();
    expect(newB.socket.close).not.toHaveBeenCalled();

    // The new pair's slot entry survived: it still forwards, and a fifth
    // connection is rejected busy instead of parking on a vacated slot.
    newA.socket.emit('message', Buffer.from('still here'), true);
    expect(newB.socket.send).toHaveBeenCalledTimes(2);
    const fifth = harness.connect(SLOT);
    expect(fifth.socket.close).toHaveBeenCalledWith(4409, 'slot_busy');
  });

  it('a guard trip from the torn-down pair closes only that pair, never the slot\'s new owner', () => {
    const harness = createHarness({ maxSessionBytes: 100, maxBufferedBytes: 1000 }, 4);
    const oldA = harness.connect(SLOT);
    const oldB = harness.connect(SLOT);

    oldA.socket.emit('message', Buffer.alloc(128), true);
    expect(oldA.socket.close).toHaveBeenCalledWith(4432, 'session_byte_cap');
    expect(oldB.socket.close).toHaveBeenCalledWith(4432, 'session_byte_cap');

    const newA = harness.connect(SLOT);
    const newB = harness.connect(SLOT);

    // A late frame from the orphaned old pair trips the backpressure guard
    // while the slot entry already belongs to the new pair.
    oldB.socket.bufferedAmount = 1001;
    oldA.socket.emit('message', Buffer.alloc(8), true);

    expect(newA.socket.close).not.toHaveBeenCalled();
    expect(newB.socket.close).not.toHaveBeenCalled();
    expect(newA.conn.pairState).not.toBeNull();
    expect(harness.metrics.snapshot().pairedSlots).toBe(1);
    // The no-op stale trip is not counted as a backpressure teardown.
    expect(harness.metrics.snapshot().rejectsByReason.backpressure).toBeUndefined();

    // The old pair's sockets were both closed by its own teardown; the new
    // pair keeps forwarding.
    expect(oldB.socket.send).not.toHaveBeenCalled();
    newA.socket.emit('message', Buffer.from('alive'), true);
    expect(newB.socket.send).toHaveBeenCalledTimes(1);
  });
});
