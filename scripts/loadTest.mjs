#!/usr/bin/env node
// Load-test harness for the relay: spawns N concurrent slot pairs, pumps M
// frames of S bytes through each pair with a send timestamp in the first 8
// bytes, and reports relay-added latency percentiles, aggregate throughput,
// and the relay process RSS before/after (read from /metricz).
//
// Usage:
//   node scripts/loadTest.mjs --url ws://127.0.0.1:18080 --pairs 50 --frames 500 --size 512
//
// Flags (all optional):
//   --url                  relay WebSocket URL          (default ws://127.0.0.1:18080)
//   --pairs                concurrent slot pairs        (default 50)
//   --frames               frames sent per pair         (default 500)
//   --size                 bytes per frame, minimum 16  (default 512)
//   --rate                 frames per second per pair; 0 floods as fast as
//                          the in-flight window allows. Use a paced rate to
//                          measure relay-added latency and a flood to
//                          measure max throughput; a flooded run reports
//                          queueing delay, not relay overhead (default 0)
//   --window               end-to-end flow control: max frames a producer
//                          may be ahead of its consumer. Keeps a flood from
//                          ballooning the relay's outbound buffers into the
//                          MAX_BUFFERED_BYTES teardown    (default 64)
//   --connect-concurrency  pairs connected in parallel  (default 50)
//   --inflight-bytes       producer-side send buffer high-water mark before
//                          pausing                       (default 262144)
//   --timeout-ms           overall run timeout          (default 120000)
//   --metrics-token        bearer token for /metricz, if the target
//                          instance sets METRICS_TOKEN. Also read from the
//                          RELAY_METRICS_TOKEN env var; the flag wins.
//                          Without it, /metricz calls 401 and the RSS
//                          delta in the results is silently omitted.
//
// Run it against a dedicated relay instance started with generous limits,
// never against a production or dev-rig instance. Example instance env:
//   PORT=18080 MAX_CONNECTIONS=25000 MAX_CONNECTIONS_PER_IP=25000
//   RATE_LIMIT_IP_PER_MIN=1000000 RATE_LIMIT_IP_BURST=100000 LOG_LEVEL=warn
//
// The script needs no dependencies beyond the relay's own `ws` package.

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { WebSocket } from 'ws';

