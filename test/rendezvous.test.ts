import { randomBytes } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';

function randomSlot(): string {
  return randomBytes(32).toString('hex');
}

describe('rendezvous', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('pairs two connections on the same slot and forwards binary frames both directions', async () => {
    relay = await startTestRelay();
    const slot = randomSlot();
    const a = await connectTestClient(relay.url, slot);
    const b = await connectTestClient(relay.url, slot);

    a.send(Buffer.from('hello from a'));
    const messageAtB = await b.nextMessage();
    expect((messageAtB.data as Buffer).toString()).toBe('hello from a');
    expect(messageAtB.isBinary).toBe(true);

    b.send(Buffer.from('hello from b'));
    const messageAtA = await a.nextMessage();
    expect((messageAtA.data as Buffer).toString()).toBe('hello from b');

    a.close();
    b.close();
  });

  it('buffers frames sent by a parked peer before its partner arrives', async () => {
    relay = await startTestRelay();
    const slot = randomSlot();
    const a = await connectTestClient(relay.url, slot);
    a.send(Buffer.from('sent while parked'));

    const b = await connectTestClient(relay.url, slot);
    const messageAtB = await b.nextMessage();
    expect((messageAtB.data as Buffer).toString()).toBe('sent while parked');

    a.close();
    b.close();
  });

  it('rejects a third connection to an already-paired slot with 4409', async () => {
    relay = await startTestRelay();
    const slot = randomSlot();
    const a = await connectTestClient(relay.url, slot);
    const b = await connectTestClient(relay.url, slot);
    const c = await connectTestClient(relay.url, slot);

    const closeEvent = await c.nextClose();
    expect(closeEvent.code).toBe(4409);

    a.close();
    b.close();
  });

  it('reaps a ghost incumbent that fails the contention probe, freeing the slot', async () => {
    // The roaming-phone case end to end: one half of a pair stops answering
    // without ever sending a FIN, so its socket still reads OPEN. Contending
    // the slot makes the relay ask, and the silent half is reaped in a probe
    // window instead of a full ping cycle.
    // 500ms, not a tighter window: the ghost never pongs at any length, so
    // this only sets how long the healthy survivor has to answer over
    // loopback. A window measured in tens of milliseconds would let a busy
    // CI worker evict the survivor too, and the assertions below would fail
    // for a reason that has nothing to do with the behaviour under test.
    relay = await startTestRelay({ contentionProbeTimeoutMs: 500 });
    const slot = randomSlot();
    const ghost = await connectTestClient(relay.url, slot);
    const survivor = await connectTestClient(relay.url, slot);

    // Register the waiter before triggering, never after: nextClose() attaches
    // its listener lazily, so a close that already fired is never redelivered.
    const survivorClosed = survivor.nextClose();

    // pause() stops ws parsing inbound frames, so the relay's ping is never
    // answered. That is what a half-open socket looks like from the relay.
    ghost.socket.pause();

    const contender = await connectTestClient(relay.url, slot);
    expect((await contender.nextClose()).code).toBe(4409);
    expect((await survivorClosed).code).toBe(4000);

    // The slot is genuinely free again, reservations included.
    const rejoinedFirst = await connectTestClient(relay.url, slot);
    const rejoinedSecond = await connectTestClient(relay.url, slot);
    rejoinedFirst.send(Buffer.from('re-paired'));
    const messageAtSecond = await rejoinedSecond.nextMessage();
    expect((messageAtSecond.data as Buffer).toString()).toBe('re-paired');

    expect(relay.metrics.snapshot().rejectsByReason.probe_evicted).toBe(1);

    ghost.socket.terminate();
    rejoinedFirst.close();
    rejoinedSecond.close();
  });

  it('disarms an armed contention probe when the relay shuts down', async () => {
    // Covers the wiring in createRelay's close(), not SlotTable's method in
    // isolation: a probe left armed across the graceful sweep would
    // terminate() sockets the shutdown path is already closing politely.
    // Deliberately not assigned to `relay`, since this test drives close()
    // itself and a second close() from afterEach would reject.
    // A 6x margin between the probe window and the wait below. Too narrow a
    // margin and a delayed timer on a loaded worker lets this pass with the
    // wiring removed, which is the one way it could silently stop guarding.
    const shuttingDown = await startTestRelay({ contentionProbeTimeoutMs: 150 });
    const slot = randomSlot();

    // Both halves stop reading. Neither answers the probe and neither
    // completes the 1001 handshake, so the paired slot entry outlives the
    // sweep and a surviving probe really would reach it.
    const first = await connectTestClient(shuttingDown.url, slot);
    const second = await connectTestClient(shuttingDown.url, slot);
    first.socket.pause();
    second.socket.pause();

    const contender = await connectTestClient(shuttingDown.url, slot);
    expect((await contender.nextClose()).code).toBe(4409);

    const closed = shuttingDown.close();
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(shuttingDown.metrics.snapshot().rejectsByReason.probe_evicted).toBeUndefined();

    // Let the drain finish: the two paused clients are the only thing the
    // WebSocketServer is still waiting on.
    first.socket.terminate();
    second.socket.terminate();
    await closed;
  });

  it('frees the slot when a parked connection closes before a partner arrives', async () => {
    relay = await startTestRelay();
    const slot = randomSlot();
    const a = await connectTestClient(relay.url, slot);
    a.close();
    await a.nextClose();

    const b = await connectTestClient(relay.url, slot);
    const c = await connectTestClient(relay.url, slot);
    b.send(Buffer.from('ping'));
    const messageAtC = await c.nextMessage();
    expect((messageAtC.data as Buffer).toString()).toBe('ping');

    b.close();
    c.close();
  });

  it('tears down the partner when one half of a pair closes', async () => {
    relay = await startTestRelay();
    const slot = randomSlot();
    const a = await connectTestClient(relay.url, slot);
    const b = await connectTestClient(relay.url, slot);

    a.close();
    const closeEvent = await b.nextClose();
    expect(closeEvent.code).toBe(4000);
  });

  it('rejects a connection with no slot query param before it can open', async () => {
    relay = await startTestRelay();
    const socket = new NodeWebSocket(relay.url);
    const outcome = await new Promise<'error' | 'open'>((resolve) => {
      socket.once('open', () => resolve('open'));
      socket.once('error', () => resolve('error'));
    });
    expect(outcome).toBe('error');
  });
});
