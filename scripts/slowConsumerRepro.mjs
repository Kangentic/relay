#!/usr/bin/env node
// Slow-consumer repro: does the keepalive loop reap a peer that is alive but
// reading slowly behind a large outbound queue?
//
// The relay's keepalive ping is written behind whatever is already queued to
// the socket. A phone draining a multi-MiB transcript over a slow link can
// therefore receive the ping, and answer it, more than one PING_INTERVAL_MS
// after it was sent, even though its TCP stack has been ACKing the whole time.
// Before the drain check, the loop terminated that socket as a pong timeout.
//
// Usage:
//   npm run build
//   node scripts/slowConsumerRepro.mjs
//
// Flags (all optional):
//   --ping-interval   PING_INTERVAL_MS. Not lower than ~3s: Linux frees send
//                     buffer space in bursts about a second apart, so a 1s
//                     interval can land between two bursts and see no
//                     progress at all, which production's 30s never does
//                                                                (default 3000)
//   --total-bytes     bytes the sender pushes to the slow reader (default 25165824)
//   --max-buffered    MAX_BUFFERED_BYTES for the instance, raised
//                     so the backlog is not torn down as
//                     backpressure first                          (default 67108864)
//   --frame-bytes     bytes per frame                            (default 16384)
//   --read-rate       reader throughput in bytes per second      (default 1048576)
//   --repeats         measurements                                (default 5)
//   --timeout-ms      give up on one measurement after this      (default 90000)
//   --relay-entry     the relay build to run, for an A/B against
//                     an older build                      (default dist/index.js)
//   --diagnose        also run the relay's own history recorder at 1s and
//                     print the peak outbound queue it sampled each second,
//                     which is the number the drain check reads
//
// Run it on Linux for a number that means anything. Windows auto-tunes
// loopback socket buffers to tens of MiB, so the backlog leaves ws's queue for
// the kernel almost at once and the ping waits behind bytes nothing in Node can
// see. Linux caps those buffers (net.ipv4.tcp_wmem), which leaves the backlog
// in the relay's own queue, where the drain check reads it, as it does on the
// production host. A node:22 container is enough:
//   docker run --rm -v "$PWD:/app" -w /app node:22 node scripts/slowConsumerRepro.mjs
//
// Expected result: 24 MiB at 1 MiB/s keeps the ping queued for many seconds.
// A relay without the drain check reaps the reader within two intervals
// (reader killed with 1006 holding only what the kernel had already buffered).
// A relay with it lets the reader finish (all 24 MiB, pongOverdueDraining > 0).
//
// A reap can still show up AFTER the last byte arrives. Once the relay's own
// queue is empty the final few MiB sit in kernel buffers, where nothing in
// Node can see them drain, and a ping behind them is judged by the old rule.
// That is the documented blind spot of the drain check, not a regression.
//
// The payload is deliberately larger than a loopback socket's kernel buffers
// (several MiB on Windows and Linux): anything that already left the relay's
// queue for the kernel still arrives after a terminate(), so a small payload
// hides the kill. The default MAX_BUFFERED_BYTES is raised for the same reason,
// so the queue can hold the backlog without tripping the backpressure guard.
//
// The slow link is simulated with ws's pause() and resume(): the reader only
// takes a fixed byte budget off its socket every 100 ms, so TCP flow control
// pushes the backlog back into the relay's outbound queue exactly as a slow
// radio would. The script needs no dependencies beyond the relay's own `ws`.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { WebSocket } from 'ws';

const DEFAULT_RELAY_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const READ_SLOT_MS = 100;

