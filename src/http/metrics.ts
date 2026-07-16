import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RejectReason } from '../closeCodes.js';
import type { Config } from '../types.js';

/**
 * A point-in-time copy of every counter and gauge. Aggregate numbers only,
 * never slot ids or IPs, so no metrics surface can leak the pairing graph.
 */
export interface MetricsSnapshot {
  readonly activeConnections: number;
  readonly waitingSlots: number;
  readonly pairedSlots: number;
  readonly connectionsTotal: number;
  readonly sessionsTotal: number;
  readonly framesForwardedTotal: number;
  readonly bytesForwardedTotal: number;
  readonly peerClosedTotal: number;
  readonly pongTimeoutsTotal: number;
  readonly rejectsByReason: Readonly<Partial<Record<RejectReason, number>>>;
}

/**
 * In-process counters and gauges. Deliberately tracks only aggregate
 * numbers, never slot ids or IPs, so /metrics cannot leak the pairing
 * graph even if it were exposed publicly.
 */
export interface Metrics {
  onConnectionOpened(): void;
  onConnectionClosed(): void;
  onPair(): void;
  onUnpair(): void;
  /** A paired tunnel was torn down because one half closed (counted once per pair). */
  onPeerClosed(): void;
  onForward(bytes: number): void;
  onReject(reason: RejectReason): void;
  onPongTimeout(): void;
  waitingSlots: { increment(): void; decrement(): void };
  snapshot(): MetricsSnapshot;
  render(): string;
}

export function createMetrics(): Metrics {
  const rejectsByReason = new Map<RejectReason, number>();
  let activeConnections = 0;
  let pairedSlots = 0;
  let waitingSlotsCount = 0;
  let connectionsTotal = 0;
  let messagesForwardedTotal = 0;
  let bytesForwardedTotal = 0;
  let sessionsTotal = 0;
  let peerClosedTotal = 0;
  let pongTimeoutsTotal = 0;

  function snapshot(): MetricsSnapshot {
    return {
      activeConnections,
      waitingSlots: waitingSlotsCount,
      pairedSlots,
      connectionsTotal,
      sessionsTotal,
      framesForwardedTotal: messagesForwardedTotal,
      bytesForwardedTotal,
      peerClosedTotal,
      pongTimeoutsTotal,
      rejectsByReason: Object.fromEntries(rejectsByReason) as Partial<Record<RejectReason, number>>,
    };
  }

  return {
    onConnectionOpened: () => {
      activeConnections += 1;
      connectionsTotal += 1;
    },
    onConnectionClosed: () => {
      activeConnections = Math.max(0, activeConnections - 1);
    },
    onPair: () => {
      pairedSlots += 1;
      sessionsTotal += 1;
    },
    onUnpair: () => {
      pairedSlots = Math.max(0, pairedSlots - 1);
    },
    onPeerClosed: () => {
      peerClosedTotal += 1;
    },
    onForward: (bytes) => {
      messagesForwardedTotal += 1;
      bytesForwardedTotal += bytes;
    },
    onReject: (reason) => {
      rejectsByReason.set(reason, (rejectsByReason.get(reason) ?? 0) + 1);
    },
    onPongTimeout: () => {
      pongTimeoutsTotal += 1;
    },
    waitingSlots: {
      increment: () => {
        waitingSlotsCount += 1;
      },
      decrement: () => {
        waitingSlotsCount = Math.max(0, waitingSlotsCount - 1);
      },
    },
    snapshot,
    render: () => {
      const lines = [
        '# TYPE relay_active_connections gauge',
        `relay_active_connections ${activeConnections}`,
        '# TYPE relay_waiting_slots gauge',
        `relay_waiting_slots ${waitingSlotsCount}`,
        '# TYPE relay_paired_slots gauge',
        `relay_paired_slots ${pairedSlots}`,
        '# TYPE relay_connections_total counter',
        `relay_connections_total ${connectionsTotal}`,
        '# TYPE relay_messages_forwarded_total counter',
        `relay_messages_forwarded_total ${messagesForwardedTotal}`,
        '# TYPE relay_bytes_forwarded_total counter',
        `relay_bytes_forwarded_total ${bytesForwardedTotal}`,
        '# TYPE relay_sessions_total counter',
        `relay_sessions_total ${sessionsTotal}`,
        '# TYPE relay_peer_closed_total counter',
        `relay_peer_closed_total ${peerClosedTotal}`,
        '# TYPE relay_pong_timeouts_total counter',
        `relay_pong_timeouts_total ${pongTimeoutsTotal}`,
        '# TYPE relay_rejects_total counter',
      ];
      for (const [reason, count] of rejectsByReason) {
        lines.push(`relay_rejects_total{reason="${reason}"} ${count}`);
      }
      return lines.join('\n') + '\n';
    },
  };
}

/**
 * Shared gate for both metrics surfaces: 404 when disabled, 401 without the
 * bearer token when one is configured. Returns true when the request may
 * proceed (the response is already finished otherwise).
 */
function authorizeMetricsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: Pick<Config, 'metricsEnabled' | 'metricsToken'>,
): boolean {
  if (!config.metricsEnabled) {
    response.writeHead(404).end();
    return false;
  }
  if (config.metricsToken) {
    const authorizationHeader = request.headers['authorization'];
    if (authorizationHeader !== `Bearer ${config.metricsToken}`) {
      response.writeHead(401).end();
      return false;
    }
  }
  return true;
}

export function handleMetricsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  metrics: Metrics,
  config: Pick<Config, 'metricsEnabled' | 'metricsToken'>,
): void {
  if (!authorizeMetricsRequest(request, response, config)) return;
  response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
}

/**
 * The JSON twin of /metrics for humans, scripts, and the load-test harness:
 * the same aggregate counters plus process memory, grouped so "why do
 * connections close" is answerable at a glance. Carries no slot ids, no
 * IPs, and no traffic content, exactly like the Prometheus surface.
 */
export function handleMetriczRequest(
  request: IncomingMessage,
  response: ServerResponse,
  metrics: Metrics,
  config: Pick<Config, 'metricsEnabled' | 'metricsToken'>,
): void {
  if (!authorizeMetricsRequest(request, response, config)) return;
  const currentSnapshot = metrics.snapshot();
  const memory = process.memoryUsage();
  const body = {
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    activeConnections: currentSnapshot.activeConnections,
    waitingSlots: currentSnapshot.waitingSlots,
    pairedSlots: currentSnapshot.pairedSlots,
    connectionsTotal: currentSnapshot.connectionsTotal,
    sessionsTotal: currentSnapshot.sessionsTotal,
    framesForwardedTotal: currentSnapshot.framesForwardedTotal,
    bytesForwardedTotal: currentSnapshot.bytesForwardedTotal,
    closedByCause: {
      peerClosed: currentSnapshot.peerClosedTotal,
      backpressure: currentSnapshot.rejectsByReason.backpressure ?? 0,
      heartbeat: currentSnapshot.pongTimeoutsTotal,
      parkTimeout: currentSnapshot.rejectsByReason.park_timeout ?? 0,
      sessionByteCap: currentSnapshot.rejectsByReason.session_byte_cap ?? 0,
      sessionTimeCap: currentSnapshot.rejectsByReason.session_time_cap ?? 0,
    },
    rejectsByReason: currentSnapshot.rejectsByReason,
  };
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
