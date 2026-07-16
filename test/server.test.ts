import { randomBytes } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';

function randomSlot(): string {
  return randomBytes(32).toString('hex');
}

describe('createRelay wire behavior', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('never negotiates permessage-deflate, even when the client offers it', async () => {
    relay = await startTestRelay();
    const slot = randomSlot();
    const socket = new NodeWebSocket(`${relay.url}?slot=${slot}`, { perMessageDeflate: true });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    // ws exposes the negotiated extensions; an empty record proves the
    // server rejected the client's permessage-deflate offer.
    expect(Object.keys(socket.extensions)).toHaveLength(0);
    socket.close();
  });

  it('still forwards byte-for-byte for a client that offered compression', async () => {
    relay = await startTestRelay();
    const slot = randomSlot();
    const offeringSocket = new NodeWebSocket(`${relay.url}?slot=${slot}`, { perMessageDeflate: true });
    await new Promise<void>((resolve, reject) => {
      offeringSocket.once('open', () => resolve());
      offeringSocket.once('error', reject);
    });
    const plainClient = await connectTestClient(relay.url, slot);

    offeringSocket.send(Buffer.from('ciphertext'));
    const received = await plainClient.nextMessage();
    expect((received.data as Buffer).toString()).toBe('ciphertext');

    offeringSocket.close();
    plainClient.close();
  });

  it('closes the sender with 1009 at the ws layer when a message exceeds MAX_MESSAGE_BYTES', async () => {
    relay = await startTestRelay({ maxMessageBytes: 1024 });
    const slot = randomSlot();
    const sender = await connectTestClient(relay.url, slot);
    const receiver = await connectTestClient(relay.url, slot);

    sender.send(Buffer.alloc(4096));

    const senderClose = await sender.nextClose();
    expect(senderClose.code).toBe(1009);

    // The oversized sender's close tears the partner down as peer-closed.
    const receiverClose = await receiver.nextClose();
    expect(receiverClose.code).toBe(4000);
  });
});
