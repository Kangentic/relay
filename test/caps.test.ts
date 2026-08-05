import { describe, it, expect } from 'vitest';
import { ConnectionCaps, SlotConnectionCaps, UnpairedConnectionCap } from '../src/guards/caps.js';

describe('ConnectionCaps', () => {
  it('rejects once the global cap is reached', () => {
    const caps = new ConnectionCaps(2, 10);
    expect(caps.reserve('ip-a').ok).toBe(true);
    expect(caps.reserve('ip-b').ok).toBe(true);
    const denied = caps.reserve('ip-c');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('global_cap');
  });

  it('rejects once the per-IP cap is reached even under the global cap', () => {
    const caps = new ConnectionCaps(100, 1);
    expect(caps.reserve('ip-a').ok).toBe(true);
    const denied = caps.reserve('ip-a');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('ip_cap');
  });

  it('releasing a reservation restores both global and per-IP capacity', () => {
    const caps = new ConnectionCaps(1, 1);
    const first = caps.reserve('ip-a');
    expect(first.ok).toBe(true);
    expect(caps.reserve('ip-a').ok).toBe(false);

    if (first.ok) first.release();

    expect(caps.reserve('ip-a').ok).toBe(true);
  });

  it('release is idempotent', () => {
    const caps = new ConnectionCaps(1, 1);
    const reservation = caps.reserve('ip-a');
    expect(reservation.ok).toBe(true);
    if (reservation.ok) {
      reservation.release();
      reservation.release();
    }
    expect(caps.activeConnections).toBe(0);
  });

  it('tracks distinct IPs independently', () => {
    const caps = new ConnectionCaps(100, 1);
    expect(caps.reserve('ip-a').ok).toBe(true);
    expect(caps.reserve('ip-b').ok).toBe(true);
  });
});

describe('SlotConnectionCaps', () => {
  it('allows up to the configured max connections per slot', () => {
    const caps = new SlotConnectionCaps(2);
    expect(caps.tryReserve('slot-1')).toBe(true);
    expect(caps.tryReserve('slot-1')).toBe(true);
    expect(caps.tryReserve('slot-1')).toBe(false);
  });

  it('releasing restores capacity for that slot', () => {
    const caps = new SlotConnectionCaps(1);
    expect(caps.tryReserve('slot-1')).toBe(true);
    caps.release('slot-1');
    expect(caps.tryReserve('slot-1')).toBe(true);
  });

  it('tracks distinct slots independently', () => {
    const caps = new SlotConnectionCaps(1);
    expect(caps.tryReserve('slot-1')).toBe(true);
    expect(caps.tryReserve('slot-2')).toBe(true);
  });
});

describe('UnpairedConnectionCap', () => {
  it('allows up to the configured ceiling and then refuses', () => {
    const cap = new UnpairedConnectionCap(2);
    expect(cap.tryReserve()).toBe(true);
    expect(cap.tryReserve()).toBe(true);
    expect(cap.tryReserve()).toBe(false);
    expect(cap.unpairedConnections).toBe(2);
  });

  it('releasing restores capacity', () => {
    const cap = new UnpairedConnectionCap(1);
    expect(cap.tryReserve()).toBe(true);
    expect(cap.tryReserve()).toBe(false);
    cap.release();
    expect(cap.tryReserve()).toBe(true);
  });

  it('never goes negative on an unmatched release', () => {
    const cap = new UnpairedConnectionCap(1);
    cap.release();
    cap.release();
    expect(cap.unpairedConnections).toBe(0);
    // Capacity is still exactly one, not inflated by the spurious releases.
    expect(cap.tryReserve()).toBe(true);
    expect(cap.tryReserve()).toBe(false);
  });
});
