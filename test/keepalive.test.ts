import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  EMPTY_OUTBOUND_QUEUE,
  isDraining,
  readOutboundQueue,
  startKeepalive,
} from '../src/keepalive.js';
import { createMetrics } from '../src/http/metrics.js';
import type { Conn } from '../src/types.js';

interface FakeSocket {
  readyState: number;
  readonly OPEN: number;
  /** Settable, standing in for ws's queue, which falls only per completed write. */
  bufferedAmount: number;
  /** Settable, standing in for libuv's live count, which falls as the kernel accepts bytes. */
  _socket: { _handle: { writeQueueSize: unknown } | null } | null;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function setKernelQueue(socket: FakeSocket, bytes: number): void {
  socket._socket = { _handle: { writeQueueSize: bytes } };
}

function fakeConn(readyState = 1): { conn: Conn; socket: FakeSocket } {
  const socket: FakeSocket = {
    readyState,
    OPEN: 1,
    bufferedAmount: 0,
    _socket: { _handle: { writeQueueSize: 0 } },
    ping: vi.fn(),
    terminate: vi.fn(),
  };
  const conn: Conn = {
    id: 'conn-1',
    socket: socket as unknown as Conn['socket'],
    slot: 'slot-1',
    ip: '127.0.0.1',
    role: 'unknown',
    connectedAt: 0,
    state: 'waiting',
    partner: null,
    isAlive: true,
    outboundQueueAtLastCheck: EMPTY_OUTBOUND_QUEUE,
    probePending: false,
    outboundQueueAtProbe: EMPTY_OUTBOUND_QUEUE,
    pending: [],
    pendingBytes: 0,
    parkTimer: null,
    sessionTimer: null,
    torndown: false,
    slotReserved: false,
    unpairedReserved: false,
    pairState: null,
    trace: null,
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

describe('keepalive spares a socket that is alive but slow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats only a strictly falling reading as draining', () => {
    const reading = (bufferedAmount: number, pendingKernelWriteBytes: number | null) => ({
      bufferedAmount,
      pendingKernelWriteBytes,
    });
    // Either reading falling is progress.
    expect(isDraining(reading(4_000, 9_000), reading(8_000, 9_000))).toBe(true);
    expect(isDraining(reading(8_000, 2_000), reading(8_000, 3_000))).toBe(true);
    expect(isDraining(reading(0, 0), reading(1, 0))).toBe(true);
    // Flat or growing on both is not.
    expect(isDraining(reading(8_000, 3_000), reading(8_000, 3_000))).toBe(false);
    expect(isDraining(reading(9_000, 4_000), reading(8_000, 3_000))).toBe(false);
    expect(isDraining(reading(0, 0), reading(0, 0))).toBe(false);
    // A runtime that hides the kernel queue degrades to bufferedAmount alone.
    expect(isDraining(reading(8_000, null), reading(8_000, 3_000))).toBe(false);
    expect(isDraining(reading(8_000, 1_000), reading(8_000, null))).toBe(false);
    expect(isDraining(reading(7_000, null), reading(8_000, null))).toBe(true);
  });

  it('spares a socket whose kernel queue fell while bufferedAmount sat flat, which is how a real backlog drains', () => {
    // The regression this guards: Node hands a whole backlog to libuv as one
    // batched write, and bufferedAmount stays flat until all of it completes.
    // Measured on Linux: 21.47 MiB, unchanged for 5.4 s against a reader taking
    // 1 MiB/s. A bufferedAmount-only check reaped that reader every time.
    const metrics = createMetrics();
    const { conn, socket } = fakeConn();
    socket.bufferedAmount = 21_470_000;
    setKernelQueue(socket, 17_470_000);
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000); // ping queued behind the backlog
    setKernelQueue(socket, 15_840_000); // the kernel took 1.6 MB; bufferedAmount unchanged
    vi.advanceTimersByTime(1000);

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(metrics.snapshot().pongOverdueDrainingTotal).toBe(1);
    keepalive.stop();
  });

  it('falls back to bufferedAmount alone when the runtime does not expose the kernel queue', () => {
    const metrics = createMetrics();
    const { conn, socket } = fakeConn();
    socket._socket = null;
    socket.bufferedAmount = 8_000_000;
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000);
    socket.bufferedAmount = 7_000_000; // one batched write completed
    vi.advanceTimersByTime(1000);
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // flat with no other signal: reaped
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    keepalive.stop();
  });

