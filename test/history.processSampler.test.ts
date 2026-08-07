import { totalmem } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProcessSampler,
  isBelievableMemoryLimit,
  type ProcessSampler,
} from '../src/history/processSampler.js';

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
});
