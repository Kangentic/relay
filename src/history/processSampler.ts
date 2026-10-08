import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { monitorEventLoopDelay, PerformanceObserver, type IntervalHistogram } from 'node:perf_hooks';

/**
 * Process health that neither the Hetzner console nor the Cloudflare dashboard
 * can see, because both observe the box and the edge rather than this process.
 *
 * Every field below the RSS ones answers one question: when a client saw a
 * multi-second stall, did this process, the runtime, or the VM under it stall
 * too? A null means "not measured here" (no procfs on win32, PSI disabled in
 * the kernel), never "zero".
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
  /**
   * The single worst event loop delay in the window. One three-second freeze
   * in a minute is ONE sample out of ~3000, which p99 by construction cannot
   * see; this is the field that can.
   */
  readonly eventLoopLagMaxMs: number | null;
  /** The longest garbage collection pause in the window, 0 when none ran. */
  readonly gcPauseMaxMs: number | null;
  /**
   * Host CPU ticks stolen by the hypervisor in the window, and all host CPU
   * ticks in it, from /proc/stat. Kept as the raw pair so a reader computes
   * steal % without assuming a tick length. Some hypervisors never report
   * steal at all, which reads as a steady 0 rather than null: the kernel has
   * no way to say "unknown" here, so a 0 is weak evidence on its own.
   */
  readonly hostCpuStealTicksDelta: number | null;
  readonly hostCpuTotalTicksDelta: number | null;
  /**
   * Milliseconds of the window in which at least some host tasks were stalled
   * on CPU, memory, or IO, from the PSI "some" totals in /proc/pressure.
   */
  readonly pressureCpuSomeMs: number | null;
  readonly pressureMemorySomeMs: number | null;
  readonly pressureIoSomeMs: number | null;
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
  /**
   * Reads one procfs file, returning null when it is absent or unreadable.
   * Overridden in tests so the parsers run on win32, which has no procfs.
   */
  readonly readProcFile?: (path: string) => string | null;
}

export interface HostCpuTicks {
  readonly steal: number;
  readonly total: number;
}

const PROC_STAT_PATH = '/proc/stat';
const PRESSURE_PATHS = {
  cpu: '/proc/pressure/cpu',
  memory: '/proc/pressure/memory',
  io: '/proc/pressure/io',
} as const;

type PressureResource = keyof typeof PRESSURE_PATHS;
type PressureTotals = Readonly<Record<PressureResource, number | null>>;

/**
 * The aggregate "cpu" line of /proc/stat: user nice system idle iowait irq
 * softirq steal guest guest_nice. The total is the first eight columns only,
 * because guest and guest_nice are already counted inside user and nice.
 */
export function parseHostCpuTicks(procStat: string): HostCpuTicks | null {
  const firstLine = procStat.split('\n', 1)[0] ?? '';
  const fields = firstLine.trim().split(/\s+/);
  if (fields[0] !== 'cpu' || fields.length < 9) return null;
  const columns = fields.slice(1, 9).map(Number);
  if (columns.some((column) => !Number.isFinite(column) || column < 0)) return null;
  const steal = columns[7];
  if (steal === undefined) return null;
  return { steal, total: columns.reduce((sum, column) => sum + column, 0) };
}

/**
 * The cumulative "some" stall total from one /proc/pressure file, in
 * microseconds: "some avg10=0.00 avg60=0.00 avg300=0.00 total=12345".
 */
