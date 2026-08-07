import type { RejectReason } from '../closeCodes.js';
import { buildClosedByCause, type MetricsSnapshot } from '../http/metrics.js';
import type { ProcessSample } from './processSampler.js';

/**
 * Bumped whenever a wire key changes meaning. An append-only file on a named
 * volume outlives a year of deploys, so without a version the compactor could
 * not tell "written by older code" from "corrupt" and the skip-malformed
 * policy would silently eat a year of valid history on the first schema
 * change. Unknown versions are counted and passed through untouched.
 */
export const HISTORY_SCHEMA_VERSION = 1;

export type HistoryResolutionSeconds = 60 | 300 | 3600;

export const FINE_RESOLUTION_SECONDS: HistoryResolutionSeconds = 60;
export const MID_RESOLUTION_SECONDS: HistoryResolutionSeconds = 300;
export const COARSE_RESOLUTION_SECONDS: HistoryResolutionSeconds = 3600;

/** 1-minute rows for 48h, 5-minute for 30d, hourly for 1 year. ~20k rows. */
export const FINE_RETENTION_MS = 48 * 60 * 60 * 1000;
export const MID_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const COARSE_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Backstop for the case tiering cannot handle: a forward clock step writes
 * rows dated in the future, which then stay "young" and never age out.
 */
export const MAX_HISTORY_ROW_COUNT = 20_000;

/**
 * A sampled series. On a raw row `mean` is null, because a point sample is its
 * own mean; aggregated rows carry both.
 *
 * Gauges are point samples taken once per interval, so `maximum` on a raw row
 * is "the one sample we took", NOT a true interval peak. A spike that rises
 * and falls between ticks is invisible. Sampling faster is what the
 * performance budget forbids, so this is an accepted limit worth stating
 * rather than a bug.
 */
export interface HistorySeriesValue {
  readonly maximum: number;
  readonly mean: number | null;
}

export interface HistoryRow {
  readonly schemaVersion: number;
  /** Bucket start on aggregated rows, sample instant on raw rows. */
  readonly timestampMs: number;
  readonly resolutionSeconds: HistoryResolutionSeconds;
  /** Milliseconds this row actually covers. Never assume the configured interval. */
  readonly windowMs: number;
  /** Per-recorder-instance hex, so interleaved writers are detectable. Null once aggregated. */
  readonly instanceId: string | null;
  readonly uptimeSeconds: number | null;
  /** 0 or 1 on a raw row; the count of restarts inside the bucket once aggregated. */
  readonly restartCount: number;
  readonly sourceRowCount: number;

  readonly connectionsDelta: number;
  readonly sessionsDelta: number;
  readonly framesForwardedDelta: number;
  readonly bytesForwardedDelta: number;
  readonly peerClosedDelta: number;
  readonly pongTimeoutsDelta: number;
  readonly rejectsByReasonDelta: Readonly<Partial<Record<RejectReason, number>>>;

  readonly activeConnections: HistorySeriesValue;
  readonly waitingSlots: HistorySeriesValue;
  readonly pairedSlots: HistorySeriesValue;

  readonly cpuPercent: HistorySeriesValue | null;
  /** Max only when aggregated: averaging p99 values across buckets is meaningless. */
  readonly eventLoopLagP99Ms: number | null;
  readonly rssBytes: number | null;
  readonly rssPercent: number | null;

  /**
   * Peak outbound socket queue depth across live connections. This is the
   * closest thing the relay has to a latency signal without timestamping
   * frames: a queue that is growing means that consumer is not keeping up, and
   * every byte behind it is waiting. Null when no connection sampler ran.
   */
  readonly maxOutboundBufferBytes: number | null;
  /** Connections whose outbound queue passed a quarter of the teardown cap. */
  readonly backloggedConnections: number | null;
  /** Peak pre-pair buffer held by a connection still waiting for its partner. */
  readonly maxParkedBufferBytes: number | null;
}

/**
 * Sampled from live connections on the recorder tick, never per frame. Reading
 * bufferedAmount is O(connections) once an interval, which is far cheaper than
 * anything that would touch the forwarding path.
 */
export interface ConnectionSample {
  readonly maxOutboundBufferBytes: number;
  readonly backloggedConnections: number;
  readonly maxParkedBufferBytes: number;
}

