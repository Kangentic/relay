import { performance } from 'node:perf_hooks';
import type { RejectReason, TeardownCause } from './closeCodes.js';
import { millisecondsSinceUpgrade, parseCfRay } from './connectionTrace.js';
import { parseClientDialId } from './guards/dialId.js';
import type { PeerRole } from './guards/peerRole.js';
import { RateLimiter } from './guards/rateLimit.js';
import type { Metrics } from './http/metrics.js';
import type { Logger } from './logging.js';
import type { Conn } from './types.js';

/**
 * Per-dial correlation: the relay's half of the join between a client's own
 * error report and what the relay saw of that dial.
 *
 * A client that sends `&dial=<16 hex>` gets exactly one line from the relay:
 * 'dial rejected' if its upgrade was refused, or 'dial closed' when the
 * connection that opened finally ends. The id is the join key. The client
 * mints it per dial attempt and records it beside its own event, which is what
 * makes a dial the client could not diagnose (refused before it opened, or
 * dropped with a bare 1006) findable here.
 *
 * Gated on the id, not on CONNECTION_TRACE. A client that sends nothing, which
 * includes every prober, writes nothing and costs nothing: no record, no clock
 * read, no budget. And the trace is an investigation flag meant to be switched
 * off when that investigation ends, so the correlation record must not die
 * with it. When the trace IS on, its own line carries the same clientDialId,
 * so the timings join too.
 *
 * Blind like everything else here. Both lines are built from an allowlist of
 * fields, never by filtering a larger object, so no slot id, no IP, and no
 * frame content can reach them. Nothing here runs per frame.
 */

export interface DialCorrelation {
  readonly clientDialId: string;
  /** Cloudflare's ray id for the upgrade request, when one was sent and well formed. */
  readonly cfRay: string | null;
  /** Wall-clock time the dial was read, for lining up with a client's own timestamps. */
  readonly upgradeReceivedAtEpochMs: number;
  /**
   * Monotonic origin for the offsets below. Read when the dial id is parsed
   * rather than when the upgrade arrived, so a request without one never pays
   * for a clock read; the difference is the URL parse and the slot check,
   * which is microseconds.
   */
  readonly upgradeReceivedAtMonotonicMs: number;
  /** Dial to the 101 written back. Null until (and unless) the upgrade completes. */
  openedAfterMs: number | null;
}

/**
 * Every reject reason the counters already know, plus two that only this line
 * reports. Neither joins RejectReason or reaches metrics.onReject: they are
 * paths the counters have never covered, and adding them there would change
 * what an existing dashboard reads.
 *
 * - admission_error: the AdmissionPolicy threw, and the upgrade handler
 *   answered 503.
 * - handshake_aborted: ws refused the handshake itself (a bad
 *   Sec-WebSocket-Key or -Version, a non-GET method) or the socket died while
 *   admission was awaited, so the relay never wrote a 101.
 */
export type DialRejectReason = RejectReason | 'admission_error' | 'handshake_aborted';

/**
 * What the relay answered a rejected dial with: an HTTP status before the
 * upgrade, or a close code after it (an admission deny). Null when ws aborted
 * the handshake itself, since its status is not observable from here.
 */
export type DialRejectAnswer =
  | { readonly httpStatus: number; readonly closeCode?: never }
  | { readonly closeCode: number; readonly httpStatus?: never };

export type DialRejectionLine = {
  readonly clientDialId: string;
  readonly cfRay: string | null;
  readonly role: PeerRole;
  readonly reason: DialRejectReason;
  readonly httpStatus: number | null;
  readonly closeCode: number | null;
  readonly upgradeReceivedAt: string;
  readonly rejectedAfterMs: number;
};

export type DialCloseLine = {
  readonly clientDialId: string;
  readonly connId: string;
  readonly cfRay: string | null;
  readonly role: PeerRole;
  readonly upgradeReceivedAt: string;
  readonly openedAfterMs: number | null;
  readonly closedAfterMs: number;
  /** Whether it ever paired: nothing moves a connection out of 'paired' once it gets there. */
  readonly paired: boolean;
  /** As the 'close' event reported it: the peer's echoed code, or 1006 when none came back. */
  readonly closeCode: number;
  /** Why the relay ended it. Null when the relay never decided to. */
  readonly teardownCause: TeardownCause | null;
};

/**
 * Reads the client's dial id for a request whose slot already passed its
 * format check. Returns null for anything parseClientDialId refuses, and also
 * for an id that appears inside the slot id: a client that minted its dial id
 * by truncating its slot would otherwise write half of a rendezvous secret
 * into a log line. A random collision is around 1e-18, so this never drops an
 * honest id in practice.
 */
