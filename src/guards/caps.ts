export interface Reservation {
  readonly ok: true;
  release(): void;
}

export interface ReservationDenied {
  readonly ok: false;
  readonly reason: 'global_cap' | 'ip_cap';
}

/**
 * Tracks the global and per-IP connection counts that are reserved at
 * upgrade time (before the async admission check) and released on close,
 * so a slow admission call cannot be used to blow past the caps by racing
 * many connections through at once.
 */
export class ConnectionCaps {
  private globalCount = 0;
  private readonly perIpCount = new Map<string, number>();

  constructor(
    private readonly maxGlobal: number,
    private readonly maxPerIp: number,
  ) {}

  reserve(ipBucket: string): Reservation | ReservationDenied {
    if (this.globalCount >= this.maxGlobal) return { ok: false, reason: 'global_cap' };
    const currentForIp = this.perIpCount.get(ipBucket) ?? 0;
    if (currentForIp >= this.maxPerIp) return { ok: false, reason: 'ip_cap' };

    this.globalCount += 1;
    this.perIpCount.set(ipBucket, currentForIp + 1);

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.globalCount = Math.max(0, this.globalCount - 1);
        const remaining = (this.perIpCount.get(ipBucket) ?? 1) - 1;
        if (remaining <= 0) this.perIpCount.delete(ipBucket);
        else this.perIpCount.set(ipBucket, remaining);
      },
    };
  }

  get activeConnections(): number {
    return this.globalCount;
  }
}

/** Tracks how many connections (waiting + paired) currently reference a slot. */
export class SlotConnectionCaps {
  private readonly perSlotCount = new Map<string, number>();

  constructor(private readonly maxPerSlot: number) {}

  tryReserve(slot: string): boolean {
    const current = this.perSlotCount.get(slot) ?? 0;
    if (current >= this.maxPerSlot) return false;
    this.perSlotCount.set(slot, current + 1);
    return true;
  }

  release(slot: string): void {
    const current = this.perSlotCount.get(slot) ?? 0;
    if (current <= 1) this.perSlotCount.delete(slot);
    else this.perSlotCount.set(slot, current - 1);
  }
}