export function parsePressureSomeTotalMicroseconds(pressureFile: string): number | null {
  const match = /^some\b.*\btotal=(\d+)/m.exec(pressureFile);
  if (match?.[1] === undefined) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

/**
 * Synchronous on purpose. procfs files are generated from kernel memory on
 * read and never touch a disk, this runs once per recorder interval, and a
 * synchronous read keeps sample() synchronous like the guarded timer that
 * calls it, rather than smearing a reading across two windows.
 */
function readProcFileFromDisk(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** A counter delta, null unless both readings exist. Clamped so a reset cannot read negative. */
function counterDeltaOrNull(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Math.max(0, current - previous);
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
 * Samples CPU, event loop delay, GC pauses, host stall signals, and RSS on the
 * recorder's cadence. Built only when the recorder is built, so a relay with
 * the dashboard off never installs the event loop delay monitor's libuv timer
 * or the GC observer.
 */
export function createProcessSampler(deps: ProcessSamplerDeps = {}): ProcessSampler {
  const now = deps.now ?? Date.now;
  const readProcFile = deps.readProcFile ?? readProcFileFromDisk;

  // resolution 20ms rather than the 10ms default: half the wakeups, and a
  // 60-second window still collects ~3000 samples, which is ample for a p99.
  // The max needs no extra samples: a freeze delays the one timer that was
  // due, and that single sample carries the whole freeze.
  const eventLoopDelayHistogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelayHistogram.enable();

  // One observer for the life of the recorder. Node notes that observers carry
  // their own overhead and should not be left subscribed indefinitely; this
  // one is bounded by the recorder's life, disconnected in stop(), and costs
  // one callback per GC, never anything per frame. Entries are delivered
  // asynchronously, so a GC in the last instant of a window can land in the
  // next one, which moves it by one row and loses nothing.
  let longestGcPauseInWindowMs = 0;
  let gcObserver: PerformanceObserver | null = null;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > longestGcPauseInWindowMs) longestGcPauseInWindowMs = entry.duration;
      }
    });
    gcObserver.observe({ type: 'gc' });
  } catch {
    gcObserver = null;
  }

  function readHostCpuTicks(): HostCpuTicks | null {
    const procStat = readProcFile(PROC_STAT_PATH);
    return procStat === null ? null : parseHostCpuTicks(procStat);
  }

  function readPressureTotals(): PressureTotals {
    const readOne = (resource: PressureResource): number | null => {
      const pressureFile = readProcFile(PRESSURE_PATHS[resource]);
      return pressureFile === null ? null : parsePressureSomeTotalMicroseconds(pressureFile);
    };
    return { cpu: readOne('cpu'), memory: readOne('memory'), io: readOne('io') };
  }

  function pressureMsOrNull(current: number | null, previous: number | null): number | null {
    const deltaMicroseconds = counterDeltaOrNull(current, previous);
    return deltaMicroseconds === null ? null : roundToTenth(deltaMicroseconds / 1000);
  }

  let previousCpuUsage = process.cpuUsage();
  let previousSampledAtMs = now();
  // Baselines taken at construction, not on the first tick, so the first row
  // covers its own window rather than everything since boot.
  let previousHostCpuTicks = readHostCpuTicks();
  let previousPressureTotals = readPressureTotals();
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

      // percentile() and max are nanoseconds. Guard on count rather than
      // trusting the return value of an empty histogram.
      const histogramIsEmpty = eventLoopDelayHistogram.count === 0;
      const eventLoopLagP99Ms = histogramIsEmpty
        ? null
        : roundToTenth(eventLoopDelayHistogram.percentile(99) / 1_000_000);
      const eventLoopLagMaxMs = histogramIsEmpty ? null : roundToTenth(eventLoopDelayHistogram.max / 1_000_000);
      eventLoopDelayHistogram.reset();

      const gcPauseMaxMs = gcObserver === null ? null : roundToTenth(longestGcPauseInWindowMs);
      longestGcPauseInWindowMs = 0;

      const currentHostCpuTicks = readHostCpuTicks();
      const hostCpuStealTicksDelta = counterDeltaOrNull(
        currentHostCpuTicks?.steal ?? null,
        previousHostCpuTicks?.steal ?? null,
      );
      const hostCpuTotalTicksDelta = counterDeltaOrNull(
        currentHostCpuTicks?.total ?? null,
        previousHostCpuTicks?.total ?? null,
      );
      previousHostCpuTicks = currentHostCpuTicks;

      const currentPressureTotals = readPressureTotals();
      const pressureCpuSomeMs = pressureMsOrNull(currentPressureTotals.cpu, previousPressureTotals.cpu);
      const pressureMemorySomeMs = pressureMsOrNull(currentPressureTotals.memory, previousPressureTotals.memory);
      const pressureIoSomeMs = pressureMsOrNull(currentPressureTotals.io, previousPressureTotals.io);
      previousPressureTotals = currentPressureTotals;

      const rssBytes = process.memoryUsage.rss();
      const rssPercent =
        containerMemoryLimitBytes === null ? null : roundToTenth((rssBytes / containerMemoryLimitBytes) * 100);

      latestSample = {
        cpuPercent,
        eventLoopLagP99Ms,
        eventLoopLagMaxMs,
        gcPauseMaxMs,
        hostCpuStealTicksDelta,
        hostCpuTotalTicksDelta,
        pressureCpuSomeMs,
        pressureMemorySomeMs,
        pressureIoSomeMs,
        rssBytes,
        rssPercent,
        windowMs,
        sampledAtMs: nowMs,
      };
      return latestSample;
    },
    latest: () => latestSample,
    containerMemoryLimitBytes: () => containerMemoryLimitBytes,
    stop: () => {
      eventLoopDelayHistogram.disable();
      gcObserver?.disconnect();
    },
  };
}