function parseArgs(argv) {
  const options = {
    url: 'ws://127.0.0.1:18080',
    pairs: 50,
    frames: 500,
    size: 512,
    rate: 0,
    window: 64,
    connectConcurrency: 50,
    inflightBytes: 262_144,
    timeoutMs: 120_000,
    metricsToken: process.env.RELAY_METRICS_TOKEN ?? '',
  };
  const integerFlags = new Map([
    ['--pairs', 'pairs'],
    ['--frames', 'frames'],
    ['--size', 'size'],
    ['--rate', 'rate'],
    ['--window', 'window'],
    ['--connect-concurrency', 'connectConcurrency'],
    ['--inflight-bytes', 'inflightBytes'],
    ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let argumentIndex = 2; argumentIndex < argv.length; argumentIndex += 1) {
    const flag = argv[argumentIndex];
    const value = argv[argumentIndex + 1];
    if (flag === '--url') {
      if (value === undefined) throw new Error('--url needs a value');
      options.url = value;
      argumentIndex += 1;
      continue;
    }
    if (flag === '--metrics-token') {
      if (value === undefined) throw new Error('--metrics-token needs a value');
      options.metricsToken = value;
      argumentIndex += 1;
      continue;
    }
    const optionName = integerFlags.get(flag);
    if (!optionName) throw new Error(`Unknown flag: ${flag}`);
    const parsed = Number(value);
    // --rate 0 is documented flood mode, so it alone accepts zero.
    const minimumValue = flag === '--rate' ? 0 : 1;
    if (!Number.isInteger(parsed) || parsed < minimumValue) {
      throw new Error(`${flag} needs ${minimumValue === 0 ? 'a non-negative' : 'a positive'} integer, got "${value}"`);
    }
    options[optionName] = parsed;
    argumentIndex += 1;
  }
  if (options.size < 16) throw new Error('--size must be at least 16 (8 timestamp bytes + margin)');
  return options;
}

function metricsBaseUrl(wsUrl) {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

async function fetchMetricz(wsUrl, metricsToken) {
  try {
    const headers = metricsToken ? { Authorization: `Bearer ${metricsToken}` } : {};
    const response = await fetch(`${metricsBaseUrl(wsUrl)}/metricz`, { headers });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function openSocket(url, slot) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url}?slot=${slot}`, { perMessageDeflate: false });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('close', (code, reason) => reject(new Error(`closed before open: ${code} ${reason}`)));
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectPair(url, pairIndex, state) {
  const slot = randomBytes(32).toString('hex');
  const consumer = await openSocket(url, slot);
  const producer = await openSocket(url, slot);
  // Post-open socket errors surface through the 'close' handlers below; a
  // listener must exist or Node treats the 'error' event as fatal.
  consumer.on('error', () => {});
  producer.on('error', () => {});
  consumer.on('message', (data) => {
    const sentAt = data.readDoubleLE(0);
    const sampleIndex = state.samplesFilled;
    if (sampleIndex < state.latencies.length) {
      state.latencies[sampleIndex] = performance.now() - sentAt;
      state.samplesFilled += 1;
    }
    state.receivedByPair[pairIndex] += 1;
    if (state.receivedByPair[pairIndex] === state.framesPerPair) state.onPairDone();
  });
  const failPair = (label) => (code) => {
    if (state.finished) return;
    state.onPairFailed(new Error(`pair ${pairIndex} ${label} socket closed early (code ${code})`));
  };
  consumer.on('close', failPair('consumer'));
  producer.on('close', failPair('producer'));
  return { producer, consumer };
}

async function produce(producerSocket, pairIndex, options, bufferPool, state) {
  const intervalMs = options.rate > 0 ? 1000 / options.rate : 0;
  const pacingStartedAt = performance.now();
  for (let frameIndex = 0; frameIndex < options.frames; frameIndex += 1) {
    if (intervalMs > 0) {
      const targetTime = pacingStartedAt + frameIndex * intervalMs;
      const waitMs = targetTime - performance.now();
      if (waitMs > 0) await sleep(waitMs);
    }
    while (
      frameIndex - state.receivedByPair[pairIndex] >= options.window ||
      producerSocket.bufferedAmount > options.inflightBytes
    ) {
      if (state.finished) return;
      await sleep(1);
    }
    if (producerSocket.readyState !== WebSocket.OPEN) return;
    // Buffers rotate through a pool deep enough that a frame is never
    // rewritten (or re-masked) while still queued on the socket.
    const frame = bufferPool[frameIndex % bufferPool.length];
    frame.writeDoubleLE(performance.now(), 0);
    producerSocket.send(frame);
  }
}

function percentile(sortedSamples, fraction) {
  if (sortedSamples.length === 0) return 0;
  const index = Math.min(sortedSamples.length - 1, Math.ceil(fraction * sortedSamples.length) - 1);
  return sortedSamples[Math.max(0, index)];
}

function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function main() {
  const options = parseArgs(process.argv);
  const totalFrames = options.pairs * options.frames;

  const paceLabel = options.rate > 0 ? `${options.rate} frames/s per pair` : 'flood';
  console.log(
    `relay load test: ${options.pairs} pairs x ${options.frames} frames x ${options.size} B (${paceLabel}) against ${options.url}`,
  );

  const metricsBefore = await fetchMetricz(options.url, options.metricsToken);
  if (!metricsBefore) {
    console.log('note: /metricz not reachable before the run; RSS delta will be unavailable');
  }

  const state = {
    latencies: new Float64Array(totalFrames),
    samplesFilled: 0,
    receivedByPair: new Uint32Array(options.pairs),
    framesPerPair: options.frames,
    finished: false,
    pairsDone: 0,
    onPairDone: () => {},
    onPairFailed: () => {},
  };

  const allDone = new Promise((resolve, reject) => {
    state.onPairDone = () => {
      state.pairsDone += 1;
      if (state.pairsDone === options.pairs) resolve();
    };
    state.onPairFailed = reject;
  });

  const pairs = [];
  for (let batchStart = 0; batchStart < options.pairs; batchStart += options.connectConcurrency) {
    const batch = [];
    for (let pairIndex = batchStart; pairIndex < Math.min(batchStart + options.connectConcurrency, options.pairs); pairIndex += 1) {
      batch.push(connectPair(options.url, pairIndex, state));
    }
    pairs.push(...(await Promise.all(batch)));
  }
  console.log(`connected ${pairs.length} pairs (${pairs.length * 2} sockets)`);

  const poolDepth = Math.ceil(options.inflightBytes / options.size) + 8;
  const startedAt = performance.now();

  const producers = pairs.map((pair, pairIndex) => {
    const bufferPool = Array.from({ length: poolDepth }, () => {
      const frame = Buffer.allocUnsafe(options.size);
      frame.fill(0xab);
      return frame;
    });
    return produce(pair.producer, pairIndex, options, bufferPool, state);
  });

  const timeout = setTimeout(() => {
    state.onPairFailed(new Error(`run exceeded ${options.timeoutMs} ms (${state.samplesFilled}/${totalFrames} frames arrived)`));
  }, options.timeoutMs);

  try {
    await Promise.all([allDone, ...producers]);
  } finally {
    clearTimeout(timeout);
    state.finished = true;
    for (const pair of pairs) {
      pair.producer.terminate();
      pair.consumer.terminate();
    }
  }

  const elapsedMs = performance.now() - startedAt;
  const metricsAfter = await fetchMetricz(options.url, options.metricsToken);

  const sortedLatencies = state.latencies.slice(0, state.samplesFilled).sort();
  const totalBytes = totalFrames * options.size;
  const megabytesPerSecond = totalBytes / (1024 * 1024) / (elapsedMs / 1000);
  const framesPerSecond = totalFrames / (elapsedMs / 1000);

  console.log('');
  console.log('results');
  console.log(`  frames delivered   ${state.samplesFilled} / ${totalFrames}`);
  console.log(`  elapsed            ${(elapsedMs / 1000).toFixed(2)} s`);
  console.log(`  throughput         ${megabytesPerSecond.toFixed(1)} MB/s, ${Math.round(framesPerSecond)} frames/s`);
  console.log(`  latency p50        ${percentile(sortedLatencies, 0.5).toFixed(2)} ms`);
  console.log(`  latency p95        ${percentile(sortedLatencies, 0.95).toFixed(2)} ms`);
  console.log(`  latency p99        ${percentile(sortedLatencies, 0.99).toFixed(2)} ms`);
  if (metricsBefore && metricsAfter) {
    console.log(`  relay RSS before   ${formatMegabytes(metricsBefore.rssBytes)} MB`);
    console.log(`  relay RSS after    ${formatMegabytes(metricsAfter.rssBytes)} MB`);
    console.log(`  relay frames total ${metricsAfter.framesForwardedTotal - metricsBefore.framesForwardedTotal} forwarded during run`);
  }
}

main().catch((error) => {
  console.error(`load test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
