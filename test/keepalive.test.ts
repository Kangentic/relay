import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startKeepalive } from '../src/keepalive.js';
import { createMetrics } from '../src/http/metrics.js';
import type { Conn } from '../src/types.js';

interface FakeSocket {
  readyState: number;
  readonly OPEN: number;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function fakeConn(readyState = 1): { conn: Conn; socket: FakeSocket } {
  const socket: FakeSocket = { readyState, OPEN: 1, ping: vi.fn(), terminate: vi.fn() };
  const conn: Conn = {
    id: 'conn-1',
    socket: socket as unknown as Conn['socket'],
    slot: 'slot-1',
    ip: '127.0.0.1',
    connectedAt: 0,
    state: 'waiting',
    partner: null,
    isAlive: true,
    pending: [],
    pendingBytes: 0,
    parkTimer: null,
    sessionTimer: null,
    torndown: false,
  };
  return { conn, socket };
}

describe('startKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings a live connection each interval and marks it not-yet-alive', () => {
    const metrics = createMetrics();
    const { conn, socket } = fakeConn();
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000);

    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(conn.isAlive).toBe(false);
    keepalive.stop();
  });

  it('keeps a connection alive across intervals when it answers with a pong', () => {
    const metrics = createMetrics();
    const { conn, socket } = fakeConn();
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000);
    conn.isAlive = true; // simulates the socket's 'pong' handler
    vi.advanceTimersByTime(1000);

    expect(socket.terminate).not.toHaveBeenCalled();
    keepalive.stop();
  });

  it('terminates a connection that missed the previous pong', () => {
    const metrics = createMetrics();
    const onPongTimeoutSpy = vi.spyOn(metrics, 'onPongTimeout');
    const { conn, socket } = fakeConn();
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000); // ping sent, isAlive flips to false
    vi.advanceTimersByTime(1000); // no pong arrived by this tick

    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(onPongTimeoutSpy).toHaveBeenCalledTimes(1);
    keepalive.stop();
  });

  it('skips a connection that is not open', () => {
    const metrics = createMetrics();
    const { conn, socket } = fakeConn(3); // CLOSING
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000);

    expect(socket.ping).not.toHaveBeenCalled();
    keepalive.stop();
  });

  it('stop() prevents any further pings', () => {
    const metrics = createMetrics();
    const { conn, socket } = fakeConn();
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    keepalive.stop();
    vi.advanceTimersByTime(5000);

    expect(socket.ping).not.toHaveBeenCalled();
  });
});
