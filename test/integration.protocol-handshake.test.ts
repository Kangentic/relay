/**
 * Proves the relay blindly forwards real @kangentic/protocol traffic: two
 * simulated peers complete an actual Noise handshake and round-trip a
 * capability verb through a real relay instance, communicating only via `ws`
 * clients over the public wire contract (`?slot=<hex>`, binary frames). The
 * relay never imports @kangentic/protocol itself; this is the one place in
 * the repo that does, as a devDependency, specifically to prove blindness
 * does not mean brokenness.
 *
 * Both handshake patterns the product performs are covered here, because
 * they put differently shaped bytes through different relay paths:
 *
 * - KK is the *reconnect* handshake, used once both peers already hold each
 *   other's pinned static keys. Both peers are connected before the first
 *   frame moves, so every frame takes the paired forwarding path.
 * - IKpsk0 is the *first-pairing* handshake, because on genuine first
 *   contact only the desktop's static public key has travelled out of band
 *   (by QR) and the phone's arrives in-band in message one, authenticated
 *   under the pairing token used as the Noise PSK. Its message one is
 *   larger than KK's (it carries that static key) and, mirroring the real
 *   ceremony, it is sent while the phone is still parked alone in the slot,
 *   so it travels the pre-pair buffer-and-flush path instead.
 *
 * The relay is blind to both, which is the whole point: the distinction
 * below is about what these tests prove, never about anything in `src/**`.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  generateX25519KeyPair,
  createKKHandshake,
  createPairingInitiatorHandshake,
  createPairingResponderHandshake,
  deriveSecretstreamPair,
  encodeMessage,
  decodeMessage,
  type CapabilityRequestMessage,
} from '@kangentic/protocol';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { connectTestClient, type TestClient } from './helpers/wsClient.js';

function randomSlot(): string {
  return nodeRandomBytes(32).toString('hex');
}

/**
 * Sends one frame and resolves only once the relay has provably handled it.
 *
 * Awaiting the send callback alone would prove only that the bytes left this
 * process, which does not order them against a second peer's connect: the
 * relay reading this socket and the relay accepting a new one are
 * independent event-loop events. So this follows the frame with a ping and
 * waits for the pong. A WebSocket server answers a ping automatically, and
 * `ws` parses frames off a single socket strictly in order, emitting
 * 'message' for one frame before it reaches the next frame's header. A pong
 * is therefore proof that the relay's message handler already ran for the
 * frame ahead of the ping. A lone parked peer that sends this way has its
 * frame in the pre-pair buffer before the caller connects anyone else.
 */
