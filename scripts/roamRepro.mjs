#!/usr/bin/env node
// Roam repro: measures how long a peer is unable to re-pair after its socket
// goes half-open, with the contention probe off and on.
//
// This is the harness for the "ghost paired slot" bug. A phone that changes
// network (wifi to cellular, a tunnel, doze) leaves a half-open socket behind
// with no FIN. That socket still reads OPEN, so before the contention probe
// existed the relay rejected the returning phone as slot_busy on every retry
// until the ping/pong loop noticed, one to two PING_INTERVAL_MS cycles later,
// and then tore down the healthy peer as well.
//
// Usage:
//   npm run build
//   node scripts/roamRepro.mjs
//
// Flags (all optional):
//   --ping-interval   PING_INTERVAL_MS for both arms        (default 30000)
//   --probe           CONTENTION_PROBE_TIMEOUT_MS, "on" arm (default 2000)
//   --phone-backoff   the phone's retry delay after a 4409. Defaults to the
//                     real client's SLOW_RETRY_BACKOFF_MS. Lower it to
//                     separate the relay's own contribution from the client
//                     constant                              (default 5000)
//   --repeats         measurements per arm                  (default 1)
//   --timeout-ms      give up on one measurement after this (default 150000)
//
// Expected shape of the result at defaults: the "off" arm re-pairs in 30-60s
// and logs a dozen clustered slot_busy rejections, which is this bug's exact
// fingerprint; the "on" arm re-pairs in about 5s, essentially all of it the
// phone's own backoff rather than the relay.
//
// The roam is simulated with ws's pause(): the client stops reading its
// socket, so it never answers a ping, while the TCP connection stays
// ESTABLISHED and no FIN is sent. That is precisely what the relay can
// observe of a real roam, so it drives the real code path. It does not
// reproduce kernel-level packet loss; for that, run the relay under docker
// compose and `docker network disconnect` the client's container.
//
// Client retry cadences mirror the real clients:
//   desktop  kangentic/src/main/mobile-bridge/transport/relay-client.ts (500ms)
//   phone    kangentic-mobile/src/channel/relayTransport.ts (5000ms on 4409)
//
// The script needs no dependencies beyond the relay's own `ws` package.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { WebSocket } from 'ws';

