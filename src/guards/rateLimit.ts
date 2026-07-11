interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

/**
 * A lazy-refill token bucket limiter keyed by an arbitrary string (an IP
 * bucket or a slot id). Buckets refill continuously based on elapsed time
 * rather than on a fixed timer tick, and unused buckets are swept
 * periodically so long-running processes do not leak memory for one-off
 * keys.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly ratePerMs: number;
  private readonly burst: number;
  private readonly sweepIntervalMs: number;
  private lastSweepAt: number;

  constructor(
    private readonly perMinute: number,
    burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.ratePerMs = perMinute / 60_000;
    this.burst = Math.max(burst, 1);
    this.sweepIntervalMs = 5 * 60_000;
    this.lastSweepAt = this.now();
  }

  /** Consumes one token for `key`; returns false if the bucket is empty. */
  tryConsume(key: string): boolean {
    this.sweepIfDue();
    const currentTime = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, lastRefillAt: currentTime };
    const elapsedMs = Math.max(0, currentTime - bucket.lastRefillAt);
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedMs * this.ratePerMs);
    bucket.lastRefillAt = currentTime;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  private sweepIfDue(): void {
    const currentTime = this.now();
    if (currentTime - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = currentTime;
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens >= this.burst && currentTime - bucket.lastRefillAt > this.sweepIntervalMs) {
        this.buckets.delete(key);
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
