import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { createSlotTableHarness, READY_STATE } from './helpers/slotTableHarness.js';
import { startTestRelay } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';

/**
 * The security properties the rendezvous layer is claimed to hold, asserted
 * rather than reasoned about. Each test here corresponds to a guarantee in
 * docs/security-model.md; if one of these fails, that document is wrong.
 */

const SLOT = 'a'.repeat(64);
const OTHER_SLOT = 'b'.repeat(64);

describe('a third party cannot join an established pair', () => {
  it('rejects a third connection with 4409 and never routes a frame to it', () => {
    const harness = createSlotTableHarness();
    const first = harness.connect(SLOT);
    const second = harness.connect(SLOT);

    const rogue = harness.connect(SLOT);
    expect(rogue.socket.close).toHaveBeenCalledWith(4409, 'slot_busy');

    first.socket.emit('message', Buffer.from('for my partner'), true);
    second.socket.emit('message', Buffer.from('reply'), true);

    expect(rogue.socket.send).not.toHaveBeenCalled();
    expect(second.socket.send).toHaveBeenCalledTimes(1);
    expect(first.socket.send).toHaveBeenCalledTimes(1);
  });

  it('does not flush a parked peer\'s buffered frames to a rejected third party', () => {
    const harness = createSlotTableHarness();
    const parked = harness.connect(SLOT);
    parked.socket.emit('message', Buffer.from('handshake message one'), true);

    const partner = harness.connect(SLOT);
    expect(partner.socket.send).toHaveBeenCalledTimes(1);

    const rogue = harness.connect(SLOT);
    expect(rogue.socket.close).toHaveBeenCalledWith(4409, 'slot_busy');
    expect(rogue.socket.send).not.toHaveBeenCalled();
  });
});

describe('a rogue that squats a freed slot cannot reach the surviving peer', () => {
  // This is the audit's central verified negative. When one half of a pair
  // closes, the slot entry is removed immediately while the survivor's socket
  // is still finishing its close handshake, so a rogue holding the slot id can
  // park on it during that window. It must not be able to reach the survivor.

  it('drops the survivor\'s frames rather than misrouting them to the squatter', () => {
    const harness = createSlotTableHarness();
    const leaving = harness.connect(SLOT);
    const survivor = harness.connect(SLOT);

    // One half closes. The slot entry is freed synchronously; the survivor has
    // been sent a 4000 but its socket has not finished closing yet.
    leaving.socket.readyState = READY_STATE.CLOSED;
    leaving.socket.emit('close');
    expect(survivor.socket.close).toHaveBeenCalledWith(4000, 'peer_closed');
    survivor.socket.readyState = READY_STATE.CLOSING;

    // A rogue claims the freed slot inside that window and parks.
    const squatter = harness.connect(SLOT);
    expect(squatter.socket.close).not.toHaveBeenCalled();

    // The survivor is still in the 'paired' state pointing at its dead partner,
    // so anything it sends must go nowhere at all.
    survivor.socket.emit('message', Buffer.from('secret to my real partner'), true);

    expect(squatter.socket.send).not.toHaveBeenCalled();
    expect(leaving.socket.send).not.toHaveBeenCalled();
  });

  it('does not deliver the squatter\'s frames to the surviving peer', () => {
    const harness = createSlotTableHarness();
    const leaving = harness.connect(SLOT);
    const survivor = harness.connect(SLOT);

    leaving.socket.readyState = READY_STATE.CLOSED;
    leaving.socket.emit('close');
    survivor.socket.readyState = READY_STATE.CLOSING;

    const squatter = harness.connect(SLOT);
    squatter.socket.emit('message', Buffer.from('injected'), true);

    // The squatter is merely parked, waiting for a partner of its own.
    expect(survivor.socket.send).not.toHaveBeenCalled();
    expect(squatter.conn.state).toBe('waiting');
    expect(squatter.conn.pending).toHaveLength(1);
  });

  it('a late close from the departed pair does not evict the squatter', () => {
    const harness = createSlotTableHarness();
    const leaving = harness.connect(SLOT);
    const survivor = harness.connect(SLOT);

    leaving.socket.readyState = READY_STATE.CLOSED;
    leaving.socket.emit('close');

    const squatter = harness.connect(SLOT);

    // The survivor's own close finally lands, long after the slot moved on.
    survivor.socket.readyState = READY_STATE.CLOSED;
    survivor.socket.emit('close');

    expect(squatter.socket.close).not.toHaveBeenCalled();
    expect(squatter.conn.torndown).toBe(false);
  });
});

