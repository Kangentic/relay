import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/**
 * Process health that neither the Hetzner console nor the Cloudflare dashboard
 * can see, because both observe the box and the edge rather than this process.
 */
export interface ProcessSample {
  /**
   * Percent of ONE core over the sample window. Deliberately not clamped to
   * 100: process.cpuUsage() covers every thread, so a saturated libuv
   * threadpool legitimately reads above 100, and clamping would hide one of
   * the few problems this surface is uniquely placed to reveal.
   */
  readonly cpuPercent: number;
  /** p99 event loop delay over the sample window, or null before any sample. */
  readonly eventLoopLagP99Ms: number | null;
  readonly rssBytes: number;
  /** RSS against the resolved container limit, null when no limit is knowable. */
  readonly rssPercent: number | null;
  readonly windowMs: number;
  readonly sampledAtMs: number;
}

export interface ProcessSampler {
  /** Reads and resets the window. Only the recorder tick may call this. */
  sample(nowMs: number): ProcessSample;
  /** The last sampled value, for readers that must not disturb the window. */
  latest(): ProcessSample | null;
  /** The resolved container memory ceiling, or null while unresolved or unknowable. */
  containerMemoryLimitBytes(): number | null;
  stop(): void;
}

export interface ProcessSamplerDeps {
  readonly now?: () => number;
  /** Overrides cgroup discovery in tests. */
  readonly containerMemoryLimitBytes?: number | null;
}

/**
 * A cgroup limit is only believable if it is a positive integer that is not
 * wildly larger than the machine. That single bound rejects both cgroup v1's
 * "unlimited" sentinel (a near-2^63 value) and any parse accident, without
 * hardcoding a magic number that a future kernel could change.
 */
export function isBelievableMemoryLimit(candidate: number): boolean {
  if (!Number.isFinite(candidate) || !Number.isInteger(candidate) || candidate <= 0) return false;
  return candidate <= totalmem() * 2;
}

async function readMemoryLimitFrom(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    // cgroup v2 writes the literal string "max" when unlimited, which parses
    // to NaN and is rejected below.
    const parsed = Number(raw);
    return isBelievableMemoryLimit(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * cgroup v2, then cgroup v1, then the machine's total memory, then null.
 * On win32 both cgroup paths are absent, so local development and CI exercise
 * the totalmem fallback rather than the container path.
 */
async function resolveContainerMemoryLimit(): Promise<number | null> {
  const version2 = await readMemoryLimitFrom('/sys/fs/cgroup/memory.max');
  if (version2 !== null) return version2;
  const version1 = await readMemoryLimitFrom('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (version1 !== null) return version1;
  const machineTotal = totalmem();
  return isBelievableMemoryLimit(machineTotal) ? machineTotal : null;
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Samples CPU, event loop delay, and RSS on the recorder's cadence. Built only
 * when the recorder is built, so a relay with the dashboard off never installs
 * the event loop delay monitor's libuv timer.
 */
export function createProcessSampler(deps: ProcessSamplerDeps = {}): ProcessSampler {
  const now = deps.now ?? Date.now;

  // resolution 20ms rather than the 10ms default: half the wakeups, and a
  // 60-second window still collects ~3000 samples, which is ample for a p99.
  const eventLoopDelayHistogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelayHistogram.enable();

  let previousCpuUsage = process.cpuUsage();
  let previousSampledAtMs = now();
  let latestSample: ProcessSample | null = null;

  let containerMemoryLimitBytes: number | null = deps.containerMemoryLimitBytes ?? null;
  if (deps.containerMemoryLimitBytes === undefined) {
    // Resolved once, off the hot path and off the request path. Until it
    // lands, rssPercent reports null rather than guessing.
    void resolveContainerMemoryLimit().then(
      (limit) => {
        containerMemoryLimitBytes = limit;
      },
      () => {
        containerMemoryLimitBytes = null;
      },
    );
  }

  return {
    sample: (nowMs) => {
      // One read, differenced by hand. Calling cpuUsage(previous) and then
      // cpuUsage() again would sample twice and silently drop the microseconds
      // between the two calls, biasing the whole series low forever.
      const currentCpuUsage = process.cpuUsage();
      const userMicroseconds = currentCpuUsage.user - previousCpuUsage.user;
      const systemMicroseconds = currentCpuUsage.system - previousCpuUsage.system;
      previousCpuUsage = currentCpuUsage;

      const windowMs = Math.max(1, nowMs - previousSampledAtMs);
      previousSampledAtMs = nowMs;

      const cpuPercent = roundToTenth(((userMicroseconds + systemMicroseconds) / (windowMs * 1000)) * 100);

      // percentile() returns nanoseconds. Guard on count rather than trusting
      // the return value of an empty histogram.
      const eventLoopLagP99Ms =
        eventLoopDelayHistogram.count === 0
          ? null
          : roundToTenth(eventLoopDelayHistogram.percentile(99) / 1_000_000);
      eventLoopDelayHistogram.reset();

      const rssBytes = process.memoryUsage.rss();
      const rssPercent =
        containerMemoryLimitBytes === null ? null : roundToTenth((rssBytes / containerMemoryLimitBytes) * 100);

      latestSample = { cpuPercent, eventLoopLagP99Ms, rssBytes, rssPercent, windowMs, sampledAtMs: nowMs };
      return latestSample;
    },
    latest: () => latestSample,
    containerMemoryLimitBytes: () => containerMemoryLimitBytes,
    stop: () => eventLoopDelayHistogram.disable(),
  };
}
