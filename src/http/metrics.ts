import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RejectReason } from '../closeCodes.js';
import { PEER_ROLES, type PeerRole } from '../guards/peerRole.js';
import type { Config } from '../types.js';

/** Waiting slots split by what each parked peer reported itself to be. */
export type WaitingSlotsByRole = Readonly<Record<PeerRole, number>>;

const NO_WAITING_SLOTS: WaitingSlotsByRole = Object.freeze({ desktop: 0, mobile: 0, unknown: 0 });

/**
 * A point-in-time copy of every counter and gauge. Aggregate numbers only,
 * never slot ids or IPs, so no metrics surface can leak the pairing graph.
 */
export interface MetricsSnapshot {
  readonly activeConnections: number;
  /** The sum of waitingSlotsByRole, so the total can never disagree with the split. */
  readonly waitingSlots: number;
  /**
   * A bounded three-value dimension, not a per-slot label: the role is
   * validated to a closed enum at the upgrade edge and the client's raw string
   * never reaches here.
   */
  readonly waitingSlotsByRole: WaitingSlotsByRole;
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
  /**
   * Points the waiting gauge at the slot table, which is the only thing that
   * knows who is parked. Late-bound because the slot table needs a Metrics to
   * exist before it can be built, and set by createRelay so an injected
   * Metrics is bound to THAT relay's table rather than to nothing.
   *
   * Until it is called the gauge reads zero rather than guessing, which is
   * correct for a Metrics that no relay has claimed.
   */
  setWaitingSlotsSource(source: () => WaitingSlotsByRole): void;
  snapshot(): MetricsSnapshot;
  render(): string;
}

/** The three inputs the teardown grouping is built from, as plain numbers. */
export interface ClosedByCauseInput {
  readonly peerClosed: number;
  readonly pongTimeouts: number;
  readonly rejects: Readonly<Partial<Record<RejectReason, number>>>;
}

/**
 * THE definition of the "why did connections close" grouping. /metricz feeds it
 * lifetime totals and the /admin history feeds it per-interval deltas, but the
 * mapping from reject reasons to cause buckets exists only here, so adding a
 * cause cannot leave one surface behind.
 *
 * Counter units differ by cause. Pair teardowns, counted once per pair (two
 * sockets each): peerClosed, backpressure, sessionByteCap, sessionTimeCap.
 * Single-socket closes, counted once per socket: parkedOverflow (a parked
 * socket overflowing its pre-pair buffer), heartbeat, parkTimeout.
 */
export function buildClosedByCause(input: ClosedByCauseInput): Readonly<Record<string, number>> {
  return {
    peerClosed: input.peerClosed,
    backpressure: input.rejects.backpressure ?? 0,
    parkedOverflow: input.rejects.parked_overflow ?? 0,
    heartbeat: input.pongTimeouts,
    parkTimeout: input.rejects.park_timeout ?? 0,
    sessionByteCap: input.rejects.session_byte_cap ?? 0,
    sessionTimeCap: input.rejects.session_time_cap ?? 0,
  };
}

export function closedByCauseFromSnapshot(snapshot: MetricsSnapshot): Readonly<Record<string, number>> {
  return buildClosedByCause({
    peerClosed: snapshot.peerClosedTotal,
    pongTimeouts: snapshot.pongTimeoutsTotal,
    rejects: snapshot.rejectsByReason,
  });
}

