// Local preview rig for the /admin dashboard.
//
// The dashboard is the one surface in this repo you cannot review by reading a
// diff or a test assertion: it is charts. And an empty relay renders "No history
// in this range yet" on every panel, which tells you nothing about whether the
// thing actually works. So this seeds a realistic history file first, then
// serves the real dashboard against it.
//
// Run it with tsx so it can import the relay's own modules rather than
// reimplementing them. Prefer watch mode: it restarts on any source edit, and
// the dashboard reloads itself when it notices the new instance id, so editing
// adminPage.ts updates the page you are looking at without touching anything.
//
//   npx tsx watch --clear-screen=false scripts/preview.mjs --port 8099
//   npx tsx scripts/preview.mjs --port 8099 --days 40 --no-traffic
//
// Seeding goes through the relay's own serializeHistoryRow, so the preview file
// is byte-compatible with what the recorder writes. If the wire format changes,
// this follows it automatically instead of drifting into a lie.
//
// Everything it writes lives under .kangentic/, which is gitignored.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createRelay } from '../src/server.js';
import { serializeHistoryRow } from '../src/history/rows.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { port: 8099, days: 40, traffic: true, pairs: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--port') options.port = Number(value);
    else if (flag === '--days') options.days = Number(value);
    else if (flag === '--pairs') options.pairs = Number(value);
    else if (flag === '--no-traffic') options.traffic = false;
    else if (flag === '--help') options.help = true;
  }
  return options;
}

/**
 * A day/night cycle with a slow weekly drift, so the charts show something with
 * shape rather than noise around a flat line. Returns roughly 0.05 to 1.
 */
function loadFactor(timestampMs) {
  const hourOfDay = new Date(timestampMs).getHours() + new Date(timestampMs).getMinutes() / 60;
  const daily = Math.sin(((hourOfDay - 4) / 24) * Math.PI * 2) * 0.5 + 0.5;
  const weekly = Math.sin(timestampMs / (7 * 24 * 60 * 60 * 1000)) * 0.15;
  return Math.max(0.05, Math.min(1, daily * 0.8 + 0.15 + weekly));
}