export interface HistorySampleInput {
  readonly timestampMs: number;
  readonly windowMs: number;
  readonly instanceId: string;
  readonly uptimeSeconds: number;
  readonly isRestartBoundary: boolean;
  readonly previousSnapshot: MetricsSnapshot;
  readonly currentSnapshot: MetricsSnapshot;
  readonly processSample: ProcessSample | null;
  readonly connectionSample: ConnectionSample | null;
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Counters zero on restart, so a raw subtraction can go negative across a
 * process boundary. Clamping here means no arithmetic path anywhere can emit
 * a negative rate.
 */
function counterDelta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

function rejectsDelta(
  current: Readonly<Partial<Record<RejectReason, number>>>,
  previous: Readonly<Partial<Record<RejectReason, number>>>,
): Readonly<Partial<Record<RejectReason, number>>> {
  const delta: Partial<Record<RejectReason, number>> = {};
  for (const [reason, currentCount] of Object.entries(current) as [RejectReason, number][]) {
    const difference = Math.max(0, currentCount - (previous[reason] ?? 0));
    if (difference !== 0) delta[reason] = difference;
  }
  return delta;
}

function pointSample(value: number): HistorySeriesValue {
  return { maximum: value, mean: null };
}

/** Builds one raw row from two snapshots. Pure: no clock, no I/O. */
export function buildHistoryRow(input: HistorySampleInput): HistoryRow {
  const { currentSnapshot, previousSnapshot, processSample } = input;
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestampMs: input.timestampMs,
    resolutionSeconds: FINE_RESOLUTION_SECONDS,
    windowMs: input.windowMs,
    instanceId: input.instanceId,
    uptimeSeconds: input.uptimeSeconds,
    restartCount: input.isRestartBoundary ? 1 : 0,
    sourceRowCount: 1,
    connectionsDelta: counterDelta(currentSnapshot.connectionsTotal, previousSnapshot.connectionsTotal),
    sessionsDelta: counterDelta(currentSnapshot.sessionsTotal, previousSnapshot.sessionsTotal),
    framesForwardedDelta: counterDelta(currentSnapshot.framesForwardedTotal, previousSnapshot.framesForwardedTotal),
    bytesForwardedDelta: counterDelta(currentSnapshot.bytesForwardedTotal, previousSnapshot.bytesForwardedTotal),
    peerClosedDelta: counterDelta(currentSnapshot.peerClosedTotal, previousSnapshot.peerClosedTotal),
    pongTimeoutsDelta: counterDelta(currentSnapshot.pongTimeoutsTotal, previousSnapshot.pongTimeoutsTotal),
    rejectsByReasonDelta: rejectsDelta(currentSnapshot.rejectsByReason, previousSnapshot.rejectsByReason),
    activeConnections: pointSample(currentSnapshot.activeConnections),
    waitingSlots: pointSample(currentSnapshot.waitingSlots),
    pairedSlots: pointSample(currentSnapshot.pairedSlots),
    cpuPercent: processSample === null ? null : pointSample(processSample.cpuPercent),
    eventLoopLagP99Ms: processSample?.eventLoopLagP99Ms ?? null,
    rssBytes: processSample?.rssBytes ?? null,
    rssPercent: processSample?.rssPercent ?? null,
    maxOutboundBufferBytes: input.connectionSample?.maxOutboundBufferBytes ?? null,
    backloggedConnections: input.connectionSample?.backloggedConnections ?? null,
    maxParkedBufferBytes: input.connectionSample?.maxParkedBufferBytes ?? null,
  };
}

/**
 * The same grouping /metricz reports, fed per-interval deltas instead of
 * lifetime totals. The mapping itself lives in buildClosedByCause and is not
 * repeated here, so the two surfaces cannot drift apart.
 */
export function deriveClosedByCause(row: HistoryRow): Readonly<Record<string, number>> {
  return buildClosedByCause({
    peerClosed: row.peerClosedDelta,
    pongTimeouts: row.pongTimeoutsDelta,
    rejects: row.rejectsByReasonDelta,
  });
}

/** Which tier a row of the given age belongs in. */
export function targetResolutionSecondsForAge(ageMs: number): HistoryResolutionSeconds {
  if (ageMs <= FINE_RETENTION_MS) return FINE_RESOLUTION_SECONDS;
  if (ageMs <= MID_RETENTION_MS) return MID_RESOLUTION_SECONDS;
  return COARSE_RESOLUTION_SECONDS;
}

