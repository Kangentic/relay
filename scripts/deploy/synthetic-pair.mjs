#!/usr/bin/env node
// Synthetic pairing probe for .github/workflows/monitor.yml. Opens two
// WebSocket connections to a random slot against a live relay and asserts
// a byte round-trips between them. This is the only monitoring check that
// proves the product actually works: /healthz says nothing about whether
// the WebSocket upgrade routes correctly end to end through Caddy and
// Cloudflare.
//
// Usage: RELAY_URL=wss://relay.kangentic.com node scripts/deploy/synthetic-pair.mjs

import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { WebSocket } from 'ws';

const relayUrl = process.env.RELAY_URL;
if (!relayUrl) {
  console.error('RELAY_URL is required, e.g. wss://relay.kangentic.com');
  process.exit(1);
}

const TIMEOUT_MS = 10_000;

// The connect phase needs its own bound: a relay (or a proxy in front of
// it) that accepts the TCP connection but never completes the WebSocket
// upgrade emits neither 'open' nor 'error', so an unguarded wait here
// would hang forever - the one failure mode a monitoring probe most needs
// to report.
function openSocket(slotId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${relayUrl}?slot=${slotId}`, { perMessageDeflate: false });
    const connectTimer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`no WebSocket upgrade within ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(connectTimer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
  });
}

async function main() {
  const slotId = randomBytes(32).toString('hex');
  const [peerA, peerB] = await Promise.all([openSocket(slotId), openSocket(slotId)]);

  const probeBytes = randomBytes(32);
  const roundTrip = new Promise((resolve, reject) => {
    peerB.once('message', (data) => {
      if (Buffer.compare(Buffer.from(data), probeBytes) === 0) {
        resolve();
      } else {
        reject(new Error('received frame does not match what was sent'));
      }
    });
    peerA.once('error', reject);
    peerB.once('error', reject);
  });

  peerA.send(probeBytes);

  let roundTripTimer;
  const timeout = new Promise((_resolve, reject) => {
    roundTripTimer = setTimeout(
      () => reject(new Error(`no round-trip within ${TIMEOUT_MS} ms`)),
      TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([roundTrip, timeout]);
    console.log('synthetic pairing probe: OK');
  } finally {
    // Without this the pending timer keeps the event loop alive, so even a
    // probe that round-trips in milliseconds would not exit for TIMEOUT_MS.
    clearTimeout(roundTripTimer);
    peerA.terminate();
    peerB.terminate();
  }
}

main().catch((error) => {
  console.error(`synthetic pairing probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
