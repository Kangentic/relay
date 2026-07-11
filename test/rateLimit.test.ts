import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/guards/rateLimit.js';

describe('RateLimiter', () => {
  it('allows up to the burst size immediately, then refuses', () => {
    let now = 0;
    const limiter = new RateLimiter(60, 3, () => now);

    expect(limiter.tryConsume('key')).toBe(true);
    expect(limiter.tryConsume('key')).toBe(true);
    expect(limiter.tryConsume('key')).toBe(true);
    expect(limiter.tryConsume('key')).toBe(false);
  });

  it('refills over time at the configured rate', () => {
    let now = 0;
    const limiter = new RateLimiter(60, 1, () => now); // 1 token/sec

    expect(limiter.tryConsume('key')).toBe(true);
    expect(limiter.tryConsume('key')).toBe(false);

    now += 1_000;
    expect(limiter.tryConsume('key')).toBe(true);
  });

  it('never exceeds the burst ceiling no matter how long it waits', () => {
    let now = 0;
    const limiter = new RateLimiter(60, 2, () => now);

    now += 10 * 60_000; // 10 minutes of accrual
    expect(limiter.tryConsume('key')).toBe(true);
    expect(limiter.tryConsume('key')).toBe(true);
    expect(limiter.tryConsume('key')).toBe(false);
  });

  it('tracks independent buckets per key', () => {
    let now = 0;
    const limiter = new RateLimiter(60, 1, () => now);

    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
    expect(limiter.tryConsume('b')).toBe(true);
  });

  it('is not fooled by a nonsensical burst of 0', () => {
    const limiter = new RateLimiter(60, 0);
    expect(limiter.tryConsume('key')).toBe(true);
  });

  it('sweeps stale full buckets without breaking future consumption', () => {
    let now = 0;
    const limiter = new RateLimiter(60, 5, () => now);

    limiter.tryConsume('stale-key');
    now += 6 * 60_000;
    limiter.tryConsume('trigger-sweep');

    expect(limiter.tryConsume('trigger-sweep')).toBe(true);
  });
});