async function sendAndAwaitRelayHandled(client: TestClient, frame: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.socket.send(frame, (error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve) => {
    client.socket.once('pong', () => resolve());
    client.socket.ping();
  });
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

  it('completes a Noise IKpsk0 first pairing across the pre-pair buffer, blind to the relay', async () => {
    relay = await startTestRelay();

    // For a first-time pairing the slot id doubles as the handshake's
    // pre-shared key (README, "Honest metadata disclosure"), so mint one
    // 32-byte secret and use it as both, exactly as the QR payload does.
    const pairingToken = nodeRandomBytes(32);
    const slot = pairingToken.toString('hex');

    const phoneStatic = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();

    // Roles are the reverse of the KK case above: the phone initiates, and
    // the desktop responds without knowing the phone's static key yet. Only
    // the desktop's key travelled out of band, in the QR the phone scanned.
    const phoneHandshake = createPairingInitiatorHandshake({
      localStatic: phoneStatic,
      remoteStatic: desktopStatic.publicKey,
      pairingToken,
    });
    const desktopHandshake = createPairingResponderHandshake({
      localStatic: desktopStatic,
      pairingToken,
    });

    // Message 1: the phone parks alone in the slot and sends before its
    // partner exists, so the relay buffers the frame rather than forwarding
    // it. This is the path a real pairing takes, and the shape it puts
    // through that path is bigger than KK's: IKpsk0 message one carries the
    // initiator's static key.
    const phone = await connectTestClient(relay.url, slot);

    const message1 = phoneHandshake.writeMessage(new TextEncoder().encode('phone-device-name'));
    expect(message1.split).toBeUndefined();
    await sendAndAwaitRelayHandled(phone, Buffer.from(message1.message));

    // The pair of facts that pins this to the buffered path rather than the
    // live one. The pong above proves the relay has already handled the
    // frame; a forward counter still at zero proves it did not send it
    // anywhere. Handled but not forwarded means buffered. Reorder this test
    // so the desktop connects first and the frame takes the live path, and
    // this assertion goes red instead of passing for the wrong reason.
    expect(relay.metrics.snapshot().framesForwardedTotal).toBe(0);

    // Pairing flushes the buffered frame to the newcomer synchronously,
    // which is why connectTestClient queues messages from socket creation.
    const desktop = await connectTestClient(relay.url, slot);

    const frameAtDesktop1 = await desktop.nextMessage();
    expect(relay.metrics.snapshot().framesForwardedTotal).toBe(1);
    const readResult1 = desktopHandshake.readMessage(frameAtDesktop1.data as Buffer);
    expect(readResult1.split).toBeUndefined();
    expect(new TextDecoder().decode(readResult1.payload)).toBe('phone-device-name');

    // What IKpsk0 proves and KK cannot: the desktop learned the phone's
    // identity key in band, from the "s" token inside message 1, after that
    // message crossed the relay.
    const learnedPhoneStaticKey = desktopHandshake.getRemoteStaticKey();
    expect(learnedPhoneStaticKey).toBeDefined();
    expect(
      Buffer.from(learnedPhoneStaticKey ?? new Uint8Array()).equals(Buffer.from(phoneStatic.publicKey)),
    ).toBe(true);

    // Message 2: desktop (responder) -> phone (initiator), through the
    // relay. IKpsk0 is a two-message pattern like KK, so both sides can
    // split as soon as this message is written/read.
    const message2 = desktopHandshake.writeMessage(new Uint8Array(0));
    expect(message2.split).toBeDefined();
    desktop.send(Buffer.from(message2.message));

    const frameAtPhone2 = await phone.nextMessage();
    const readResult2 = phoneHandshake.readMessage(frameAtPhone2.data as Buffer);
    expect(readResult2.split).toBeDefined();

    // Read these only once both peers have processed every message in the
    // pattern: the chaining key is meaningful only after the pattern is
    // exhausted and the split has happened. Both getters hand back the
    // handshake's own arrays, so copy before comparing and deriving.
    const phoneChainingKey = Buffer.from(phoneHandshake.getChainingKey());
    const desktopChainingKey = Buffer.from(desktopHandshake.getChainingKey());
    expect(desktopChainingKey.equals(phoneChainingKey)).toBe(true);

    const phoneHandshakeHash = Buffer.from(phoneHandshake.getHandshakeHash());
    const desktopHandshakeHash = Buffer.from(desktopHandshake.getHandshakeHash());
    expect(desktopHandshakeHash.equals(phoneHandshakeHash)).toBe(true);

    // The phone is the initiator here, so its send stream pairs with the
    // desktop's receive stream. This is inverted from the KK case.
    const phoneStream = deriveSecretstreamPair(phoneChainingKey, true);
    const desktopStream = deriveSecretstreamPair(desktopChainingKey, false);

    const capabilityRequest: CapabilityRequestMessage = {
      type: 'capability-request',
      requestId: 'pairing-req-1',
      verb: 'read-board',
      payload: { boardId: 'board-1' },
    };
    const sealed = phoneStream.send.seal(encodeMessage(capabilityRequest));
    phone.send(Buffer.from(sealed));

    const frameAtDesktop2 = await desktop.nextMessage();
    const opened = desktopStream.receive.open(frameAtDesktop2.data as Buffer);
    const decoded = decodeMessage(opened.plaintext);

    expect(decoded).toEqual(capabilityRequest);

    phone.close();
    desktop.close();
  });
});
