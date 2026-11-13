#!/usr/bin/env node
// Origin-leg stalls: how long each traced dial spent between Cloudflare's edge and the relay, read
// from the relay's CONNECTION_TRACE lines alone. It adds no probe traffic, so it covers every real
// dial the trace still holds: the relay service's log rotation keeps about a week of them, and a
// relay recreate drops them all, so export before either.
//
// The clock is the CF-Ray. Measured on production in 2026-11 (docs/latency.md, "Results,
// 2026-11-12"): a ray's first 10 hex digits rise by about 1600 a second, so they date the moment the
// edge took the request. Cloudflare does not document that, so the script leans on it only as far
// as it was checked:
//   - the offset between the ray clock and the relay's clock drifts by seconds over days, so it is
//     re-anchored every UTC hour as that hour's median of (relay time minus ray time);
//   - each colo's ordinary transit is its median lag, and a dial's excess is its lag minus that
//     median. A colo with fewer than 20 dials gets a fixed 0.5 s instead, so one stall cannot set
//     its own baseline;
//   - an hour where most dials stalled pulls its own anchor up, so a bad hour reads low, not high.
// The excess spans Cloudflare's connection to the origin, Caddy's TLS, and Caddy to the relay. The
// trace's own socketAgeAtUpgradeMs times the last of those (normally well under 1 ms).
//
// Usage, after exporting the lines on the box:
//   docker logs compose-relay-1 2>&1 | grep -F '"connection trace"' > traces.ndjson
//   node scripts/originLegStalls.mjs traces.ndjson
//
// Flags (all optional):
//   --threshold-seconds    excess counted as a stall                        (default 1)
//   --exclude              <startIso>/<endIso> to drop, e.g. a probe's own dials (repeatable)
//   --episode-gap-seconds  stalls closer together than this form one episode (default 120)
//   --top                  largest stalls listed                            (default 10)

import fs from 'node:fs';
import process from 'node:process';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

const RAY_UNITS_PER_SECOND = 1600;
const RARE_COLO_DIALS = 20;
const RARE_COLO_BASELINE_SECONDS = 0.5;
const RAY_PATTERN = /^[0-9a-f]{16}-[A-Z]{3}$/;

function parseArgs(argv) {
  const options = { file: undefined, thresholdSeconds: 1, excludeWindows: [], episodeGapSeconds: 120, top: 10 };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--threshold-seconds') options.thresholdSeconds = Number(value);
    else if (argument === '--episode-gap-seconds') options.episodeGapSeconds = Number(value);
    else if (argument === '--top') options.top = Number(value);
    else if (argument === '--exclude') {
      const [startIso, endIso] = String(value).split('/');
      options.excludeWindows.push({ startMs: Date.parse(startIso), endMs: Date.parse(endIso) });
    } else {
      options.file = argument;
      continue;
    }
    index += 1;
  }
  return options;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function quantile(sortedValues, fraction) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length))];
}

/** Trace lines in, one dial per usable line. A compose log prefix before the JSON is tolerated. */
export function readDials(text, excludeWindows = []) {
  const dials = [];
  for (const line of text.split('\n')) {
    const braceIndex = line.indexOf('{');
    if (braceIndex < 0) continue;
    let trace;
    try {
      trace = JSON.parse(line.slice(braceIndex));
    } catch {
      continue;
    }
    if (trace.message !== 'connection trace' || typeof trace.cfRay !== 'string' || !RAY_PATTERN.test(trace.cfRay)) continue;
    const relayMs = Date.parse(trace.upgradeReceivedAt);
    if (Number.isNaN(relayMs)) continue;
    if (excludeWindows.some((window) => relayMs >= window.startMs && relayMs <= window.endMs)) continue;
    dials.push({
      relayMs,
      ray: trace.cfRay,
      colo: trace.cfRay.slice(-3),
      role: trace.role ?? 'unknown',
      paired: typeof trace.pairedAfterMs === 'number',
      rayUnits: Number.parseInt(trace.cfRay.slice(0, 10), 16),
    });
  }
  return dials.sort((left, right) => left.relayMs - right.relayMs);
}

/** Sets `excessSeconds` on every dial: its edge-to-relay time over its colo's ordinary transit. */
export function measureExcess(dials) {
  const hourOf = (dial) => Math.floor(dial.relayMs / 3_600_000);
  const offsetsByHour = new Map();
  for (const dial of dials) {
    dial.rawOffsetSeconds = dial.relayMs / 1000 - dial.rayUnits / RAY_UNITS_PER_SECOND;
    const hour = hourOf(dial);
    if (!offsetsByHour.has(hour)) offsetsByHour.set(hour, []);
    offsetsByHour.get(hour).push(dial.rawOffsetSeconds);
  }
  const anchorByHour = new Map([...offsetsByHour].map(([hour, offsets]) => [hour, median(offsets)]));
  const lagsByColo = new Map();
  for (const dial of dials) {
    dial.lagSeconds = dial.rawOffsetSeconds - anchorByHour.get(hourOf(dial));
    if (!lagsByColo.has(dial.colo)) lagsByColo.set(dial.colo, []);
    lagsByColo.get(dial.colo).push(dial.lagSeconds);
  }
  const baselineByColo = new Map(
    [...lagsByColo].map(([colo, lags]) => [colo, lags.length < RARE_COLO_DIALS ? RARE_COLO_BASELINE_SECONDS : median(lags)]),
  );
  for (const dial of dials) dial.excessSeconds = dial.lagSeconds - baselineByColo.get(dial.colo);
  return { hours: offsetsByHour.size, colos: lagsByColo.size, dialsByColo: new Map([...lagsByColo].map(([colo, lags]) => [colo, lags.length])) };
}

