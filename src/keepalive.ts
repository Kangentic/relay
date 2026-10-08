import type { WebSocket } from 'ws';
import type { Conn } from './types.js';
import type { Metrics } from './http/metrics.js';

export interface KeepaliveDeps {
  readonly metrics: Metrics;
  readonly pingIntervalMs: number;
}

export interface Keepalive {
  stop(): void;
}

/**
 * How much a socket still has to hand to the kernel, read two ways, because
 * neither one alone can see a slow consumer draining.
 *
 * bufferedAmount is ws's documented count of bytes "queued but not yet
 * transmitted". Node hands everything queued behind an in-flight write to
 * libuv as ONE batched writev, and bufferedAmount only falls when a whole
 * write completes, so under a deep backlog it reads flat for many seconds while
 * the peer is reading steadily. Measured on Linux and Node 22: 21.47 MiB, flat
 * for 5.4 s, against a reader taking 1 MiB/s.
 *
 * pendingKernelWriteBytes is libuv's live count of bytes in pending writes,
 * which falls each time the kernel accepts part of that writev. It is not a
 * public API (it lives on the socket's internal handle), so it is read
 * defensively and is null when the runtime does not expose it; the check then
 * degrades to bufferedAmount alone. test/keepalive.test.ts reads it off a real
 * socket so an upgrade that moves it fails loudly instead of silently.
 */
export interface OutboundQueueReading {
  readonly bufferedAmount: number;
  readonly pendingKernelWriteBytes: number | null;
}

interface SocketInternals {
  readonly _socket?: { readonly _handle?: { readonly writeQueueSize?: unknown } | null } | null;
}

export function readOutboundQueue(socket: WebSocket): OutboundQueueReading {
  const pending = (socket as unknown as SocketInternals)._socket?._handle?.writeQueueSize;
  return {
    bufferedAmount: socket.bufferedAmount,
    pendingKernelWriteBytes: typeof pending === 'number' && Number.isFinite(pending) && pending >= 0 ? pending : null,
  };
}

/** A reading that has seen nothing queued, for a connection not yet checked. */
export const EMPTY_OUTBOUND_QUEUE: OutboundQueueReading = Object.freeze({
  bufferedAmount: 0,
  pendingKernelWriteBytes: 0,
});

/**
 * Whether a socket made delivery progress between two readings.
 *
 * libuv only leaves bytes queued when the kernel's send buffer is full. So a
 * queue that was non-empty and then shrank means the kernel freed buffer
 * space, which only happens as the TCP peer acknowledges data. Either reading
 * strictly falling is therefore proof the peer is alive and reading, even if
 * it has not yet reached a ping written behind those bytes. A dead peer
 * acknowledges nothing, so neither can fall; a queue that held steady or grew
 * proves nothing either way.
 *
 * The blind spot is the kernel send buffer itself: once both readings are 0, a
 * ping can still sit behind bytes the kernel holds, and nothing in Node can see
 * that. Such a socket is judged exactly as it was before this check existed.
 */
export function isDraining(current: OutboundQueueReading, earlier: OutboundQueueReading): boolean {
  if (current.bufferedAmount < earlier.bufferedAmount) return true;
  return (
    current.pendingKernelWriteBytes !== null &&
    earlier.pendingKernelWriteBytes !== null &&
    current.pendingKernelWriteBytes < earlier.pendingKernelWriteBytes
  );
}

/**
 * WS-level ping/pong liveness check, invisible to the client (RelayClient
 * has no application heartbeat). Every interval, a connection that missed
 * the previous round's pong is terminated - this reaps half-open sockets
 * (a dead TCP peer with no FIN still reads OPEN) so waiting/paired slot
 * state and connection caps stay accurate. Traffic-idle is never treated
 * as death: a quiet-but-alive paired tunnel is normal and must not be
 * killed by this check.
 *
 * Nor is slow treated as death. A ping is queued behind everything already
 * waiting for that socket, up to MAX_BUFFERED_BYTES, so a phone draining a
 * large transcript over a slow link can answer more than one interval late.
 * A missed pong whose socket drained since the last check is spared for
 * another interval instead of reaped. No second ping is sent: the first is
 * still in the queue and will be answered when it arrives. A half-open socket
 * never drains, because nothing acknowledges its data, so it is still reaped
 * on the same schedule as before.
 */
export function startKeepalive(connections: ReadonlySet<Conn>, deps: KeepaliveDeps): Keepalive {
  const interval = setInterval(() => {
    for (const conn of connections) {
      if (conn.socket.readyState !== conn.socket.OPEN) continue;
      const outboundQueue = readOutboundQueue(conn.socket);
      if (!conn.isAlive) {
        if (isDraining(outboundQueue, conn.outboundQueueAtLastCheck)) {
          // The baseline moves forward, so continued grace needs continued
          // progress: a consumer that stops draining is reaped next interval.
          conn.outboundQueueAtLastCheck = outboundQueue;
          deps.metrics.onPongOverdueDraining();
          continue;
        }
        deps.metrics.onPongTimeout();
        conn.socket.terminate();
        continue;
      }
      conn.isAlive = false;
      conn.outboundQueueAtLastCheck = outboundQueue;
      conn.socket.ping();
    }
  }, deps.pingIntervalMs);
  interval.unref?.();

  return {
    stop: () => clearInterval(interval),
  };
}
