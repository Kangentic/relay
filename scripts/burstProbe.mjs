#!/usr/bin/env node
// Burst probe: how long a burst takes to cross the relay after the tunnel has
// been idle, which is what a desktop pushing a transcript to a quiet phone
// pays. It is the before/after measurement for
// net.ipv4.tcp_slow_start_after_idle=0 on the Caddy service: with the kernel
// default of 1, a connection idle for one retransmission timeout restarts
// from the initial congestion window, so the first burst after a pause pays
// slow start again (https://docs.kernel.org/networking/ip-sysctl.html).
//
// One pair, both ends on this machine so both timestamps come from one clock.
// Each run: stay idle, send one small frame (path latency on its own), stay
// idle again, then send the burst and time it to the last byte on the far
// side. The burst minus the small frame is roughly what the transfer itself
// cost.
//
// Usage:
//   node scripts/burstProbe.mjs --url wss://relay.kangentic.com
//
// Flags (all optional):
//   --url          relay WebSocket URL                  (default ws://127.0.0.1:18080)
//   --runs         measurements                          (default 20)
//   --idle-ms      idle time before each send            (default 10000)
//   --burst-bytes  burst size                            (default 524288)
//   --frame-bytes  frame size the burst is split into    (default 16384)
//
// Against the hosted relay this is one short-lived pairing on a random slot,
// the same footprint as the monitor's synthetic pair, and it never reports a
// role. The script needs no dependencies beyond the relay's own `ws` package.

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { WebSocket } from 'ws';

function parseArgs(argv) {
  const options = {
    url: 'ws://127.0.0.1:18080',
    runs: 20,
    idleMs: 10_000,
    burstBytes: 512 * 1024,
    frameBytes: 16 * 1024,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--url') options.url = value ?? options.url;
    else if (flag === '--runs') options.runs = Number(value);
    else if (flag === '--idle-ms') options.idleMs = Number(value);
    else if (flag === '--burst-bytes') options.burstBytes = Number(value);
    else if (flag === '--frame-bytes') options.frameBytes = Number(value);
    else continue;
    index += 1;
  }
  return options;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    socket.binaryType = 'nodebuffer';
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Resolves when `bytes` more bytes have arrived on the receiver. */
function receiveBytes(receiver, bytes) {
  return new Promise((resolve) => {
    let remaining = bytes;
    const onMessage = (data) => {
      remaining -= data.length;
      if (remaining > 0) return;
      receiver.off('message', onMessage);
      resolve(performance.now());
    };
    receiver.on('message', onMessage);
  });
}

function percentile(sortedValues, fraction) {
  const position = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[position];
}

function describe(label, values) {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    `${label.padEnd(12)} n=${sorted.length} p50=${percentile(sorted, 0.5).toFixed(1)}ms ` +
    `p90=${percentile(sorted, 0.9).toFixed(1)}ms min=${sorted[0].toFixed(1)}ms max=${sorted[sorted.length - 1].toFixed(1)}ms`
  );
}

async function main() {
  const options = parseArgs(process.argv);
  const slot = randomBytes(32).toString('hex');
  const slotUrl = `${options.url}?slot=${slot}`;

  console.log(
    `burst probe ${new Date().toISOString()}: ${options.url}, ${options.runs} runs, ` +
      `${options.burstBytes / 1024} KiB in ${options.frameBytes / 1024} KiB frames after ${options.idleMs} ms idle\n`,
  );

  const sender = await openSocket(slotUrl);
  const receiver = await openSocket(slotUrl);
  const paired = receiveBytes(receiver, 6);
  sender.send(Buffer.from('paired'));
  await paired;

  const smallFrameMs = [];
  const burstMs = [];
  const frame = randomBytes(options.frameBytes);
  const framesPerBurst = Math.ceil(options.burstBytes / options.frameBytes);

  for (let run = 1; run <= options.runs; run += 1) {
    await delay(options.idleMs);
    const smallArrived = receiveBytes(receiver, 16);
    const smallSentAt = performance.now();
    sender.send(randomBytes(16));
    smallFrameMs.push((await smallArrived) - smallSentAt);

    await delay(options.idleMs);
    const burstArrived = receiveBytes(receiver, framesPerBurst * options.frameBytes);
    const burstSentAt = performance.now();
    for (let index = 0; index < framesPerBurst; index += 1) sender.send(frame);
    burstMs.push((await burstArrived) - burstSentAt);

    console.log(
      `run ${String(run).padStart(2)}  ${new Date().toISOString()}  small ${smallFrameMs[run - 1].toFixed(1).padStart(7)}ms  ` +
        `burst ${burstMs[run - 1].toFixed(1).padStart(8)}ms`,
    );
  }

  sender.close();
  receiver.close();
  console.log(`\n${describe('small frame', smallFrameMs)}\n${describe('burst', burstMs)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