function parseArgs(argv) {
  const options = {
    pingInterval: 3_000,
    totalBytes: 24 * 1024 * 1024,
    maxBuffered: 64 * 1024 * 1024,
    frameBytes: 16 * 1024,
    readRate: 1024 * 1024,
    repeats: 5,
    timeoutMs: 90_000,
    relayEntry: DEFAULT_RELAY_ENTRY,
    diagnose: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = Number(argv[index + 1]);
    if (flag === '--diagnose') {
      options.diagnose = true;
      continue;
    }
    if (flag === '--relay-entry') options.relayEntry = argv[index + 1] ?? DEFAULT_RELAY_ENTRY;
    else if (flag === '--ping-interval') options.pingInterval = value;
    else if (flag === '--total-bytes') options.totalBytes = value;
    else if (flag === '--max-buffered') options.maxBuffered = value;
    else if (flag === '--frame-bytes') options.frameBytes = value;
    else if (flag === '--read-rate') options.readRate = value;
    else if (flag === '--repeats') options.repeats = value;
    else if (flag === '--timeout-ms') options.timeoutMs = value;
    else continue;
    index += 1;
  }
  return options;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startRelay(relayEntry, environmentOverrides) {
  const port = 19_000 + Math.floor(Math.random() * 4_000);
  const child = spawn(process.execPath, [relayEntry], {
    env: {
      ...process.env,
      PORT: String(port),
      BIND_ADDRESS: '127.0.0.1',
      LOG_LEVEL: 'warn',
      METRICS_ALLOW_UNAUTHENTICATED: 'true',
      ...environmentOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('relay did not become healthy');
    }
    await delay(100);
  }
  return { child, port, url: `ws://127.0.0.1:${port}` };
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

async function measureOnce({
  pingInterval,
  totalBytes,
  maxBuffered,
  frameBytes,
  readRate,
  timeoutMs,
  relayEntry,
  diagnose,
}) {
  const relay = await startRelay(relayEntry, {
    PING_INTERVAL_MS: String(pingInterval),
    MAX_BUFFERED_BYTES: String(maxBuffered),
    ...(diagnose ? { ADMIN_ENABLED: 'true', METRICS_HISTORY_INTERVAL_MS: '1000' } : {}),
  });

  try {
    const slot = randomBytes(32).toString('hex');
    const sender = new WebSocket(`${relay.url}?slot=${slot}`);
    await waitForOpen(sender);
    const reader = new WebSocket(`${relay.url}?slot=${slot}`);
    reader.binaryType = 'nodebuffer';
    await waitForOpen(reader);

    // Prove the pair forwards before the slow phase starts.
    const paired = new Promise((resolve) => reader.once('message', resolve));
    sender.send(Buffer.from('paired'));
    await paired;

    const budgetPerSlot = Math.max(1, Math.floor((readRate * READ_SLOT_MS) / 1000));
    let receivedBytes = 0;
    let bytesThisSlot = 0;
    let readerClosedCode = null;
    let readerClosedAt = null;
    let finishedAt = null;

    reader.on('message', (data) => {
      receivedBytes += data.length;
      bytesThisSlot += data.length;
      if (receivedBytes >= totalBytes && finishedAt === null) finishedAt = performance.now();
      if (bytesThisSlot >= budgetPerSlot) reader.pause();
    });
    reader.on('close', (code) => {
      readerClosedCode ??= code;
      readerClosedAt ??= performance.now();
    });
    reader.on('error', () => {});
    let senderClosedCode = null;
    sender.on('close', (code) => {
      senderClosedCode ??= code;
    });
    sender.on('error', () => {});

    const throttle = setInterval(() => {
      bytesThisSlot = 0;
      if (reader.readyState === WebSocket.OPEN) reader.resume();
    }, READ_SLOT_MS);

    const startedAt = performance.now();
    const frame = randomBytes(frameBytes);
    for (let sent = 0; sent < totalBytes; sent += frameBytes) sender.send(frame);

    const deadline = Date.now() + timeoutMs;
    while (finishedAt === null && readerClosedCode === null && Date.now() < deadline) await delay(50);

    clearInterval(throttle);
    const metrics = await fetch(`http://127.0.0.1:${relay.port}/metricz`).then((response) => response.json());
    // Read before this script's own teardown below, so a code here is the
    // relay's doing: 1006 on the reader is a terminate(), and the sender then
    // sees the pair torn down behind it.
    const closeCodes = `reader ${readerClosedCode ?? 'open'} / sender ${senderClosedCode ?? 'open'}`;
    if (diagnose) {
      const history = await fetch(`http://127.0.0.1:${relay.port}/admin/data?range=600000`).then((response) =>
        response.json(),
      );
      const series = history.rows.map(
        (row) =>
          `${((row.maxOutboundBufferBytes ?? 0) / (1024 * 1024)).toFixed(1)}MiB` +
          `${row.pongTimeoutsDelta ? ' REAPED' : ''}${row.pongOverdueDrainingDelta ? ' spared' : ''}`,
      );
      console.log(`  peak outbound queue per second: ${series.join(', ')}`);
    }
    sender.terminate();
    reader.terminate();

    // A close that lands before the last byte is a kill, whatever arrived
    // first: the bytes a terminate() strands in the relay's queue never come.
    const killed = readerClosedAt !== null && (finishedAt === null || readerClosedAt < finishedAt);
    return {
      outcome: killed ? `killed (${readerClosedCode})` : finishedAt !== null ? 'completed' : 'timed out',
      seconds: ((killed ? readerClosedAt : (finishedAt ?? performance.now())) - startedAt) / 1000,
      receivedMiB: receivedBytes / (1024 * 1024),
      closeCodes,
      heartbeat: metrics.closedByCause?.heartbeat ?? 0,
      // Absent on a relay built before the drain check existed.
      pongOverdueDraining: metrics.pongOverdueDrainingTotal ?? 'n/a',
    };
  } finally {
    relay.child.kill();
  }
}

async function main() {
  const options = parseArgs(process.argv);

  if (!existsSync(options.relayEntry)) {
    console.error(`No build found at ${options.relayEntry}. Run \`npm run build\` first.`);
    process.exit(1);
  }

  console.log(
    `slow consumer repro (${process.platform}, Node ${process.version}): PING_INTERVAL_MS=${options.pingInterval}, ` +
      `${(options.totalBytes / (1024 * 1024)).toFixed(1)} MiB at ${(options.readRate / 1024).toFixed(0)} KiB/s, ` +
      `repeats=${options.repeats}\n`,
  );

  for (let run = 1; run <= options.repeats; run += 1) {
    const result = await measureOnce(options);
    console.log(
      `run ${run}  ${result.outcome.padEnd(14)}  after ${result.seconds.toFixed(1).padStart(5)}s  ` +
        `received ${result.receivedMiB.toFixed(2).padStart(5)} MiB  ${result.closeCodes}  ` +
        `heartbeat ${result.heartbeat}  pongOverdueDraining ${result.pongOverdueDraining}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