/**
 * Resolution may only ever increase. Without this an hourly row could be
 * re-bucketed into a 5-minute bucket after a clock step, fabricating detail
 * that was already discarded.
 */
export function effectiveResolutionSeconds(row: HistoryRow, ageMs: number): HistoryResolutionSeconds {
  const target = targetResolutionSecondsForAge(ageMs);
  return (Math.max(row.resolutionSeconds, target) as HistoryResolutionSeconds);
}

/**
 * Epoch-aligned, so compaction is idempotent: an already-aggregated row sits
 * on a bucket boundary, regroups into a bucket of one, and aggregating one row
 * returns it unchanged. Bucketing relative to "now" would move the edges on
 * every run and let repeated compaction drift and double count.
 */
export function bucketStartMs(timestampMs: number, resolutionSeconds: HistoryResolutionSeconds): number {
  const bucketMs = resolutionSeconds * 1000;
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

function mergeSeries(values: readonly { value: HistorySeriesValue; windowMs: number }[]): HistorySeriesValue {
  let maximum = 0;
  let weightedTotal = 0;
  let weightTotal = 0;
  for (const entry of values) {
    maximum = Math.max(maximum, entry.value.maximum);
    // Rows have unequal windows after a shutdown flush or a missed tick, so a
    // plain average would over-weight short rows.
    const rowMean = entry.value.mean ?? entry.value.maximum;
    weightedTotal += rowMean * entry.windowMs;
    weightTotal += entry.windowMs;
  }
  return { maximum, mean: weightTotal === 0 ? null : roundToTenth(weightedTotal / weightTotal) };
}

/**
 * Merges rows that share a bucket. Aggregating a single row must return that
 * row unchanged, which is what makes repeated compaction a no-op.
 */
export function aggregateHistoryRows(
  rows: readonly HistoryRow[],
  timestampMs: number,
  resolutionSeconds: HistoryResolutionSeconds,
): HistoryRow {
  const first = rows[0];
  if (first === undefined) throw new Error('aggregateHistoryRows requires at least one row');
  if (rows.length === 1 && first.timestampMs === timestampMs && first.resolutionSeconds === resolutionSeconds) {
    return first;
  }

  const rejectsByReasonDelta: Partial<Record<RejectReason, number>> = {};
  let windowMs = 0;
  let restartCount = 0;
  let sourceRowCount = 0;
  let connectionsDelta = 0;
  let sessionsDelta = 0;
  let framesForwardedDelta = 0;
  let bytesForwardedDelta = 0;
  let peerClosedDelta = 0;
  let pongTimeoutsDelta = 0;
  let eventLoopLagP99Ms: number | null = null;
  let rssBytes: number | null = null;
  let rssPercent: number | null = null;
  let uptimeSeconds: number | null = null;
  let maxOutboundBufferBytes: number | null = null;
  let backloggedConnections: number | null = null;
  let maxParkedBufferBytes: number | null = null;

  const activeConnections: { value: HistorySeriesValue; windowMs: number }[] = [];
  const waitingSlots: { value: HistorySeriesValue; windowMs: number }[] = [];
  const pairedSlots: { value: HistorySeriesValue; windowMs: number }[] = [];
  const cpuPercent: { value: HistorySeriesValue; windowMs: number }[] = [];

  for (const row of rows) {
    windowMs += row.windowMs;
    restartCount += row.restartCount;
    sourceRowCount += row.sourceRowCount;
    connectionsDelta += row.connectionsDelta;
    sessionsDelta += row.sessionsDelta;
    framesForwardedDelta += row.framesForwardedDelta;
    bytesForwardedDelta += row.bytesForwardedDelta;
    peerClosedDelta += row.peerClosedDelta;
    pongTimeoutsDelta += row.pongTimeoutsDelta;
    for (const [reason, count] of Object.entries(row.rejectsByReasonDelta) as [RejectReason, number][]) {
      rejectsByReasonDelta[reason] = (rejectsByReasonDelta[reason] ?? 0) + count;
    }
    activeConnections.push({ value: row.activeConnections, windowMs: row.windowMs });
    waitingSlots.push({ value: row.waitingSlots, windowMs: row.windowMs });
    pairedSlots.push({ value: row.pairedSlots, windowMs: row.windowMs });
    if (row.cpuPercent !== null) cpuPercent.push({ value: row.cpuPercent, windowMs: row.windowMs });
    if (row.eventLoopLagP99Ms !== null) {
      eventLoopLagP99Ms = Math.max(eventLoopLagP99Ms ?? 0, row.eventLoopLagP99Ms);
    }
    if (row.rssBytes !== null) rssBytes = Math.max(rssBytes ?? 0, row.rssBytes);
    if (row.rssPercent !== null) rssPercent = Math.max(rssPercent ?? 0, row.rssPercent);
    if (row.uptimeSeconds !== null) uptimeSeconds = row.uptimeSeconds;
    // Peak-preserving, like the other headroom signals: a bucket that contained
    // one badly backed-up consumer must not average that away.
    if (row.maxOutboundBufferBytes !== null) {
      maxOutboundBufferBytes = Math.max(maxOutboundBufferBytes ?? 0, row.maxOutboundBufferBytes);
    }
    if (row.backloggedConnections !== null) {
      backloggedConnections = Math.max(backloggedConnections ?? 0, row.backloggedConnections);
    }
    if (row.maxParkedBufferBytes !== null) {
      maxParkedBufferBytes = Math.max(maxParkedBufferBytes ?? 0, row.maxParkedBufferBytes);
    }
  }

  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestampMs,
    resolutionSeconds,
    windowMs,
    // Aggregated rows span instances, so no single one identifies them.
    instanceId: null,
    uptimeSeconds,
    restartCount,
    sourceRowCount,
    connectionsDelta,
    sessionsDelta,
    framesForwardedDelta,
    bytesForwardedDelta,
    peerClosedDelta,
    pongTimeoutsDelta,
    rejectsByReasonDelta,
    activeConnections: mergeSeries(activeConnections),
    waitingSlots: mergeSeries(waitingSlots),
    pairedSlots: mergeSeries(pairedSlots),
    cpuPercent: cpuPercent.length === 0 ? null : mergeSeries(cpuPercent),
    eventLoopLagP99Ms,
    rssBytes,
    rssPercent,
    maxOutboundBufferBytes,
    backloggedConnections,
    maxParkedBufferBytes,
  };
}

