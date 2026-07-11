import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RejectReason } from '../closeCodes.js';
import type { Config } from '../types.js';

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
  onForward(bytes: number): void;
  onReject(reason: RejectReason): void;
  onPongTimeout(): void;
  waitingSlots: { increment(): void; decrement(): void };
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
  let pongTimeoutsTotal = 0;

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

export function handleMetricsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  metrics: Metrics,
  config: Pick<Config, 'metricsEnabled' | 'metricsToken'>,
): void {
  if (!config.metricsEnabled) {
    response.writeHead(404).end();
    return;
  }
  if (config.metricsToken) {
    const authorizationHeader = request.headers['authorization'];
    if (authorizationHeader !== `Bearer ${config.metricsToken}`) {
      response.writeHead(401).end();
      return;
    }
  }
  response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
}
