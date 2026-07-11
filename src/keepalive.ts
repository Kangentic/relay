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
 * WS-level ping/pong liveness check, invisible to the client (RelayClient
 * has no application heartbeat). Every interval, a connection that missed
 * the previous round's pong is terminated - this reaps half-open sockets
 * (a dead TCP peer with no FIN still reads OPEN) so waiting/paired slot
 * state and connection caps stay accurate. Traffic-idle is never treated
 * as death: a quiet-but-alive paired tunnel is normal and must not be
 * killed by this check.
 */
export function startKeepalive(connections: ReadonlySet<Conn>, deps: KeepaliveDeps): Keepalive {
  const interval = setInterval(() => {
    for (const conn of connections) {
      if (conn.socket.readyState !== conn.socket.OPEN) continue;
      if (!conn.isAlive) {
        deps.metrics.onPongTimeout();
        conn.socket.terminate();
        continue;
      }
      conn.isAlive = false;
      conn.socket.ping();
    }
  }, deps.pingIntervalMs);
  interval.unref?.();

  return {
    stop: () => clearInterval(interval),
  };
}
