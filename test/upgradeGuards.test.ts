import { connect as connectTcp } from 'node:net';
import { describe, it, expect } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { startTestRelay } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';
import { CLOSE_CODE } from '../src/closeCodes.js';
import type { AdmissionPolicy } from '../src/admission.js';
import type { Logger } from '../src/logging.js';

type UpgradeOutcome = { readonly opened: true } | { readonly opened: false; readonly status: number };

/**
 * Attempts a WebSocket upgrade and reports whether it completed or which HTTP
 * status rejected it. Every pre-upgrade guard answers with a raw HTTP status
 * rather than a close code, so this is the only way to observe the guard
 * ladder from the wire, which is where its ordering actually matters.
 */
function attemptUpgrade(relayUrl: string, query: string): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    const socket = new NodeWebSocket(`${relayUrl}${query}`);
    let settled = false;

    socket.once('open', () => {
      settled = true;
      socket.close();
      resolve({ opened: true });
    });
    socket.once('unexpected-response', (_request, response) => {
      settled = true;
      socket.terminate();
      response.resume();
      resolve({ opened: false, status: response.statusCode ?? 0 });
    });
    socket.once('error', (error: Error) => {
      if (!settled) reject(error);
    });
  });
}

/**
 * Drives a raw upgrade that `ws` refuses without ever invoking its completion
 * callback - here by omitting Sec-WebSocket-Key. Node emits 'upgrade' on the
 * Upgrade header alone, so the relay has already taken both cap reservations
 * by the time ws aborts, which is exactly the path that has to give them back.
 * Resolves once the server has answered and the socket is done.
 */
