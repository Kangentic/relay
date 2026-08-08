import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSlotTableHarness, READY_STATE, type SlotTableHarness } from './helpers/slotTableHarness.js';
import { startKeepalive } from '../src/keepalive.js';

const SLOT = 'a'.repeat(64);
const OTHER_SLOT = 'b'.repeat(64);
const PROBE_MS = 2_000;

/**
 * A FakeSocket that never emits 'pong' is exactly a half-open socket as far as
 * the relay can observe one: a dead TCP peer with no FIN still reads OPEN and
 * still accepts a ping() that goes nowhere. So these tests drive the state
 * machine directly rather than trying to manufacture a real half-open TCP
 * connection, which would be platform-dependent and flaky.
 */
function pairedHarness(contentionProbeTimeoutMs = PROBE_MS): {
  harness: SlotTableHarness;
  first: ReturnType<SlotTableHarness['connect']>;
  second: ReturnType<SlotTableHarness['connect']>;
} {
  const harness = createSlotTableHarness({}, 2, 60_000, contentionProbeTimeoutMs);
  const first = harness.connect(SLOT);
  const second = harness.connect(SLOT);
  return { harness, first, second };
}

describe('contention probe on a paired slot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('still rejects the newcomer with 4409, and pings both incumbents', () => {
    const { harness, first, second } = pairedHarness();

    const newcomer = harness.connect(SLOT);

    expect(newcomer.socket.close).toHaveBeenCalledWith(4409, 'slot_busy');
    expect(first.socket.ping).toHaveBeenCalledTimes(1);
    expect(second.socket.ping).toHaveBeenCalledTimes(1);
    expect(harness.metrics.snapshot().rejectsByReason.slot_busy).toBe(1);
  });

  it('terminates the half that never pongs and leaves the half that does', () => {
    const { harness, first, second } = pairedHarness();
    harness.connect(SLOT);

    // The desktop answers; the roamed phone's half-open socket does not.
    second.socket.emit('pong');
    vi.advanceTimersByTime(PROBE_MS);

    expect(first.socket.terminate).toHaveBeenCalledTimes(1);
    expect(second.socket.terminate).not.toHaveBeenCalled();
  });

  it('closes the survivor with peer_closed once the evicted half closes', () => {
    const { harness, first, second } = pairedHarness();
    harness.connect(SLOT);

    second.socket.emit('pong');
    vi.advanceTimersByTime(PROBE_MS);

    // terminate() does no slot-table work itself; cleanup runs through the
    // socket's close event, which is the same path today's keepalive reap
    // takes a full ping cycle later.
    first.socket.readyState = READY_STATE.CLOSED;
    first.socket.emit('close');

    expect(second.socket.close).toHaveBeenCalledWith(4000, 'peer_closed');
  });

  it('evicts nobody when both incumbents pong', () => {
    const { harness, first, second } = pairedHarness();
    harness.connect(SLOT);

    first.socket.emit('pong');
    second.socket.emit('pong');
    vi.advanceTimersByTime(PROBE_MS);

    expect(first.socket.terminate).not.toHaveBeenCalled();
    expect(second.socket.terminate).not.toHaveBeenCalled();
    const snapshot = harness.metrics.snapshot();
    expect(snapshot.pongTimeoutsTotal).toBe(0);
    expect(snapshot.rejectsByReason.probe_evicted).toBeUndefined();
  });

  it('runs at most one probe per slot however often the newcomer retries', () => {
    const { harness, first, second } = pairedHarness();

    // A rejected client retries on its own backoff; each dial must not arm a
    // fresh timer, or a flapping peer would ping the incumbents continuously.
    harness.connect(SLOT);
    harness.connect(SLOT);
    harness.connect(SLOT);

    expect(first.socket.ping).toHaveBeenCalledTimes(1);
    expect(second.socket.ping).toHaveBeenCalledTimes(1);
  });

  it('arms a fresh probe once the previous window has elapsed', () => {
    const { harness, first, second } = pairedHarness();

    harness.connect(SLOT);
    first.socket.emit('pong');
    second.socket.emit('pong');
    vi.advanceTimersByTime(PROBE_MS);

    harness.connect(SLOT);

    expect(first.socket.ping).toHaveBeenCalledTimes(2);
  });

  it('does not reach a pair that replaced the one it probed', () => {
    const { harness, first, second } = pairedHarness();
    harness.connect(SLOT);

    // The probed pair goes away and the slot re-pairs inside the window.
    first.socket.readyState = READY_STATE.CLOSED;
    first.socket.emit('close');
    second.socket.readyState = READY_STATE.CLOSED;
    second.socket.emit('close');
    const replacementFirst = harness.connect(SLOT);
    const replacementSecond = harness.connect(SLOT);

    vi.advanceTimersByTime(PROBE_MS);

    expect(replacementFirst.socket.terminate).not.toHaveBeenCalled();
    expect(replacementSecond.socket.terminate).not.toHaveBeenCalled();
    expect(harness.metrics.snapshot().rejectsByReason.probe_evicted).toBeUndefined();
  });

  it('counts one pong timeout and one probe_evicted per evicted half', () => {
    const { harness, first, second } = pairedHarness();
    harness.connect(SLOT);

    // Neither answers: both halves of this pair are gone.
    vi.advanceTimersByTime(PROBE_MS);

    expect(first.socket.terminate).toHaveBeenCalledTimes(1);
    expect(second.socket.terminate).toHaveBeenCalledTimes(1);
    const snapshot = harness.metrics.snapshot();
    expect(snapshot.pongTimeoutsTotal).toBe(2);
    expect(snapshot.rejectsByReason.probe_evicted).toBe(2);
  });

  it('skips an incumbent whose socket is no longer OPEN', () => {
    const { harness, first, second } = pairedHarness();

    first.socket.readyState = READY_STATE.CLOSING;
    harness.connect(SLOT);

    expect(first.socket.ping).not.toHaveBeenCalled();
    expect(second.socket.ping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PROBE_MS);

    expect(first.socket.terminate).not.toHaveBeenCalled();
    expect(second.socket.terminate).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when the probe is disabled', () => {
    const { harness, first, second } = pairedHarness(0);

    const newcomer = harness.connect(SLOT);
    vi.advanceTimersByTime(PROBE_MS * 10);

    expect(newcomer.socket.close).toHaveBeenCalledWith(4409, 'slot_busy');
    expect(first.socket.ping).not.toHaveBeenCalled();
    expect(second.socket.ping).not.toHaveBeenCalled();
    expect(first.socket.terminate).not.toHaveBeenCalled();
    expect(second.socket.terminate).not.toHaveBeenCalled();
  });

  it('probes only the contended slot', () => {
    const harness = createSlotTableHarness({}, 2, 60_000, PROBE_MS);
    harness.connect(SLOT);
    harness.connect(SLOT);
    const bystander = harness.connect(OTHER_SLOT);

    harness.connect(SLOT);

    expect(bystander.socket.ping).not.toHaveBeenCalled();
  });

  it('cancels in-flight probes on stopContentionProbes', () => {
    const { harness, first, second } = pairedHarness();
    harness.connect(SLOT);

    harness.slotTable.stopContentionProbes();
    vi.advanceTimersByTime(PROBE_MS);

    expect(first.socket.terminate).not.toHaveBeenCalled();
    expect(second.socket.terminate).not.toHaveBeenCalled();
  });

  it('releases probePending when a probed connection is torn down', () => {
    const { harness, first, second } = pairedHarness();
    harness.connect(SLOT);
    expect(first.conn.probePending).toBe(true);

    // The survivor's close can land before the probe deadline, since evicting
    // the ghost cascades into a peer_closed for it.
    first.socket.readyState = READY_STATE.CLOSED;
    first.socket.emit('close');
    second.socket.readyState = READY_STATE.CLOSED;
    second.socket.emit('close');

    expect(first.conn.probePending).toBe(false);
    expect(second.conn.probePending).toBe(false);

    vi.advanceTimersByTime(PROBE_MS);
    expect(first.socket.terminate).not.toHaveBeenCalled();
    expect(second.socket.terminate).not.toHaveBeenCalled();
  });

  it('leaves isAlive to the keepalive loop', () => {
    // The two flags have different owners and different clocks. A probe that
    // wrote isAlive would race the reaper: it could rescue a genuinely dead
    // socket, or condemn a healthy one that simply had not been pinged yet.
    const { harness, first, second } = pairedHarness();
    const keepalive = startKeepalive(new Set([first.conn, second.conn]), {
      metrics: harness.metrics,
      pingIntervalMs: 30_000,
    });

    // Mid-keepalive-cycle: pinged, pong not yet back.
    first.conn.isAlive = false;
    second.conn.isAlive = false;

    harness.connect(SLOT);
    first.socket.emit('pong');
    second.socket.emit('pong');

    expect(first.conn.isAlive).toBe(true);
    expect(first.conn.probePending).toBe(false);

    vi.advanceTimersByTime(PROBE_MS);
    expect(first.socket.terminate).not.toHaveBeenCalled();

    // The pong that satisfied the probe also satisfied the keepalive loop,
    // so the next tick pings rather than reaps.
    vi.advanceTimersByTime(30_000);
    expect(first.socket.terminate).not.toHaveBeenCalled();

    keepalive.stop();
  });
});