/**
 * Short wire keys with zero-valued fields omitted. The abbreviation lives here
 * and in parseHistoryRow and nowhere else, so no other code reads them. Most
 * intervals leave most counters at zero, which takes a quiet row to roughly
 * 110 bytes and keeps the hourly whole-file compaction read small.
 */
export function serializeHistoryRow(row: HistoryRow): string {
  const record: Record<string, unknown> = {
    v: row.schemaVersion,
    t: row.timestampMs,
    r: row.resolutionSeconds,
    w: row.windowMs,
  };
  if (row.instanceId !== null) record['i'] = row.instanceId;
  if (row.uptimeSeconds !== null) record['u'] = row.uptimeSeconds;
  if (row.sourceRowCount !== 1) record['n'] = row.sourceRowCount;
  if (row.restartCount !== 0) record['rs'] = row.restartCount;
  if (row.connectionsDelta !== 0) record['c'] = row.connectionsDelta;
  if (row.sessionsDelta !== 0) record['s'] = row.sessionsDelta;
  if (row.framesForwardedDelta !== 0) record['f'] = row.framesForwardedDelta;
  if (row.bytesForwardedDelta !== 0) record['b'] = row.bytesForwardedDelta;
  if (row.peerClosedDelta !== 0) record['pc'] = row.peerClosedDelta;
  if (row.pongTimeoutsDelta !== 0) record['pt'] = row.pongTimeoutsDelta;
  if (Object.keys(row.rejectsByReasonDelta).length > 0) record['rj'] = row.rejectsByReasonDelta;
  if (row.activeConnections.maximum !== 0) record['ac'] = row.activeConnections.maximum;
  if (row.activeConnections.mean !== null) record['acm'] = row.activeConnections.mean;
  if (row.waitingSlots.maximum !== 0) record['ws'] = row.waitingSlots.maximum;
  if (row.waitingSlots.mean !== null) record['wsm'] = row.waitingSlots.mean;
  if (row.pairedSlots.maximum !== 0) record['ps'] = row.pairedSlots.maximum;
  if (row.pairedSlots.mean !== null) record['psm'] = row.pairedSlots.mean;
  if (row.cpuPercent !== null) {
    if (row.cpuPercent.maximum !== 0) record['cp'] = row.cpuPercent.maximum;
    if (row.cpuPercent.mean !== null) record['cpm'] = row.cpuPercent.mean;
  }
  if (row.eventLoopLagP99Ms !== null) record['el'] = row.eventLoopLagP99Ms;
  if (row.rssBytes !== null) record['rb'] = row.rssBytes;
  if (row.rssPercent !== null) record['rp'] = row.rssPercent;
  if (row.maxOutboundBufferBytes !== null) record['ob'] = row.maxOutboundBufferBytes;
  if (row.backloggedConnections !== null) record['bl'] = row.backloggedConnections;
  if (row.maxParkedBufferBytes !== null) record['pb'] = row.maxParkedBufferBytes;
  return JSON.stringify(record);
}

