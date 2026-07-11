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