function attemptAbortedUpgrade(port: number, slotId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1', () => {
      socket.write(
        `GET /?slot=${slotId} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });
    socket.once('error', reject);
    socket.once('close', () => resolve());
    socket.once('data', () => socket.destroy());
  });
}

/**
 * Completes the WebSocket handshake and resolves with the close code the
 * client observes. An abnormal 1006 means the server destroyed the socket
 * without a close frame, which is what terminate() looks like from the wire.
 */
function upgradeAndAwaitClose(relayUrl: string, slotId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new NodeWebSocket(`${relayUrl}/?slot=${slotId}`);
    socket.once('close', (code: number) => resolve(code));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      reject(new Error(`upgrade refused with HTTP ${response.statusCode ?? 0}`));
    });
    // A destroyed socket surfaces as an error before the 1006 close; swallow
    // it so the close code stays the thing under assertion.
    socket.once('error', () => undefined);
  });
}

/** A logger that captures error-level messages so a test can assert none were emitted. */
function recordingLogger(errorMessages: string[]): Logger {
  return {
    error: (message: string) => {
      errorMessages.push(message);
    },
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    slotRef: (slotId: string) => slotId,
  };
}

const SLOT_A = 'a'.repeat(64);
const SLOT_B = 'b'.repeat(64);
const SLOT_C = 'c'.repeat(64);
const SLOT_D = 'd'.repeat(64);

describe('pre-upgrade guard ladder', () => {
  it('rejects a wrong path with 404 before looking at the slot', async () => {
    const relay = await startTestRelay({ wsPath: '/ws' });
    try {
      expect(await attemptUpgrade(relay.url, `/nope?slot=${SLOT_A}`)).toEqual({ opened: false, status: 404 });
    } finally {
      await relay.close();
    }
  });

  it('rejects a malformed or missing slot with 400', async () => {
    const relay = await startTestRelay();
    try {
      expect(await attemptUpgrade(relay.url, '/?slot=nothex')).toEqual({ opened: false, status: 400 });
      expect(await attemptUpgrade(relay.url, `/?slot=${'A'.repeat(64)}`)).toEqual({ opened: false, status: 400 });
      expect(await attemptUpgrade(relay.url, '/')).toEqual({ opened: false, status: 400 });
    } finally {
      await relay.close();
    }
  });

  it('does not spend rate-limit budget on a malformed slot', async () => {
    // Slot validation runs before rate limiting, so a client fumbling the slot
    // format must not burn the single token a legitimate connect still needs.
    const relay = await startTestRelay({ rateLimitIpPerMinute: 1, rateLimitIpBurst: 1 });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(await attemptUpgrade(relay.url, '/?slot=nothex')).toEqual({ opened: false, status: 400 });
      }
      expect(await attemptUpgrade(relay.url, `/?slot=${SLOT_A}`)).toEqual({ opened: true });
    } finally {
      await relay.close();
    }
  });

  it('rejects with 429 once the per-IP rate limit is exhausted', async () => {
    const relay = await startTestRelay({ rateLimitIpPerMinute: 1, rateLimitIpBurst: 1 });
    try {
      expect(await attemptUpgrade(relay.url, `/?slot=${SLOT_A}`)).toEqual({ opened: true });
      expect(await attemptUpgrade(relay.url, `/?slot=${SLOT_B}`)).toEqual({ opened: false, status: 429 });
    } finally {
      await relay.close();
    }
  });

  it('rejects with 503 once the global connection cap is full', async () => {
    // Both cap rejections answer 503, so assert the counter as well or this
    // cannot tell which ladder step actually fired.
    const relay = await startTestRelay({ maxConnections: 1, maxUnpairedConnections: 50 });
    try {
      const parked = await connectTestClient(relay.url, SLOT_A);
      expect(await attemptUpgrade(relay.url, `/?slot=${SLOT_B}`)).toEqual({ opened: false, status: 503 });

      const rejects = relay.metrics.snapshot().rejectsByReason;
      expect(rejects['global_cap']).toBe(1);
      expect(rejects['unpaired_cap']).toBeUndefined();

      parked.close();
    } finally {
      await relay.close();
    }
  });
});

describe('unpaired-connection cap', () => {
  it('rejects with 503, indistinguishable from global-cap exhaustion, once too many connections are parked', async () => {
    const relay = await startTestRelay({ maxUnpairedConnections: 2 });
    try {
      const firstParked = await connectTestClient(relay.url, SLOT_A);
      const secondParked = await connectTestClient(relay.url, SLOT_B);

      expect(await attemptUpgrade(relay.url, `/?slot=${SLOT_C}`)).toEqual({ opened: false, status: 503 });
      expect(relay.metrics.snapshot().rejectsByReason['unpaired_cap']).toBe(1);
      // The wire status matches global_cap exactly; only the counter separates them.
      expect(relay.metrics.snapshot().rejectsByReason['global_cap']).toBeUndefined();

      firstParked.close();
      secondParked.close();
    } finally {
      await relay.close();
    }
  });

  it('frees a connection from the cap when it pairs, not only when it closes', async () => {
    // The regression that would take down live pairing: if pairing did not
    // release the reservation, a healthy relay would climb to the ceiling and
    // then refuse every subsequent pairing while nothing was actually wrong.
    const relay = await startTestRelay({ maxUnpairedConnections: 2 });
    try {
      const firstPeer = await connectTestClient(relay.url, SLOT_A);
      const secondPeer = await connectTestClient(relay.url, SLOT_A);
      expect(relay.metrics.snapshot().pairedSlots).toBe(1);

      // Both halves of the established pair have released, so a fresh pairing
      // fits under the same ceiling while the first pair is still connected.
      const thirdPeer = await connectTestClient(relay.url, SLOT_D);
      const fourthPeer = await connectTestClient(relay.url, SLOT_D);
      expect(relay.metrics.snapshot().pairedSlots).toBe(2);
      expect(relay.metrics.snapshot().rejectsByReason['unpaired_cap']).toBeUndefined();

      firstPeer.close();
      secondPeer.close();
      thirdPeer.close();
      fourthPeer.close();
    } finally {
      await relay.close();
    }
  });
});

describe('reservations survive an upgrade that never becomes a connection', () => {
  it('gives back both reservations when ws aborts the handshake without completing it', async () => {
    // The reservations are taken before the socket is handed to ws, and no
    // Conn exists to own them when ws refuses the handshake outright. Without
    // an explicit release on that path the relay leaks capacity until it
    // refuses everything.
    const relay = await startTestRelay({ maxConnections: 2, maxConnectionsPerIp: 2, maxUnpairedConnections: 2 });
    try {
      const port = Number(new URL(relay.url).port);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await attemptAbortedUpgrade(port, SLOT_A);
      }

      // Four aborted upgrades is twice both ceilings: a leak would have this
      // legitimate connect answered with 503 instead of an open socket.
      expect(await attemptUpgrade(relay.url, `/?slot=${SLOT_B}`)).toEqual({ opened: true });
    } finally {
      await relay.close();
    }
  });

  it('tears the socket down when a policy denies with a reason no close frame can carry', async () => {
    // ws throws synchronously on a reason over 123 bytes. Without the
    // terminate() fallback that throw escapes the upgrade callback and the
    // deny is handled as a crashed handler, which writes an HTTP status line
    // into an already-upgraded socket. It has to stay an orderly teardown.
    const denyWithUnsendableReason: AdmissionPolicy = {
      admit: () => ({ allow: false, closeCode: CLOSE_CODE.ADMISSION_DENIED, reason: 'x'.repeat(200) }),
    };
    const loggedErrors: string[] = [];
    const relay = await startTestRelay(
      { maxConnections: 1 },
      { admissionPolicy: denyWithUnsendableReason, logger: recordingLogger(loggedErrors) },
    );
    try {
      // No close frame could be sent, so the client observes an abnormal 1006
      // rather than hanging on an open socket.
      expect(await upgradeAndAwaitClose(relay.url, SLOT_A)).toBe(1006);

      // The single global slot was handed back, so this reaches the policy
      // again instead of being refused by an exhausted cap.
      expect(await upgradeAndAwaitClose(relay.url, SLOT_B)).toBe(1006);
      expect(relay.metrics.snapshot().rejectsByReason['admission']).toBe(2);

      // The load-bearing half: a deny the wire cannot express is still a
      // deny, never an escaped exception from the upgrade handler.
      expect(loggedErrors).toEqual([]);
    } finally {
      await relay.close();
    }
  });
});
