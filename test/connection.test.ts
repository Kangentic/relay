import { describe, it, expect } from 'vitest';
import {
  createSlotTableHarness as createHarness,
  READY_STATE,
  type ByteCapOverrides,
  type SlotTableHarness as Harness,
} from './helpers/slotTableHarness.js';

export type { ByteCapOverrides, Harness };

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

  it('charges pre-pair flushed frames against the session byte cap', () => {
    // Flushing outside the accounting would hand every session a free
    // MAX_PARKED_BUFFER_BYTES that neither the session cap nor backpressure
    // ever sees.
    const harness = createHarness({ maxSessionBytes: 10, maxParkedBufferBytes: 1_000 });
    const a = harness.connect(SLOT);

    a.socket.emit('message', Buffer.alloc(8), true);
    a.socket.emit('message', Buffer.alloc(8), true);
    expect(a.conn.pendingBytes).toBe(16);

    const b = harness.connect(SLOT);

    // The first flushed frame fits under the cap, the second trips it, and the
    // pair is torn down instead of the bytes passing uncounted.
    expect(b.socket.send).toHaveBeenCalledTimes(1);
    expect(a.socket.close).toHaveBeenCalledWith(4432, 'session_byte_cap');
    expect(b.socket.close).toHaveBeenCalledWith(4432, 'session_byte_cap');
    expect(harness.metrics.snapshot().rejectsByReason.session_byte_cap).toBe(1);
  });

  it('applies backpressure teardown to the pre-pair flush, not just the live path', () => {
    const harness = createHarness({ maxBufferedBytes: 10, maxParkedBufferBytes: 1_000 });
    const a = harness.connect(SLOT);
    a.socket.emit('message', Buffer.alloc(8), true);

    // The newcomer's send buffer is already past the ceiling when it pairs, so
    // the flush must tear down rather than pile more onto a stalled consumer.
    const b = harness.connect(SLOT, 5_000);

    expect(b.socket.send).not.toHaveBeenCalled();
    expect(a.socket.close).toHaveBeenCalledWith(4431, 'backpressure');
    expect(b.socket.close).toHaveBeenCalledWith(4431, 'backpressure');
    expect(harness.metrics.snapshot().rejectsByReason.backpressure).toBe(1);
  });

  it('closes a parked connection with 4431 when its buffered frames exceed MAX_PARKED_BUFFER_BYTES', () => {
    const harness = createHarness({ maxParkedBufferBytes: 100 });
    const a = harness.connect(SLOT);

    a.socket.emit('message', Buffer.alloc(60), true);
    a.socket.emit('message', Buffer.alloc(60), true);

    expect(a.socket.close).toHaveBeenCalledWith(4431, 'backpressure');
    expect(harness.metrics.snapshot().rejectsByReason.parked_overflow).toBe(1);
    expect(harness.metrics.snapshot().rejectsByReason.backpressure).toBeUndefined();
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

describe('per-slot cap accounting', () => {
  it('a rejected third connection does not release a reservation it never held', () => {
    // Releasing unconditionally on close would let each rejected probe
    // decrement the live pair's reservation, walking the per-slot count to
    // zero while both real peers are still connected.
    const harness = createHarness();
    const a = harness.connect(SLOT);
    const b = harness.connect(SLOT);
    expect(a.conn.slotReserved).toBe(true);
    expect(b.conn.slotReserved).toBe(true);

    for (let probe = 0; probe < 3; probe += 1) {
      const rejected = harness.connect(SLOT);
      expect(rejected.socket.close).toHaveBeenCalledWith(4409, 'slot_busy');
      expect(rejected.conn.slotReserved).toBe(false);
      rejected.socket.readyState = 3; // CLOSED
      rejected.socket.emit('close');
    }

    // The pair still owns both reservations, so a fourth arrival is still
    // rejected rather than slipping into a slot the counter thinks is free.
    const fourth = harness.connect(SLOT);
    expect(fourth.socket.close).toHaveBeenCalledWith(4409, 'slot_busy');
    expect(harness.slotCaps.tryReserve(SLOT)).toBe(false);
  });

  it('returns the reservation of a parked peer overwritten while its close was still pending', () => {
    // The stale-entry overwrite path: a parked peer's socket dies, a newcomer
    // takes the slot before the corpse's close event fires, and both hold a
    // reservation at once. If the corpse's close did not give its own back,
    // the slot would stay permanently one reservation short.
    const harness = createHarness();
    const stale = harness.connect(SLOT);
    expect(stale.conn.slotReserved).toBe(true);

    stale.socket.readyState = READY_STATE.CLOSING;
    const replacement = harness.connect(SLOT);
    expect(replacement.conn.state).toBe('waiting');
    expect(replacement.socket.close).not.toHaveBeenCalled();

    stale.socket.readyState = READY_STATE.CLOSED;
    stale.socket.emit('close');

    expect(stale.conn.slotReserved).toBe(false);
    expect(replacement.conn.slotReserved).toBe(true);

    // The freed capacity is real: a partner can still pair with the replacement.
    const partner = harness.connect(SLOT);
    expect(partner.socket.close).not.toHaveBeenCalled();
    expect(replacement.conn.state).toBe('paired');

    // And once that pair goes away the slot is fully released, not leaked.
    for (const half of [replacement, partner]) {
      half.socket.readyState = READY_STATE.CLOSED;
      half.socket.emit('close');
    }
    expect(harness.slotCaps.tryReserve(SLOT)).toBe(true);
    expect(harness.slotCaps.tryReserve(SLOT)).toBe(true);
    expect(harness.slotCaps.tryReserve(SLOT)).toBe(false);
  });

  it('releases the reservation once, even if close fires twice', () => {
    const harness = createHarness();
    const a = harness.connect(SLOT);
    expect(harness.slotCaps.tryReserve(SLOT)).toBe(true);
    harness.slotCaps.release(SLOT);

    a.socket.readyState = 3; // CLOSED
    a.socket.emit('close');
    a.socket.emit('close');

    expect(a.conn.slotReserved).toBe(false);
    // One slot's worth was returned, not two.
    expect(harness.slotCaps.tryReserve(SLOT)).toBe(true);
    expect(harness.slotCaps.tryReserve(SLOT)).toBe(true);
    expect(harness.slotCaps.tryReserve(SLOT)).toBe(false);
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
