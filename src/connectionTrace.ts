import { performance } from 'node:perf_hooks';
import type { Conn } from './types.js';

/**
 * Opt-in per-connection timing, for localizing a slow dial or a slow first
 * exchange to a leg of the path (client, Cloudflare edge, origin, relay).
 *
 * Off by default (CONNECTION_TRACE), and off is structural, the same way the
 * metrics history is: no accept listener, no trace object, and the plain
 * message listener, so the forwarding hot path is byte-identical to a relay
 * that never had this. When on, the extra work per connection is a handful of
 * clock reads plus a bounded record of its first TRACE_FRAME_LIMIT frames,
 * after which the traced listener swaps itself out for the plain one.
 *
 * Blind like everything else here: a frame contributes its arrival time, its
 * length, and the queue it was written behind, never its content. The log
 * line carries no slot id and no IP. CF-Ray is Cloudflare's per-request id,
 * which is what lets one line be matched against Caddy's access log and a
 * client's own timings for the same dial.
 */

/** Frames per connection the trace records before it removes itself from the message path. */
export const TRACE_FRAME_LIMIT = 8;

/**
 * Cloudflare's ray id: 16 lowercase hex digits, a dash, and a three-letter
 * colo code. Anything else is dropped rather than logged, because the header
 * is client-controlled when the origin is reached directly, and a free-form
 * header copied into a log line is a log-injection vector.
 */
const CF_RAY_PATTERN = /^[0-9a-f]{16}-[A-Z]{3}$/;

export interface TracedFrame {
  /** Milliseconds after the upgrade request reached the relay. */
  readonly receivedAfterMs: number;
  readonly bytes: number;
  /**
   * The partner's outbound queue this frame was written behind, in bytes.
   * Null when the frame was not forwarded on arrival: the connection was still
   * parked (the frame is flushed at pairedAfterMs), or the partner was gone.
   */
  readonly queuedAheadBytes: number | null;
}

export interface ConnectionTrace {
  readonly cfRay: string | null;
  /** Wall-clock time the upgrade reached the relay, for lining up with Caddy and client logs. */
  readonly upgradeReceivedAtEpochMs: number;
  /** Monotonic origin for every offset below, immune to wall-clock steps. */
  readonly upgradeReceivedAtMonotonicMs: number;
  /**
   * How long the TCP connection carrying the upgrade had already been open.
   * Near zero on a fresh dial; larger when a proxy reused a keep-alive
   * connection for it. Null when the accept was not observed.
   */
  readonly socketAgeAtUpgradeMs: number | null;
  /** Upgrade received to admission decided: the guards and the AdmissionPolicy. */
  admittedAfterMs: number | null;
  /** Upgrade received to the 101 written back. */
  handshakeCompletedAfterMs: number | null;
  /** Upgrade received to paired with a partner. Null if it never paired. */
  pairedAfterMs: number | null;
  readonly frames: TracedFrame[];
}

function roundToHundredth(value: number): number {
  return Math.round(value * 100) / 100;
}

export function parseCfRay(header: string | readonly string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && CF_RAY_PATTERN.test(value) ? value : null;
}

export function startConnectionTrace(
  cfRayHeader: string | readonly string[] | undefined,
  socketAcceptedAtMonotonicMs: number | undefined,
): ConnectionTrace {
  const upgradeReceivedAtMonotonicMs = performance.now();
  return {
    cfRay: parseCfRay(cfRayHeader),
    upgradeReceivedAtEpochMs: Date.now(),
    upgradeReceivedAtMonotonicMs,
    socketAgeAtUpgradeMs:
      socketAcceptedAtMonotonicMs === undefined
        ? null
        : roundToHundredth(upgradeReceivedAtMonotonicMs - socketAcceptedAtMonotonicMs),
    admittedAfterMs: null,
    handshakeCompletedAfterMs: null,
    pairedAfterMs: null,
    frames: [],
  };
}

export function millisecondsSinceUpgrade(trace: ConnectionTrace): number {
  return roundToHundredth(performance.now() - trace.upgradeReceivedAtMonotonicMs);
}

/** Stamps the pairing moment once. Called once per pairing, never per frame. */
export function markTracePaired(conn: Conn): void {
  if (conn.trace === null || conn.trace.pairedAfterMs !== null) return;
  conn.trace.pairedAfterMs = millisecondsSinceUpgrade(conn.trace);
}

/**
 * The one log line a traced connection produces, at close. Deliberately built
 * from an allowlist of fields: no slot id and no IP can reach it.
 */
export function describeConnectionTrace(conn: Conn, trace: ConnectionTrace, closeCode: number): Record<string, unknown> {
  return {
    connId: conn.id,
    role: conn.role,
    cfRay: trace.cfRay,
    upgradeReceivedAt: new Date(trace.upgradeReceivedAtEpochMs).toISOString(),
    socketAgeAtUpgradeMs: trace.socketAgeAtUpgradeMs,
    admittedAfterMs: trace.admittedAfterMs,
    handshakeCompletedAfterMs: trace.handshakeCompletedAfterMs,
    pairedAfterMs: trace.pairedAfterMs,
    closedAfterMs: millisecondsSinceUpgrade(trace),
    closeCode,
    frames: trace.frames,
  };
}
