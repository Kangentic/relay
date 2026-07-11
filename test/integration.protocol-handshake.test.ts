/**
 * Proves the relay blindly forwards real @kangentic/protocol traffic: two
 * simulated peers (a "desktop" KK initiator and a "phone" KK responder)
 * complete an actual Noise KK handshake and round-trip a capability verb
 * through a real relay instance, communicating only via `ws` clients over
 * the public wire contract (`?slot=<hex>`, binary frames). The relay never
 * imports @kangentic/protocol itself; this is the one place in the repo
 * that does, as a devDependency, specifically to prove blindness does not
 * mean brokenness.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  generateX25519KeyPair,
  createKKHandshake,
  deriveSecretstreamPair,
  encodeMessage,
  decodeMessage,
  type CapabilityRequestMessage,
} from '@kangentic/protocol';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';

function randomSlot(): string {
  return nodeRandomBytes(32).toString('hex');
}

describe('real @kangentic/protocol handshake through the relay', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('completes a Noise KK handshake and round-trips a capability verb, blind to the relay', async () => {
    relay = await startTestRelay();
    const slot = randomSlot();

    const desktopStatic = generateX25519KeyPair();
    const phoneStatic = generateX25519KeyPair();

    const desktopHandshake = createKKHandshake({
      initiator: true,
      localStatic: desktopStatic,
      remoteStatic: phoneStatic.publicKey,
    });
    const phoneHandshake = createKKHandshake({
      initiator: false,
      localStatic: phoneStatic,
      remoteStatic: desktopStatic.publicKey,
    });

    const desktop = await connectTestClient(relay.url, slot);
    const phone = await connectTestClient(relay.url, slot);

    // Message 1: desktop (initiator) -> phone (responder), through the relay.
    const message1 = desktopHandshake.writeMessage(new Uint8Array(0));
    expect(message1.split).toBeUndefined();
    desktop.send(Buffer.from(message1.message));

    const frameAtPhone1 = await phone.nextMessage();
    const readResult1 = phoneHandshake.readMessage(frameAtPhone1.data as Buffer);
    expect(readResult1.split).toBeUndefined();

    // Message 2: phone (responder) -> desktop (initiator), through the relay.
    // KK is a two-message pattern, so both sides can split into a
    // CipherState pair as soon as this message is written/read.
    const message2 = phoneHandshake.writeMessage(new Uint8Array(0));
    expect(message2.split).toBeDefined();
    phone.send(Buffer.from(message2.message));

    const frameAtDesktop2 = await desktop.nextMessage();
    const readResult2 = desktopHandshake.readMessage(frameAtDesktop2.data as Buffer);
    expect(readResult2.split).toBeDefined();

    const desktopChainingKey = desktopHandshake.getChainingKey();
    const phoneChainingKey = phoneHandshake.getChainingKey();
    expect(Buffer.from(desktopChainingKey).equals(Buffer.from(phoneChainingKey))).toBe(true);

    const desktopStream = deriveSecretstreamPair(desktopChainingKey, true);
    const phoneStream = deriveSecretstreamPair(phoneChainingKey, false);

    const capabilityRequest: CapabilityRequestMessage = {
      type: 'capability-request',
      requestId: 'req-1',
      verb: 'read-board',
      payload: { boardId: 'board-1' },
    };
    const sealed = desktopStream.send.seal(encodeMessage(capabilityRequest));
    desktop.send(Buffer.from(sealed));

    const frameAtPhone2 = await phone.nextMessage();
    const opened = phoneStream.receive.open(frameAtPhone2.data as Buffer);
    const decoded = decodeMessage(opened.plaintext);

    expect(decoded).toEqual(capabilityRequest);

    desktop.close();
    phone.close();
  });
});