const DESKTOP_BACKOFF_MS = 500;
const RELAY_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function parseArgs(argv) {
  const options = {
    pingInterval: 30_000,
    probe: 2_000,
    phoneBackoff: 5_000,
    repeats: 1,
    timeoutMs: 150_000,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--ping-interval') options.pingInterval = Number(value);
    else if (flag === '--probe') options.probe = Number(value);
    else if (flag === '--phone-backoff') options.phoneBackoff = Number(value);
    else if (flag === '--repeats') options.repeats = Number(value);
    else if (flag === '--timeout-ms') options.timeoutMs = Number(value);
    else continue;
    index += 1;
  }
  return options;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startRelay(environmentOverrides) {
  const port = 19_000 + Math.floor(Math.random() * 4_000);
  const child = spawn(process.execPath, [RELAY_ENTRY], {
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

/** A retrying peer, reconnecting on close with the backoff its real counterpart uses. */
function createPeer(name, url, slot, phoneBackoffMs, onFrame) {
  const peer = { name, socket: null, stopped: false, dials: 0 };

  const dial = () => {
    if (peer.stopped) return;
    peer.dials += 1;
    const socket = new WebSocket(`${url}?slot=${slot}`);
    peer.socket = socket;
    socket.binaryType = 'nodebuffer';
    socket.on('message', (data) => onFrame(peer, data));
    socket.on('error', () => {});
    socket.on('close', (code) => {
      if (peer.stopped) return;
      setTimeout(dial, code === 4409 ? phoneBackoffMs : DESKTOP_BACKOFF_MS);
    });
  };

  peer.start = dial;
  peer.stop = () => {
    peer.stopped = true;
    try {
      peer.socket?.terminate();
    } catch {
      // best-effort
    }
  };
  return peer;
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

async function measureOnce({ pingInterval, probe, phoneBackoff, timeoutMs }) {
  const relay = await startRelay({
    PING_INTERVAL_MS: String(pingInterval),
    CONTENTION_PROBE_TIMEOUT_MS: String(probe),
  });

  try {
    const slot = randomBytes(32).toString('hex');

    // 1. Establish a healthy pair, and prove it actually forwards.
    const desktopSocket = new WebSocket(`${relay.url}?slot=${slot}`);
    await waitForOpen(desktopSocket);
    const phoneSocket = new WebSocket(`${relay.url}?slot=${slot}`);
    await waitForOpen(phoneSocket);

    const paired = new Promise((resolve) => desktopSocket.once('message', resolve));
    phoneSocket.send(Buffer.from('pre-roam'));
    await paired;

    // 2. The phone roams: it stops reading, so it never answers a ping, and
    //    no FIN is sent. The relay still sees readyState OPEN.
    phoneSocket.pause();
    const roamedAt = performance.now();

    // 3. Both clients now retry on their own cadences. The desktop does not
    //    yet know anything is wrong; the phone dials a fresh connection.
    let repairedAt = null;
    const onFrame = (peer, data) => {
      if (peer.name === 'desktop' && data.toString() === 'post-roam') repairedAt ??= performance.now();
    };

    const desktop = createPeer('desktop', relay.url, slot, phoneBackoff, onFrame);
    const newPhone = createPeer('phone', relay.url, slot, phoneBackoff, onFrame);

    // The desktop's live socket is the one still paired to the ghost; wire its
    // close into the same retry loop the real client uses.
    desktopSocket.on('message', (data) => onFrame(desktop, data));
    desktopSocket.once('close', () => setTimeout(desktop.start, DESKTOP_BACKOFF_MS));

    newPhone.start();

    // Re-send until the desktop actually receives it: a frame sent into a
    // half-paired slot is dropped rather than queued.
    const pump = setInterval(() => {
      if (newPhone.socket?.readyState === WebSocket.OPEN) {
        try {
          newPhone.socket.send(Buffer.from('post-roam'));
        } catch {
          // socket closed under us
        }
      }
    }, 100);

    const deadline = Date.now() + timeoutMs;
    while (repairedAt === null && Date.now() < deadline) await delay(50);

    clearInterval(pump);
    desktop.stop();
    newPhone.stop();
    desktopSocket.terminate();
    phoneSocket.terminate();

    const metrics = await fetch(`http://127.0.0.1:${relay.port}/metricz`).then((response) => response.json());

    return {
      repairMs: repairedAt === null ? null : Math.round(repairedAt - roamedAt),
      phoneDials: newPhone.dials,
      slotBusy: metrics.rejectsByReason.slot_busy ?? 0,
      probeEvicted: metrics.rejectsByReason.probe_evicted ?? 0,
      heartbeat: metrics.closedByCause.heartbeat ?? 0,
    };
  } finally {
    relay.child.kill();
  }
}

async function main() {
  const options = parseArgs(process.argv);

  if (!existsSync(RELAY_ENTRY)) {
    console.error(`No build found at ${RELAY_ENTRY}. Run \`npm run build\` first.`);
    process.exit(1);
  }

  console.log(
    `roam repro: PING_INTERVAL_MS=${options.pingInterval}, phone backoff ${options.phoneBackoff}ms, ` +
      `repeats=${options.repeats}`,
  );
  console.log('the "off" arm reproduces the behaviour that shipped before the contention probe\n');

  for (const arm of [
    { label: 'probe OFF', probe: 0 },
    { label: `probe ON (${options.probe}ms)`, probe: options.probe },
  ]) {
    for (let run = 1; run <= options.repeats; run += 1) {
      const result = await measureOnce({ ...options, probe: arm.probe });
      const repair = result.repairMs === null ? 'NEVER (timed out)' : `${(result.repairMs / 1000).toFixed(1)}s`;
      console.log(
        `${arm.label.padEnd(18)} run ${run}  re-pair ${repair.padStart(16)}  ` +
          `phone dials ${String(result.phoneDials).padStart(3)}  ` +
          `slot_busy ${String(result.slotBusy).padStart(3)}  ` +
          `probe_evicted ${result.probeEvicted}  heartbeat ${result.heartbeat}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