export function createMetrics(): Metrics {
  const rejectsByReason = new Map<RejectReason, number>();
  let activeConnections = 0;
  let pairedSlots = 0;
  let waitingSlotsSource: () => WaitingSlotsByRole = () => NO_WAITING_SLOTS;
  let connectionsTotal = 0;
  let messagesForwardedTotal = 0;
  let bytesForwardedTotal = 0;
  let sessionsTotal = 0;
  let peerClosedTotal = 0;
  let pongTimeoutsTotal = 0;

  function waitingSlotsTotal(byRole: WaitingSlotsByRole): number {
    return byRole.desktop + byRole.mobile + byRole.unknown;
  }

  function snapshot(): MetricsSnapshot {
    const waitingSlotsByRole = waitingSlotsSource();
    return {
      activeConnections,
      waitingSlots: waitingSlotsTotal(waitingSlotsByRole),
      waitingSlotsByRole,
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
    setWaitingSlotsSource: (source) => {
      waitingSlotsSource = source;
    },
    snapshot,
    render: () => {
      const waitingSlotsByRole = waitingSlotsSource();
      const lines = [
        '# TYPE relay_active_connections gauge',
        `relay_active_connections ${activeConnections}`,
        '# TYPE relay_waiting_slots gauge',
        `relay_waiting_slots ${waitingSlotsTotal(waitingSlotsByRole)}`,
        // The one metric here carrying a HELP line, because a panel built on it
        // loses every word of surrounding documentation and the caveat is the
        // whole point: the role is what the client said, not what it is.
        '# HELP relay_waiting_slots_by_reported_role Waiting slots by the role the client reported on connect. Self-declared and never verified.',
        '# TYPE relay_waiting_slots_by_reported_role gauge',
        // Emitted from the frozen tuple, never from observed values, so the
        // series count is fixed at three no matter what a client sends.
        ...PEER_ROLES.map(
          (role) => `relay_waiting_slots_by_reported_role{role="${role}"} ${waitingSlotsByRole[role]}`,
        ),
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
 * Constant-time bearer comparison, so the response latency does not leak how
 * many leading bytes of a guessed token were correct.
 */
function matchesBearerToken(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (typeof authorizationHeader !== 'string') return false;
  const presented = Buffer.from(authorizationHeader);
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * Shared gate for both metrics surfaces: 404 when disabled, 404 when no token
 * is configured, and 401 when a token is configured but not presented.
 * Returns true when the request may proceed (the response is already finished
 * otherwise).
 *
 * The middle case is the one worth explaining. These surfaces carry no slot
 * ids and no IPs, but the live waiting/paired gauges reveal when pairings
 * happen and the per-reason reject counters tell a prober exactly which guard
 * they tripped, which is a useful feedback channel to deny a stranger.
 *
 * The relay cannot tell from inside the process whether it is internet
 * reachable - in a container the bind address is 0.0.0.0 whether the host
 * publishes to loopback or to the world - so rather than infer it wrongly,
 * metrics simply require a token. An operator who genuinely wants them open
 * says so with METRICS_ALLOW_UNAUTHENTICATED.
 */
function authorizeMetricsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: Pick<Config, 'metricsEnabled' | 'metricsToken' | 'metricsAllowUnauthenticated'>,
): boolean {
  if (!config.metricsEnabled) {
    response.writeHead(404).end();
    return false;
  }
  if (!config.metricsToken) {
    if (!config.metricsAllowUnauthenticated) {
      // Indistinguishable from METRICS_ENABLED=false on the wire, so an
      // untokened deployment does not advertise that a gated surface is here.
      response.writeHead(404).end();
      return false;
    }
    return true;
  }
  const authorizationHeader = request.headers['authorization'];
  if (!matchesBearerToken(authorizationHeader, config.metricsToken)) {
    response.writeHead(401).end();
    return false;
  }
  return true;
}

export function handleMetricsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  metrics: Metrics,
  config: Pick<Config, 'metricsEnabled' | 'metricsToken' | 'metricsAllowUnauthenticated'>,
): void {
  if (!authorizeMetricsRequest(request, response, config)) return;
  response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
}

/**
 * Process health sampled by the history recorder, when one is running. Passed
 * in structurally rather than imported, so this module keeps no dependency on
 * the recorder.
 */
export interface MetricsProcessExtras {
  /** Null until the recorder's first tick; the lifetime average is used then. */
  readonly cpuPercent: number | null;
  readonly sampleWindowMs: number | null;
  readonly eventLoopLagP99Ms: number | null;
  readonly rssPercent: number | null;
  readonly historyRecorderHealthy: boolean;
  readonly historyPersistence: 'memory' | 'file';
}

/**
 * Lifetime-average CPU, used when no recorder is running. Free: process.cpuUsage()
 * with no argument is cumulative since start, so no background sampler is needed.
 */
function cpuPercentSinceStart(): number {
  const uptimeSeconds = process.uptime();
  if (uptimeSeconds <= 0) return 0;
  const usage = process.cpuUsage();
  return Math.round(((usage.user + usage.system) / (uptimeSeconds * 1_000_000)) * 1000) / 10;
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
  config: Pick<Config, 'metricsEnabled' | 'metricsToken' | 'metricsAllowUnauthenticated'>,
  processExtras: MetricsProcessExtras | null = null,
): void {
  if (!authorizeMetricsRequest(request, response, config)) return;
  const currentSnapshot = metrics.snapshot();
  const memory = process.memoryUsage();
  const body = {
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    // Percent of ONE core, deliberately unclamped: cpuUsage() covers every
    // thread, so a saturated libuv threadpool legitimately reads above 100.
    cpuPercent: processExtras?.cpuPercent ?? cpuPercentSinceStart(),
    // Null means the figure above covers the whole process lifetime rather
    // than a recorder sampling window.
    cpuPercentWindowMs: processExtras?.sampleWindowMs ?? null,
    eventLoopLagP99Ms: processExtras?.eventLoopLagP99Ms ?? null,
    rssPercent: processExtras?.rssPercent ?? null,
    ...(processExtras === null
      ? {}
      : {
          historyRecorderHealthy: processExtras.historyRecorderHealthy,
          historyPersistence: processExtras.historyPersistence,
        }),
    activeConnections: currentSnapshot.activeConnections,
    waitingSlots: currentSnapshot.waitingSlots,
    waitingSlotsByRole: currentSnapshot.waitingSlotsByRole,
    pairedSlots: currentSnapshot.pairedSlots,
    connectionsTotal: currentSnapshot.connectionsTotal,
    sessionsTotal: currentSnapshot.sessionsTotal,
    framesForwardedTotal: currentSnapshot.framesForwardedTotal,
    bytesForwardedTotal: currentSnapshot.bytesForwardedTotal,
    closedByCause: closedByCauseFromSnapshot(currentSnapshot),
    rejectsByReason: currentSnapshot.rejectsByReason,
  };
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