  it('does not reap a socket whose queue fell since the ping, and counts the grace', () => {
    // The ping was written behind 8 MiB. By the next tick the consumer has
    // taken 2 MiB off the queue, which only an acknowledging TCP peer can do,
    // but it has not reached the ping yet. That is slow, not dead.
    const metrics = createMetrics();
    const { conn, socket } = fakeConn();
    socket.bufferedAmount = 8 * 1024 * 1024;
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000); // ping queued behind 8 MiB
    socket.bufferedAmount = 6 * 1024 * 1024;
    vi.advanceTimersByTime(1000); // no pong, but the queue fell

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(metrics.snapshot().pongOverdueDrainingTotal).toBe(1);
    expect(metrics.snapshot().pongTimeoutsTotal).toBe(0);
    keepalive.stop();
  });

  it('does not send a second ping while the first is still queued', () => {
    const metrics = createMetrics();
    const { conn, socket } = fakeConn();
    socket.bufferedAmount = 4_000_000;
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000);
    socket.bufferedAmount = 3_000_000;
    vi.advanceTimersByTime(1000);

    expect(socket.ping).toHaveBeenCalledTimes(1);
    keepalive.stop();
  });

  it('keeps sparing while the queue keeps draining, and resumes normal pings after the pong', () => {
    const metrics = createMetrics();
    const { conn, socket } = fakeConn();
    socket.bufferedAmount = 9_000_000;
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000); // ping behind 9 MB
    socket.bufferedAmount = 6_000_000;
    vi.advanceTimersByTime(1000); // spared
    socket.bufferedAmount = 3_000_000;
    vi.advanceTimersByTime(1000); // spared again: still progressing
    conn.isAlive = true; // the queued ping finally arrived and was answered
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(1000); // a fresh round

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(metrics.snapshot().pongOverdueDrainingTotal).toBe(2);
    expect(socket.ping).toHaveBeenCalledTimes(2);
    keepalive.stop();
  });

  it('reaps a spared socket that then stops draining', () => {
    // Continued grace needs continued progress: the baseline moves to each
    // spared reading, so a consumer that stalls is reaped one interval later.
    const metrics = createMetrics();
    const { conn, socket } = fakeConn();
    socket.bufferedAmount = 8_000_000;
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(1000);
    socket.bufferedAmount = 7_000_000;
    vi.advanceTimersByTime(1000); // spared
    vi.advanceTimersByTime(1000); // still 7 MB: stalled

    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().pongTimeoutsTotal).toBe(1);
    keepalive.stop();
  });

  it('reaps a missed pong whose queue held steady or grew, which is what a half-open socket looks like', () => {
    // A dead peer acknowledges nothing, so its queue can only stay put or grow
    // as the partner keeps sending. Neither may buy it grace.
    for (const laterBufferedAmount of [500_000, 900_000]) {
      const metrics = createMetrics();
      const { conn, socket } = fakeConn();
      socket.bufferedAmount = 500_000;
      const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

      vi.advanceTimersByTime(1000);
      socket.bufferedAmount = laterBufferedAmount;
      vi.advanceTimersByTime(1000);

      expect(socket.terminate).toHaveBeenCalledTimes(1);
      expect(metrics.snapshot().pongOverdueDrainingTotal).toBe(0);
      keepalive.stop();
    }
  });

  it('reaps an idle socket that missed its pong, exactly as before', () => {
    // An empty queue at both readings: nothing drained because nothing was
    // queued, so there is no evidence of life and the old rule applies.
    const metrics = createMetrics();
    const { socket, conn } = fakeConn();
    const keepalive = startKeepalive(new Set([conn]), { metrics, pingIntervalMs: 1000 });

    vi.advanceTimersByTime(2000);

    expect(socket.terminate).toHaveBeenCalledTimes(1);
    keepalive.stop();
  });
});

describe('reading the outbound queue off a real socket', () => {
  it('finds the kernel write queue where the drain check expects it', async () => {
    // pendingKernelWriteBytes comes from a socket internal, not a documented
    // API. If a Node or ws upgrade moves it, this fails rather than letting the
    // drain check quietly degrade to bufferedAmount alone, which cannot see a
    // batched backlog drain.
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const serverSocket = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('expected a bound address');
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    client.on('error', () => {});
    await new Promise<void>((resolve) => client.once('open', () => resolve()));
    try {
      const reading = readOutboundQueue(await serverSocket);
      expect(reading.pendingKernelWriteBytes).toEqual(expect.any(Number));
      expect(reading.bufferedAmount).toBe(0);
    } finally {
      client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