// Deterministic pseudo-random so two runs produce the same picture, which makes
// "did that chart change because of my edit" answerable.
function pseudoRandom(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function buildRow(timestampMs, resolutionSeconds, index, restartCount) {
  const windowMs = resolutionSeconds * 1000;
  const minutes = windowMs / 60_000;
  const load = loadFactor(timestampMs);
  const jitter = pseudoRandom(index) * 0.3 + 0.85;
  // An occasional burst, so the difference between peak and average is visible
  // in the tooltip on aggregated buckets. Kept mild on purpose: a 3x outlier
  // every few points drags the y-axis up and flattens the body of the chart
  // into an unreadable line near zero, which makes the preview a worse
  // likeness of real traffic rather than a better one.
  const burst = pseudoRandom(index * 7.7) > 0.997 ? 1.9 : 1;

  const pairedPeak = Math.round(load * 34 * jitter * burst);
  const pairedMean = Math.round(load * 26 * jitter);
  const waitingPeak = Math.round(load * 5 * jitter);
  const activePeak = pairedPeak * 2 + waitingPeak;
  const aggregated = resolutionSeconds > 60;

  const framesPerMinute = pairedPeak * 42;
  const rejects = {};
  if (pseudoRandom(index * 3.3) > 0.94) rejects.park_timeout = Math.ceil(load * 3);
  if (pseudoRandom(index * 5.1) > 0.985) rejects.rate_limit_ip = 1;
  if (pseudoRandom(index * 9.4) > 0.995) rejects.backpressure = 1;

  const series = (peak, mean) => ({ maximum: peak, mean: aggregated ? mean : null });

  return {
    schemaVersion: 1,
    timestampMs,
    resolutionSeconds,
    windowMs,
    instanceId: aggregated ? null : 'previewsd',
    uptimeSeconds: 3600,
    restartCount,
    sourceRowCount: aggregated ? resolutionSeconds / 60 : 1,
    connectionsDelta: Math.round(load * 9 * minutes * jitter),
    sessionsDelta: Math.round(load * 4 * minutes * jitter),
    framesForwardedDelta: Math.round(framesPerMinute * minutes),
    bytesForwardedDelta: Math.round(framesPerMinute * minutes * 640),
    peerClosedDelta: Math.round(load * 3 * minutes * jitter),
    pongTimeoutsDelta: pseudoRandom(index * 2.2) > 0.97 ? 1 : 0,
    rejectsByReasonDelta: rejects,
    activeConnections: series(activePeak, Math.round(pairedMean * 2)),
    waitingSlots: series(waitingPeak, Math.max(0, Math.round(waitingPeak * 0.6))),
    pairedSlots: series(pairedPeak, pairedMean),
    cpuPercent: series(
      Math.round(load * 26 * jitter * burst * 10) / 10,
      Math.round(load * 15 * jitter * 10) / 10,
    ),
    eventLoopLagP99Ms: Math.round((1.1 + load * 5 * burst) * 10) / 10,
    rssBytes: Math.round((78 + load * 26) * 1024 * 1024),
    rssPercent: Math.round(((78 + load * 26) / 1200) * 1000) / 10,
  };
}

/**
 * Writes the file a long-running relay would actually hold: already compacted
 * into the three retention tiers, not raw 1-minute rows all the way back.
 */
async function seedHistory(historyPath, days) {
  const now = Date.now();
  const rows = [];
  let index = 0;

  const tiers = [
    { resolutionSeconds: 3600, fromMs: days * 86_400_000, toMs: 30 * 86_400_000 },
    { resolutionSeconds: 300, fromMs: 30 * 86_400_000, toMs: 48 * 3_600_000 },
    { resolutionSeconds: 60, fromMs: 48 * 3_600_000, toMs: 0 },
  ];

  for (const tier of tiers) {
    const stepMs = tier.resolutionSeconds * 1000;
    if (tier.fromMs <= tier.toMs) continue;
    for (let ageMs = tier.fromMs; ageMs > tier.toMs; ageMs -= stepMs) {
      const bucketStart = Math.floor((now - ageMs) / stepMs) * stepMs;
      // A restart every few days, so the dashed deploy markers are exercised.
      const restart = index > 0 && pseudoRandom(index * 1.7) > 0.9985 ? 1 : 0;
      rows.push(buildRow(bucketStart, tier.resolutionSeconds, index, restart));
      index += 1;
    }
  }

  rows.sort((left, right) => left.timestampMs - right.timestampMs);
  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${rows.map(serializeHistoryRow).join('\n')}\n`, 'utf8');
  return rows.length;
}

/** Keeps a few real pairs connected and chatting, so the live tiles are not all zero. */
function startTraffic(relayUrl, pairCount) {
  const sockets = [];
  for (let pair = 0; pair < pairCount; pair += 1) {
    const slot = `${pair}`.padStart(2, '0').repeat(32).slice(0, 64);
    const peerA = new WebSocket(`${relayUrl}?slot=${slot}`);
    const peerB = new WebSocket(`${relayUrl}?slot=${slot}`);
    sockets.push(peerA, peerB);
    peerA.on('error', () => undefined);
    peerB.on('error', () => undefined);
    peerA.on('open', () => {
      const timer = setInterval(() => {
        if (peerA.readyState === peerA.OPEN) peerA.send(Buffer.alloc(512 + pair * 64, pair));
      }, 900);
      timer.unref?.();
    });
    peerB.on('message', () => undefined);
  }
  return () => {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // Preview teardown; a socket that is already gone is not interesting.
      }
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: npx tsx scripts/preview.mjs [--port 8099] [--days 40] [--pairs 3] [--no-traffic]');
    return;
  }

  const historyPath = resolve(repoRoot, '.kangentic', 'preview-history.ndjson');
  process.stdout.write('seeding history... ');
  const rowCount = await seedHistory(historyPath, options.days);
  console.log(`${rowCount} rows across ${options.days} days`);

  const config = loadConfig({
    PORT: String(options.port),
    BIND_ADDRESS: '127.0.0.1',
    ADMIN_ENABLED: 'true',
    METRICS_HISTORY_PATH: historyPath,
    // Faster than production so new points appear while you are watching.
    METRICS_HISTORY_INTERVAL_MS: '10000',
    METRICS_ALLOW_UNAUTHENTICATED: 'true',
    LOG_LEVEL: 'warn',
  });

  const relay = createRelay(config);
  const { port } = await relay.listen();
  const relayUrl = `ws://127.0.0.1:${port}`;
  const stopTraffic = options.traffic ? startTraffic(relayUrl, options.pairs) : () => undefined;

  console.log('');
  console.log(`  dashboard   http://127.0.0.1:${port}/admin`);
  console.log(`  data        http://127.0.0.1:${port}/admin/data`);
  console.log(`  metricz     http://127.0.0.1:${port}/metricz`);
  console.log(`  history     ${historyPath}`);
  console.log('');
  console.log(`  sampling every 10s${options.traffic ? `, ${options.pairs} live pairs sending` : ', no live traffic'}`);
  console.log('  ctrl-c to stop');

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    stopTraffic();
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