/** Groups stalled dials into episodes: a gap longer than `gapSeconds` starts a new one. */
export function groupEpisodes(stalledDials, gapSeconds) {
  const episodes = [];
  for (const dial of stalledDials) {
    const current = episodes[episodes.length - 1];
    if (current && dial.relayMs - current.endMs <= gapSeconds * 1000) {
      current.endMs = dial.relayMs;
      current.stalls.push(dial);
    } else {
      episodes.push({ startMs: dial.relayMs, endMs: dial.relayMs, stalls: [dial] });
    }
  }
  return episodes;
}

function report(options) {
  const dials = readDials(fs.readFileSync(options.file, 'utf8'), options.excludeWindows);
  if (dials.length === 0) {
    console.log('no usable trace lines (need "connection trace" lines with a CF-Ray)');
    return;
  }
  const { hours, colos, dialsByColo } = measureExcess(dials);
  const isoSeconds = (milliseconds) => new Date(milliseconds).toISOString().slice(0, 19) + 'Z';
  const threshold = options.thresholdSeconds;
  const share = (count, total) => `${count}/${total} (${((100 * count) / Math.max(1, total)).toFixed(2)}%)`;
  const stalledIn = (selected) => selected.filter((dial) => dial.excessSeconds > threshold).length;

  console.log(`dials ${dials.length}, ${isoSeconds(dials[0].relayMs)} to ${isoSeconds(dials[dials.length - 1].relayMs)}, ${hours} hours, ${colos} colos`);
  const excesses = dials.map((dial) => dial.excessSeconds).sort((left, right) => left - right);
  console.log(`excess over colo transit (s): p50 ${quantile(excesses, 0.5).toFixed(3)} p99 ${quantile(excesses, 0.99).toFixed(3)} p99.9 ${quantile(excesses, 0.999).toFixed(3)} max ${excesses[excesses.length - 1].toFixed(3)}`);
  for (const level of [0.5, 1, 2, 5]) console.log(`  over ${level} s: ${share(dials.filter((dial) => dial.excessSeconds > level).length, dials.length)}`);
  const pairedDials = dials.filter((dial) => dial.paired);
  console.log(`dials that went on to pair, over ${threshold} s: ${share(stalledIn(pairedDials), pairedDials.length)}`);

  console.log(`\nby UTC day, over ${threshold} s:`);
  const dayOf = (dial) => new Date(dial.relayMs).toISOString().slice(0, 10);
  for (const day of [...new Set(dials.map(dayOf))]) {
    const dayDials = dials.filter((dial) => dayOf(dial) === day);
    console.log(`  ${day}: ${share(stalledIn(dayDials), dayDials.length)}`);
  }

  const stalled = dials.filter((dial) => dial.excessSeconds > threshold);
  const stallsByColo = new Map();
  for (const dial of stalled) stallsByColo.set(dial.colo, (stallsByColo.get(dial.colo) ?? 0) + 1);
  console.log(`\nstalls by colo (stalls/dials): ${[...stallsByColo].sort((left, right) => right[1] - left[1]).slice(0, 15).map(([colo, count]) => `${colo} ${count}/${dialsByColo.get(colo)}`).join(', ') || 'none'}`);

  const episodes = groupEpisodes(stalled, options.episodeGapSeconds);
  const large = episodes.filter((episode) => episode.stalls.length >= 10);
  console.log(`\nepisodes ${episodes.length}; with 10+ stalls ${large.length}, holding ${large.reduce((sum, episode) => sum + episode.stalls.length, 0)} of ${stalled.length} stalls`);
  for (const episode of large) {
    const windowDials = dials.filter((dial) => dial.relayMs >= episode.startMs && dial.relayMs <= episode.endMs);
    const excessValues = episode.stalls.map((dial) => dial.excessSeconds);
    console.log(`  ${isoSeconds(episode.startMs)} to ${isoSeconds(episode.endMs)}: ${share(episode.stalls.length, windowDials.length)}, ${new Set(episode.stalls.map((dial) => dial.colo)).size} colos, excess median ${median(excessValues).toFixed(1)} max ${Math.max(...excessValues).toFixed(1)} s`);
  }

  console.log(`\nlargest ${options.top}:`);
  for (const dial of [...stalled].sort((left, right) => right.excessSeconds - left.excessSeconds).slice(0, options.top)) {
    console.log(`  ${new Date(dial.relayMs).toISOString()} ${dial.ray} ${dial.role} excess ${dial.excessSeconds.toFixed(2)} s`);
  }
}

if (isEntrypoint(import.meta.url)) {
  const options = parseArgs(process.argv);
  if (!options.file) {
    console.error('usage: node scripts/originLegStalls.mjs <traces.ndjson> [--threshold-seconds 1] [--exclude <startIso>/<endIso>] [--episode-gap-seconds 120] [--top 10]');
    process.exit(2);
  }
  report(options);
}