export type HistoryRowParseResult =
  | { readonly kind: 'row'; readonly row: HistoryRow }
  | { readonly kind: 'unknownVersion'; readonly rawLine: string }
  | { readonly kind: 'malformed' };

function readNumber(record: Record<string, unknown>, key: string, defaultValue: number): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readSeries(record: Record<string, unknown>, maximumKey: string, meanKey: string): HistorySeriesValue {
  return { maximum: readNumber(record, maximumKey, 0), mean: readNullableNumber(record, meanKey) };
}

function isResolution(value: number): value is HistoryResolutionSeconds {
  return value === 60 || value === 300 || value === 3600;
}

function readRejects(record: Record<string, unknown>): Readonly<Partial<Record<RejectReason, number>>> {
  const raw = record['rj'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const rejects: Partial<Record<RejectReason, number>> = {};
  for (const [reason, count] of Object.entries(raw)) {
    if (typeof count === 'number' && Number.isFinite(count)) rejects[reason as RejectReason] = count;
  }
  return rejects;
}

export function parseHistoryRow(line: string): HistoryRowParseResult {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return { kind: 'malformed' };
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return { kind: 'malformed' };
  const fields = record as Record<string, unknown>;

  const schemaVersion = readNullableNumber(fields, 'v');
  if (schemaVersion === null) return { kind: 'malformed' };
  if (schemaVersion !== HISTORY_SCHEMA_VERSION) return { kind: 'unknownVersion', rawLine: line };

  const timestampMs = readNullableNumber(fields, 't');
  const resolutionSeconds = readNullableNumber(fields, 'r');
  if (timestampMs === null || resolutionSeconds === null || !isResolution(resolutionSeconds)) {
    return { kind: 'malformed' };
  }

  const instanceId = fields['i'];
  return {
    kind: 'row',
    row: {
      schemaVersion,
      timestampMs,
      resolutionSeconds,
      windowMs: readNumber(fields, 'w', resolutionSeconds * 1000),
      instanceId: typeof instanceId === 'string' ? instanceId : null,
      uptimeSeconds: readNullableNumber(fields, 'u'),
      restartCount: readNumber(fields, 'rs', 0),
      sourceRowCount: readNumber(fields, 'n', 1),
      connectionsDelta: readNumber(fields, 'c', 0),
      sessionsDelta: readNumber(fields, 's', 0),
      framesForwardedDelta: readNumber(fields, 'f', 0),
      bytesForwardedDelta: readNumber(fields, 'b', 0),
      peerClosedDelta: readNumber(fields, 'pc', 0),
      pongTimeoutsDelta: readNumber(fields, 'pt', 0),
      rejectsByReasonDelta: readRejects(fields),
      activeConnections: readSeries(fields, 'ac', 'acm'),
      waitingSlots: readSeries(fields, 'ws', 'wsm'),
      pairedSlots: readSeries(fields, 'ps', 'psm'),
      cpuPercent:
        fields['cp'] === undefined && fields['cpm'] === undefined ? null : readSeries(fields, 'cp', 'cpm'),
      eventLoopLagP99Ms: readNullableNumber(fields, 'el'),
      rssBytes: readNullableNumber(fields, 'rb'),
      rssPercent: readNullableNumber(fields, 'rp'),
      // Added after v1 shipped. Absent on older rows, which read as null rather
      // than zero so a chart shows a gap instead of inventing a flat line.
      maxOutboundBufferBytes: readNullableNumber(fields, 'ob'),
      backloggedConnections: readNullableNumber(fields, 'bl'),
      maxParkedBufferBytes: readNullableNumber(fields, 'pb'),
    },
  };
}
