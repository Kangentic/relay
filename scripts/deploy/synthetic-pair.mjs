#!/usr/bin/env node
// Synthetic pairing probe for .github/workflows/monitor.yml. Opens two
// WebSocket connections to a random slot against a live relay and asserts
// a byte round-trips between them. This is the only monitoring check that
// proves the product actually works: /healthz says nothing about whether
// the WebSocket upgrade routes correctly end to end through Caddy and
// Cloudflare.
//
// It also times the path, because a relay that answers but answers slowly is
// the failure users actually report: every run prints how long each dial and
// the round trip took, and a dial slower than SLOW_DIAL_WARNING_MS is raised
// as a warning annotation on the run. It does not fail the run: dials over a
// second happen on roughly 1.4% of attempts on a healthy day (docs/latency.md),
// so failing on one would file issues on noise. The hard TIMEOUT_MS below is
// still the failure.
//
// Usage: RELAY_URL=wss://relay.kangentic.com node scripts/deploy/synthetic-pair.mjs

import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { WebSocket } from 'ws';

const relayUrl = process.env.RELAY_URL;
if (!relayUrl) {
  console.error('RELAY_URL is required, e.g. wss://relay.kangentic.com');
  process.exit(1);
}

const TIMEOUT_MS = 10_000;
const SLOW_DIAL_WARNING_MS = 2_000;

// The connect phase needs its own bound: a relay (or a proxy in front of
// it) that accepts the TCP connection but never completes the WebSocket
// upgrade emits neither 'open' nor 'error', so an unguarded wait here
// would hang forever - the one failure mode a monitoring probe most needs
// to report.
function openSocket(slotId) {
  return new Promise((resolve, reject) => {
    const dialStartedAt = performance.now();
    const socket = new WebSocket(`${relayUrl}?slot=${slotId}`, { perMessageDeflate: false });
    const connectTimer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`no WebSocket upgrade within ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(connectTimer);
      resolve({ socket, dialMs: Math.round(performance.now() - dialStartedAt) });
    });
    socket.once('error', (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
  });
}

/**
 * Reports the timings. In GitHub Actions a slow dial becomes a `::warning::`
 * annotation, and every run appends its numbers to the job summary, so a week
 * of runs reads as a trend without anyone grepping logs.
 */
function reportTimings(dialMilliseconds, roundTripMs) {
  const slowestDialMs = Math.max(...dialMilliseconds);
  const line = `dial_a_ms=${dialMilliseconds[0]} dial_b_ms=${dialMilliseconds[1]} round_trip_ms=${roundTripMs}`;
  console.log(`synthetic pairing probe: OK ${line}`);
  const inGitHubActions = process.env.GITHUB_ACTIONS === 'true';
  if (slowestDialMs > SLOW_DIAL_WARNING_MS) {
    const message = `Slowest relay dial took ${slowestDialMs} ms (warning above ${SLOW_DIAL_WARNING_MS} ms); ${line}`;
    console.log(inGitHubActions ? `::warning title=Slow relay dial::${message}` : `warning: ${message}`);
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (inGitHubActions && summaryPath) {
    appendFileSync(summaryPath, `Synthetic pair: ${line}\n`);
  }
}

async function main() {
  const slotId = randomBytes(32).toString('hex');
  const [dialA, dialB] = await Promise.all([openSocket(slotId), openSocket(slotId)]);
  const peerA = dialA.socket;
  const peerB = dialB.socket;

  const probeBytes = randomBytes(32);
  const roundTripStartedAt = performance.now();
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
    reportTimings([dialA.dialMs, dialB.dialMs], Math.round(performance.now() - roundTripStartedAt));
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
