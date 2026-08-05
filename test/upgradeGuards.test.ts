import { describe, it, expect } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { startTestRelay } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';

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