export function resolveClientDialId(raw: string | null, slotId: string): string | null {
  const clientDialId = parseClientDialId(raw);
  if (clientDialId === null || slotId.includes(clientDialId)) return null;
  return clientDialId;
}

export function startDialCorrelation(
  clientDialId: string,
  cfRayHeader: string | readonly string[] | undefined,
): DialCorrelation {
  return {
    clientDialId,
    cfRay: parseCfRay(cfRayHeader),
    upgradeReceivedAtEpochMs: Date.now(),
    upgradeReceivedAtMonotonicMs: performance.now(),
    openedAfterMs: null,
  };
}

/** Stamps the 101 moment once. Called from the upgrade callback, never per frame. */
export function markDialOpened(dial: DialCorrelation): void {
  if (dial.openedAfterMs === null) dial.openedAfterMs = millisecondsSinceUpgrade(dial);
}

/** The 'dial rejected' line. Built from an allowlist: no slot id and no IP can reach it. */
export function describeDialRejection(
  dial: DialCorrelation,
  role: PeerRole,
  reason: DialRejectReason,
  answer: DialRejectAnswer | null,
): DialRejectionLine {
  return {
    clientDialId: dial.clientDialId,
    cfRay: dial.cfRay,
    role,
    reason,
    httpStatus: answer?.httpStatus ?? null,
    closeCode: answer?.closeCode ?? null,
    upgradeReceivedAt: new Date(dial.upgradeReceivedAtEpochMs).toISOString(),
    rejectedAfterMs: millisecondsSinceUpgrade(dial),
  };
}

/** The 'dial closed' line. Built from an allowlist: no slot id and no IP can reach it. */
export function describeDialClose(conn: Conn, dial: DialCorrelation, closeCode: number): DialCloseLine {
  return {
    clientDialId: dial.clientDialId,
    connId: conn.id,
    cfRay: dial.cfRay,
    role: conn.role,
    upgradeReceivedAt: new Date(dial.upgradeReceivedAtEpochMs).toISOString(),
    openedAfterMs: dial.openedAfterMs,
    closedAfterMs: millisecondsSinceUpgrade(dial),
    paired: conn.state === 'paired',
    closeCode,
    teardownCause: conn.teardownCause,
  };
}

/**
 * Records why the relay is ending a connection. First writer wins: a guard
 * teardown closes both halves, and the partner's own close then reaches
 * handleClose's peer_closed branch, which must not overwrite the guard that
 * actually started it.
 */
export function recordTeardownCause(conn: Conn, cause: TeardownCause): void {
  if (conn.teardownCause === null) conn.teardownCause = cause;
}

export interface DialLog {
  rejected(dial: DialCorrelation, role: PeerRole, reason: DialRejectReason, answer: DialRejectAnswer | null): void;
  closed(conn: Conn, dial: DialCorrelation, closeCode: number): void;
}

export interface DialLogDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** DIAL_LOG_MAX_PER_MIN. 0 means off, and then no DialLog exists at all. */
  readonly maxLinesPerMinute: number;
  /** Injectable clock for the ceiling, so a test can refill it without waiting a minute. */
  readonly now?: () => number;
}

/** The ceiling is process-wide, so its token bucket has exactly one key. */
const DIAL_LOG_BUDGET_KEY = 'dial-log';

/**
 * Builds the writer for both lines, or null when DIAL_LOG_MAX_PER_MIN is 0, so
 * an operator who turns the lines off gets no parse, no record, and no budget,
 * the same structural off as the trace.
 *
 * The ceiling is the runaway-bill guard for log volume. A real client produces
 * about one line per dial, but anyone can send a well-formed id and then trip
 * a cheap guard (a 429 costs an attacker one request) as fast as they like, so
 * both lines draw on one process-wide token bucket holding a minute's worth.
 * A line over it is dropped and counted, never queued: the counter is how an
 * operator tells a quiet hour from a suppressed one.
 */
export function createDialLog(deps: DialLogDeps): DialLog | null {
  if (deps.maxLinesPerMinute <= 0) return null;
  const budget = new RateLimiter(deps.maxLinesPerMinute, deps.maxLinesPerMinute, deps.now);

  function withinBudget(): boolean {
    if (budget.tryConsume(DIAL_LOG_BUDGET_KEY)) return true;
    deps.metrics.onDialLogSuppressed();
    return false;
  }

  return {
    rejected: (dial, role, reason, answer) => {
      if (!withinBudget()) return;
      deps.logger.info('dial rejected', describeDialRejection(dial, role, reason, answer));
    },
    closed: (conn, dial, closeCode) => {
      if (!withinBudget()) return;
      deps.logger.info('dial closed', describeDialClose(conn, dial, closeCode));
    },
  };
}
