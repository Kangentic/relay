import { totalmem } from 'node:os';
import { PerformanceObserver } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProcessSampler,
  isBelievableMemoryLimit,
  parseHostCpuTicks,
  parsePressureSomeTotalMicroseconds,
  type ProcessSampler,
} from '../src/history/processSampler.js';

/** Blocks the event loop for roughly the given time, the way a frozen process would. */
function blockEventLoop(milliseconds: number): void {
  const until = performance.now() + milliseconds;
  while (performance.now() < until) {
    // spin
  }
}

function yieldToTimers(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** A fake procfs whose counters can be advanced between samples. */
function fakeProcfs(): {
  files: Map<string, string>;
  setStat(steal: number, otherTicks: number): void;
  setPressure(resource: 'cpu' | 'memory' | 'io', someTotalMicroseconds: number): void;
  read(path: string): string | null;
} {
  const files = new Map<string, string>();
  return {
    files,
    setStat: (steal, otherTicks) => {
      // user nice system idle iowait irq softirq steal guest guest_nice
      files.set('/proc/stat', `cpu  ${otherTicks} 0 0 0 0 0 0 ${steal} 5 5\ncpu0 1 2 3 4 5 6 7 8 9 10\n`);
    },
    setPressure: (resource, someTotalMicroseconds) => {
      files.set(
        `/proc/pressure/${resource}`,
        `some avg10=0.00 avg60=0.00 avg300=0.00 total=${someTotalMicroseconds}\n` +
          'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
      );
    },
    read: (path) => files.get(path) ?? null,
  };
}

const CONTAINER_LIMIT_BYTES = 1_258_291_200; // 1200m, the production mem_limit

let sampler: ProcessSampler | undefined;

afterEach(() => {
  // Always release the event loop delay monitor's libuv timer.
  sampler?.stop();
  sampler = undefined;
});

describe('container memory limit validation', () => {
  it('accepts a plausible limit', () => {
    expect(isBelievableMemoryLimit(CONTAINER_LIMIT_BYTES)).toBe(true);
  });

  it('rejects the cgroup v1 unlimited sentinel', () => {
    // cgroup v1 reports "no limit" as a near-2^63 value. Taken at face value it
    // would make rssPercent a permanent 0.0 and hide an approaching OOM.
    expect(isBelievableMemoryLimit(9_223_372_036_854_771_712)).toBe(false);
  });

  it('rejects anything that is not a positive integer', () => {
    // cgroup v2 writes the literal string "max", which parses to NaN.
    expect(isBelievableMemoryLimit(Number.NaN)).toBe(false);
    expect(isBelievableMemoryLimit(0)).toBe(false);
    expect(isBelievableMemoryLimit(-1)).toBe(false);
    expect(isBelievableMemoryLimit(1.5)).toBe(false);
    expect(isBelievableMemoryLimit(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('accepts the machine total, which is the fallback on a host without cgroups', () => {
    // win32 has neither cgroup path, so this is the branch local development
    // and CI actually take.
    expect(isBelievableMemoryLimit(totalmem())).toBe(true);
  });
});

describe('process sampler', () => {
  it('reports nothing until the first sample is taken', () => {
    sampler = createProcessSampler({ now: () => 1_000_000, containerMemoryLimitBytes: null });
    expect(sampler.latest()).toBeNull();
  });

  it('measures the window from the previous sample, not from process start', () => {
    let currentTimeMs = 1_000_000;
    sampler = createProcessSampler({ now: () => currentTimeMs, containerMemoryLimitBytes: null });

    currentTimeMs += 60_000;
    expect(sampler.sample(currentTimeMs).windowMs).toBe(60_000);

    // The second window is measured from the first sample, so a series of ticks
    // cannot accumulate drift into the rate denominator.
    currentTimeMs += 15_000;
    expect(sampler.sample(currentTimeMs).windowMs).toBe(15_000);
  });

  it('expresses RSS against the container limit when one is known', () => {
    sampler = createProcessSampler({
      now: () => 1_000_000,
      containerMemoryLimitBytes: CONTAINER_LIMIT_BYTES,
    });
    const sample = sampler.sample(1_060_000);

    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.rssPercent).not.toBeNull();
    expect(sample.rssPercent).toBeCloseTo((sample.rssBytes / CONTAINER_LIMIT_BYTES) * 100, 1);
  });

  it('reports a null percentage rather than guessing when no limit is knowable', () => {
    sampler = createProcessSampler({ now: () => 1_000_000, containerMemoryLimitBytes: null });
    const sample = sampler.sample(1_060_000);

    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.rssPercent).toBeNull();
  });

  it('produces a finite, non-negative CPU percentage', () => {
    let currentTimeMs = 1_000_000;
    sampler = createProcessSampler({ now: () => currentTimeMs, containerMemoryLimitBytes: null });

    currentTimeMs += 60_000;
    const sample = sampler.sample(currentTimeMs);

    expect(Number.isFinite(sample.cpuPercent)).toBe(true);
    expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
    // Deliberately NOT clamped to 100: cpuUsage() covers every thread, so a
    // saturated threadpool legitimately exceeds one core's worth.
  });

  it('remembers the last sample so readers never disturb the sampling window', () => {
    let currentTimeMs = 1_000_000;
    sampler = createProcessSampler({ now: () => currentTimeMs, containerMemoryLimitBytes: null });

    currentTimeMs += 60_000;
    const taken = sampler.sample(currentTimeMs);

    // /metricz reads this rather than the histogram, so a scrape can never
    // steal the interval the recorder is accumulating.
    expect(sampler.latest()).toEqual(taken);
    expect(sampler.latest()).toEqual(taken);
  });

  it('reports event loop delay as null or a non-negative duration', () => {
    let currentTimeMs = 1_000_000;
    sampler = createProcessSampler({ now: () => currentTimeMs, containerMemoryLimitBytes: null });

    currentTimeMs += 60_000;
    const { eventLoopLagP99Ms } = sampler.sample(currentTimeMs);

    // Null when the histogram recorded nothing in the window; never a bogus
    // zero-or-negative reading from an empty histogram.
    if (eventLoopLagP99Ms !== null) expect(eventLoopLagP99Ms).toBeGreaterThanOrEqual(0);
  });

  it('sees a single long stall in the max that the p99 cannot see', async () => {
    // The bug this field exists for: a freeze delays exactly one of the
    // monitor's timer samples, so in a window of thousands it never reaches
    // the p99. Production read p99 21.3 ms for a week straight while clients
    // saw multi-second stalls.
    sampler = createProcessSampler({ containerMemoryLimitBytes: null, readProcFile: () => null });
    // At the 20 ms resolution this is ~125 ordinary samples, enough that one
    // stalled sample sits above the 99th percentile, as it does in a real
    // 60 s window of ~3000.
    await yieldToTimers(2_500);
    blockEventLoop(250);
    await yieldToTimers(60); // the delayed timer fires and records the stall

    const sample = sampler.sample(Date.now());

    expect(sample.eventLoopLagMaxMs).not.toBeNull();
    expect(sample.eventLoopLagMaxMs).toBeGreaterThanOrEqual(150);
    expect(sample.eventLoopLagP99Ms).not.toBeNull();
    // Relative, not an absolute ceiling: a shared CI runner can add its own
    // 100 ms hiccup, which would land at p99 here. What has to hold is that
    // the freeze is above the 99th percentile, which is the blind spot.
    expect(sample.eventLoopLagP99Ms ?? Number.POSITIVE_INFINITY).toBeLessThan(sample.eventLoopLagMaxMs ?? 0);
  }, 10_000);

  it('resets the max with the window, so one stall is reported once', async () => {
    sampler = createProcessSampler({ containerMemoryLimitBytes: null, readProcFile: () => null });
    await yieldToTimers(50);
    blockEventLoop(200);
    await yieldToTimers(60);
    const stalled = sampler.sample(Date.now());
    await yieldToTimers(120);
    const after = sampler.sample(Date.now());

    expect(stalled.eventLoopLagMaxMs ?? 0).toBeGreaterThanOrEqual(150);
    // Below the stall it followed rather than below a fixed bound, so a busy
    // runner's ordinary jitter in the second window cannot fail it.
    expect(after.eventLoopLagMaxMs ?? Number.POSITIVE_INFINITY).toBeLessThan(stalled.eventLoopLagMaxMs ?? 0);
  });

  it('reports the longest GC pause as a non-negative number while observing', () => {
    sampler = createProcessSampler({ containerMemoryLimitBytes: null, readProcFile: () => null });
    // Churn enough short-lived garbage that a scavenge is all but certain.
    for (let round = 0; round < 50; round += 1) {
      const garbage: number[][] = [];
      for (let index = 0; index < 2_000; index += 1) garbage.push(new Array<number>(64).fill(index));
    }
    const sample = sampler.sample(Date.now());
    expect(sample.gcPauseMaxMs).not.toBeNull();
    expect(sample.gcPauseMaxMs).toBeGreaterThanOrEqual(0);
  });

  it('reads every procfs-derived field as null where procfs does not exist', () => {
    // win32 and macOS have no /proc. Null says "not measured here", which a
    // chart draws as a gap, where 0 would claim a healthy host.
    sampler = createProcessSampler({ containerMemoryLimitBytes: null, readProcFile: () => null });
    const sample = sampler.sample(Date.now());
    expect(sample.hostCpuStealTicksDelta).toBeNull();
    expect(sample.hostCpuTotalTicksDelta).toBeNull();
    expect(sample.pressureCpuSomeMs).toBeNull();
    expect(sample.pressureMemorySomeMs).toBeNull();
    expect(sample.pressureIoSomeMs).toBeNull();
  });

  it('reports steal ticks and PSI stall time as deltas over the window, baselined at construction', () => {
    const procfs = fakeProcfs();
    procfs.setStat(100, 50_000);
    procfs.setPressure('cpu', 1_000_000);
    procfs.setPressure('memory', 0);
    procfs.setPressure('io', 250_000);
    sampler = createProcessSampler({ containerMemoryLimitBytes: null, readProcFile: procfs.read });

    // One window: 30 ticks stolen out of 12,030, a 2.9 s CPU stall, and an IO
    // stall of 0.5 ms.
    procfs.setStat(130, 62_000);
    procfs.setPressure('cpu', 3_900_000);
    procfs.setPressure('io', 250_500);
    const first = sampler.sample(Date.now());

    expect(first.hostCpuStealTicksDelta).toBe(30);
    expect(first.hostCpuTotalTicksDelta).toBe(12_030);
    expect(first.pressureCpuSomeMs).toBe(2_900);
    expect(first.pressureMemorySomeMs).toBe(0);
    expect(first.pressureIoSomeMs).toBe(0.5);

    // The next window starts from the previous reading, not from boot.
    const second = sampler.sample(Date.now());
    expect(second.hostCpuStealTicksDelta).toBe(0);
    expect(second.pressureCpuSomeMs).toBe(0);
  });

  it('clamps a procfs counter that went backwards to zero rather than drawing a negative stall', () => {
    // A counter only falls when its source reset underneath the sampler (a
    // container moved to a fresh host, a kernel that zeroed PSI). A negative
    // delta would draw as a stall that ran backwards in time.
    const procfs = fakeProcfs();
    procfs.setStat(100, 50_000);
    procfs.setPressure('cpu', 5_000_000);
    sampler = createProcessSampler({ containerMemoryLimitBytes: null, readProcFile: procfs.read });

    procfs.setStat(10, 1_000);
    procfs.setPressure('cpu', 1_000);
    const sample = sampler.sample(Date.now());

    // Exactly 0, not negative and not null: both readings exist, so the
    // window was measured.
    expect(sample.hostCpuStealTicksDelta).toBe(0);
    expect(sample.hostCpuTotalTicksDelta).toBe(0);
    expect(sample.pressureCpuSomeMs).toBe(0);
  });

  it('disconnects its GC observer on stop, so the subscription ends with the recorder', () => {
    const disconnect = vi.spyOn(PerformanceObserver.prototype, 'disconnect');
    try {
      // Local rather than the shared `sampler`, so afterEach does not stop it
      // a second time and double the count.
      const stopped = createProcessSampler({ containerMemoryLimitBytes: null, readProcFile: () => null });
      expect(disconnect).not.toHaveBeenCalled();
      stopped.stop();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      disconnect.mockRestore();
    }
  });

  it('treats a source that disappears as unmeasured rather than as a huge or negative delta', () => {
    const procfs = fakeProcfs();
    procfs.setPressure('memory', 5_000);
    sampler = createProcessSampler({ containerMemoryLimitBytes: null, readProcFile: procfs.read });

    procfs.files.delete('/proc/pressure/memory');
    expect(sampler.sample(Date.now()).pressureMemorySomeMs).toBeNull();

    // Back again: one window with no baseline, then deltas resume.
    procfs.setPressure('memory', 9_000);
    expect(sampler.sample(Date.now()).pressureMemorySomeMs).toBeNull();
    procfs.setPressure('memory', 11_000);
    expect(sampler.sample(Date.now()).pressureMemorySomeMs).toBe(2);
  });
});

describe('procfs parsers', () => {
  it('reads steal and total from the aggregate cpu line, excluding the guest columns', () => {
    // Captured shape from a production host (values changed): steal is the
    // eighth column, and guest/guest_nice are already inside user/nice.
    const ticks = parseHostCpuTicks('cpu  4400251 35677 2253230 1352603536 63955 0 263099 7 11 13\ncpu0 1 2 3\n');
    expect(ticks).toEqual({ steal: 7, total: 4400251 + 35677 + 2253230 + 1352603536 + 63955 + 0 + 263099 + 7 });
  });

  it('rejects a /proc/stat that does not start with the aggregate cpu line', () => {
    expect(parseHostCpuTicks('cpu0 1 2 3 4 5 6 7 8\n')).toBeNull();
    expect(parseHostCpuTicks('cpu  1 2 3\n')).toBeNull();
    expect(parseHostCpuTicks('')).toBeNull();
    expect(parseHostCpuTicks('cpu  1 2 x 4 5 6 7 8\n')).toBeNull();
  });

  it('reads the some-line total from a PSI file and ignores the full line', () => {
    const pressureFile =
      'some avg10=0.31 avg60=0.27 avg300=0.09 total=12038296265\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
    expect(parsePressureSomeTotalMicroseconds(pressureFile)).toBe(12_038_296_265);
  });

  it('returns null for a PSI file without a some line', () => {
    expect(parsePressureSomeTotalMicroseconds('full avg10=0.00 avg60=0.00 avg300=0.00 total=5\n')).toBeNull();
    expect(parsePressureSomeTotalMicroseconds('')).toBeNull();
  });
});