describe('slot matching is exact', () => {
  it('does not pair two slots that differ by a single character', () => {
    const harness = createSlotTableHarness();
    const first = harness.connect(SLOT);
    const nearMiss = harness.connect(`${'a'.repeat(63)}b`);

    first.socket.emit('message', Buffer.from('hello'), true);

    expect(nearMiss.socket.send).not.toHaveBeenCalled();
    expect(first.conn.state).toBe('waiting');
    expect(nearMiss.conn.state).toBe('waiting');
  });

  it('does not pair a prefix of another live slot', () => {
    const harness = createSlotTableHarness();
    const full = harness.connect(SLOT);
    const prefix = harness.connect('a'.repeat(32));

    full.socket.emit('message', Buffer.from('hello'), true);

    expect(prefix.socket.send).not.toHaveBeenCalled();
    expect(full.conn.state).toBe('waiting');
  });

  it('keeps separate slots fully isolated', () => {
    const harness = createSlotTableHarness();
    const firstPairA = harness.connect(SLOT);
    const firstPairB = harness.connect(SLOT);
    const secondPairA = harness.connect(OTHER_SLOT);
    const secondPairB = harness.connect(OTHER_SLOT);

    firstPairA.socket.emit('message', Buffer.from('only for slot a'), true);

    expect(firstPairB.socket.send).toHaveBeenCalledTimes(1);
    expect(secondPairA.socket.send).not.toHaveBeenCalled();
    expect(secondPairB.socket.send).not.toHaveBeenCalled();
  });
});

describe('an unpaired connection does not wait forever', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a parked connection with 4408 once PARK_TIMEOUT_MS elapses', () => {
    const harness = createSlotTableHarness({}, 2, 1_000);
    const parked = harness.connect(SLOT);
    expect(parked.socket.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_001);

    expect(parked.socket.close).toHaveBeenCalledWith(4408, 'park_timeout');
    expect(harness.metrics.snapshot().rejectsByReason.park_timeout).toBe(1);
    expect(harness.metrics.snapshot().waitingSlots).toBe(0);
  });

  it('does not fire the park timer once the connection has paired', () => {
    const harness = createSlotTableHarness({}, 2, 1_000);
    const first = harness.connect(SLOT);
    const second = harness.connect(SLOT);

    vi.advanceTimersByTime(5_000);

    expect(first.socket.close).not.toHaveBeenCalled();
    expect(second.socket.close).not.toHaveBeenCalled();
    expect(harness.metrics.snapshot().rejectsByReason.park_timeout).toBeUndefined();
  });

  it('a park timeout does not disturb a slot that has already been re-parked', () => {
    const harness = createSlotTableHarness({}, 2, 1_000);
    const first = harness.connect(SLOT);

    // The first parker goes away, and a new one takes the slot immediately.
    first.socket.readyState = READY_STATE.CLOSED;
    first.socket.emit('close');
    const replacement = harness.connect(SLOT);

    vi.advanceTimersByTime(1_001);

    // Only the replacement's own timer should have any effect on the entry.
    expect(replacement.socket.close).toHaveBeenCalledWith(4408, 'park_timeout');
  });
});

describe('wire-level pairing behavior', () => {
  it('denies an admission-rejected client with 4403 after the handshake', async () => {
    const relay = await startTestRelay(
      {},
      {
        admissionPolicy: {
          admit: () => ({ allow: false, closeCode: 4403, reason: 'no_entitlement' }),
        },
      },
    );
    try {
      const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const client = new NodeWebSocket(`${relay.url}?slot=${SLOT}`);
        client.once('close', (code: number, reasonBuffer: Buffer) =>
          resolve({ code, reason: reasonBuffer.toString() }),
        );
        client.once('error', reject);
      });
      expect(closed.code).toBe(4403);
      expect(closed.reason).toBe('no_entitlement');
    } finally {
      await relay.close();
    }
  });

  it('gives a real client the 4409 close code on an occupied slot', async () => {
    const relay = await startTestRelay();
    try {
      const first = await connectTestClient(relay.url, SLOT);
      const second = await connectTestClient(relay.url, SLOT);
      const third = await connectTestClient(relay.url, SLOT);

      const closed = await third.nextClose();
      expect(closed.code).toBe(4409);
      expect(closed.reason).toBe('slot_busy');

      first.close();
      second.close();
    } finally {
      await relay.close();
    }
  });
});
