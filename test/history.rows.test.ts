import { describe, it, expect } from 'vitest';
import type { MetricsSnapshot } from '../src/http/metrics.js';
import type { ProcessSample } from '../src/history/processSampler.js';
import {
  aggregateHistoryRows,
  bucketStartMs,
  buildHistoryRow,
  COARSE_RESOLUTION_SECONDS,
  deriveClosedByCause,
  effectiveResolutionSeconds,
  FINE_RETENTION_MS,
  FINE_RESOLUTION_SECONDS,
  HISTORY_SCHEMA_VERSION,
  MID_RESOLUTION_SECONDS,
  MID_RETENTION_MS,
  parseHistoryRow,
  serializeHistoryRow,
  targetResolutionSecondsForAge,
  type HistoryRow,
} from '../src/history/rows.js';

function snapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    activeConnections: 0,
    waitingSlots: 0,
    waitingSlotsByRole: { desktop: 0, mobile: 0, unknown: 0 },
    pairedSlots: 0,
    connectionsTotal: 0,
    sessionsTotal: 0,
    framesForwardedTotal: 0,
    bytesForwardedTotal: 0,
    peerClosedTotal: 0,
    pongTimeoutsTotal: 0,
    rejectsByReason: {},
    ...overrides,
  };
}

const processSample: ProcessSample = {
  cpuPercent: 1.5,
  eventLoopLagP99Ms: 4.2,
  rssBytes: 48_000_000,
  rssPercent: 3.8,
  windowMs: 60_000,
  sampledAtMs: 1_000,
};

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    ...buildHistoryRow({
      timestampMs: 1_700_000_000_000,
      windowMs: 60_000,
      instanceId: 'abcd1234',
      uptimeSeconds: 120,
      isRestartBoundary: false,
      previousSnapshot: snapshot(),
      currentSnapshot: snapshot(),
      processSample,
      connectionSample: null,
    }),
    ...overrides,
  };
}

describe('building a row from two snapshots', () => {
  it('stores counters as per-interval deltas and gauges as the instantaneous sample', () => {
    const built = buildHistoryRow({
      timestampMs: 1_700_000_000_000,
      windowMs: 60_000,
      instanceId: 'abcd1234',
      uptimeSeconds: 300,
      isRestartBoundary: false,
      previousSnapshot: snapshot({ framesForwardedTotal: 100, bytesForwardedTotal: 5_000, connectionsTotal: 4 }),
      currentSnapshot: snapshot({
        framesForwardedTotal: 175,
        bytesForwardedTotal: 9_000,
        connectionsTotal: 9,
        activeConnections: 12,
        waitingSlots: 3,
        pairedSlots: 4,
      }),
      processSample,
      connectionSample: null,
    });

    expect(built.framesForwardedDelta).toBe(75);
    expect(built.bytesForwardedDelta).toBe(4_000);
    expect(built.connectionsDelta).toBe(5);
    // Gauges are not differenced: they are levels, not accumulations.
    expect(built.activeConnections).toEqual({ maximum: 12, mean: null });
    expect(built.pairedSlots.maximum).toBe(4);
  });

  it('clamps to zero rather than emitting a negative spike when counters reset', () => {
    // This is the deploy case: every counter zeroes, and a raw subtraction
    // would render the restart as a huge negative rate.
    const built = buildHistoryRow({
      timestampMs: 1_700_000_000_000,
      windowMs: 60_000,
      instanceId: 'abcd1234',
      uptimeSeconds: 2,
      isRestartBoundary: true,
      previousSnapshot: snapshot({ framesForwardedTotal: 9_000, bytesForwardedTotal: 100_000, peerClosedTotal: 40 }),
      currentSnapshot: snapshot({ framesForwardedTotal: 3, bytesForwardedTotal: 90 }),
      processSample,
      connectionSample: null,
    });

    expect(built.framesForwardedDelta).toBe(0);
    expect(built.bytesForwardedDelta).toBe(0);
    expect(built.peerClosedDelta).toBe(0);
    expect(built.restartCount).toBe(1);
  });

  it('keeps only non-zero reject reasons, so a quiet interval carries none', () => {
    const built = buildHistoryRow({
      timestampMs: 1,
      windowMs: 60_000,
      instanceId: 'abcd1234',
      uptimeSeconds: 60,
      isRestartBoundary: false,
      previousSnapshot: snapshot({ rejectsByReason: { park_timeout: 5, slot_busy: 2 } }),
      currentSnapshot: snapshot({ rejectsByReason: { park_timeout: 8, slot_busy: 2 } }),
      processSample,
      connectionSample: null,
    });

    expect(built.rejectsByReasonDelta).toEqual({ park_timeout: 3 });
  });
});

describe('closedByCause derivation', () => {
  it('groups teardown causes from the row deltas', () => {
    const derived = deriveClosedByCause(
      row({ peerClosedDelta: 7, pongTimeoutsDelta: 2, rejectsByReasonDelta: { backpressure: 1, park_timeout: 4 } }),
    );
    expect(derived).toEqual({
      peerClosed: 7,
      backpressure: 1,
      parkedOverflow: 0,
      heartbeat: 2,
      parkTimeout: 4,
      sessionByteCap: 0,
      sessionTimeCap: 0,
    });
  });
});

describe('serialization', () => {
  it('round-trips a row through the compact wire form', () => {
    const original = row({
      framesForwardedDelta: 120,
      bytesForwardedDelta: 65_000,
      rejectsByReasonDelta: { park_timeout: 2 },
      activeConnections: { maximum: 9, mean: null },
    });
    const parsed = parseHistoryRow(serializeHistoryRow(original));
    expect(parsed.kind).toBe('row');
    if (parsed.kind !== 'row') throw new Error('expected a row');
    expect(parsed.row).toEqual(original);
  });

  it('omits zero-valued fields so a quiet row stays small', () => {
    const line = serializeHistoryRow(row());
    expect(line).not.toContain('"f"');
    expect(line).not.toContain('"b"');
    expect(line).not.toContain('"rj"');
    // A quiet row is the common case, so its size is what the file size is.
    expect(line.length).toBeLessThan(160);
  });

  it('keeps a zero CPU sample distinguishable from no CPU sample at all', () => {
    // An idle relay rounds to exactly 0.0 constantly, so this is the common
    // row, not an edge case. cpuPercent is the only nullable series, which
    // makes absence meaningful: it has to mean "no sampler ran", never "0%".
    const idle = parseHistoryRow(serializeHistoryRow(row({ cpuPercent: { maximum: 0, mean: null } })));
    if (idle.kind !== 'row') throw new Error('expected a row');
    expect(idle.row.cpuPercent).toEqual({ maximum: 0, mean: null });

    const unsampled = parseHistoryRow(serializeHistoryRow(row({ cpuPercent: null })));
    if (unsampled.kind !== 'row') throw new Error('expected a row');
    expect(unsampled.row.cpuPercent).toBeNull();
  });

  it('counts an idle minute in the compacted CPU mean rather than dropping it', () => {
    // The consequence of the case above, through the path that actually runs:
    // compaction reads rows back off disk, and aggregation skips rows whose
    // cpuPercent is null. An idle minute that read back as null would not pull
    // the hour's mean down, it would vanish from it, and a mostly-idle hour
    // would report the average of only its busy minutes.
    const bucketMs = bucketStartMs(1_700_000_000_000, MID_RESOLUTION_SECONDS);
    const readBack = (source: HistoryRow): HistoryRow => {
      const parsed = parseHistoryRow(serializeHistoryRow(source));
      if (parsed.kind !== 'row') throw new Error('expected a row');
      return parsed.row;
    };
    const busy = readBack(row({ timestampMs: bucketMs, cpuPercent: { maximum: 40, mean: null } }));
    const idle = readBack(row({ timestampMs: bucketMs + 60_000, cpuPercent: { maximum: 0, mean: null } }));

    expect(aggregateHistoryRows([busy, idle], bucketMs, MID_RESOLUTION_SECONDS).cpuPercent).toEqual({
      maximum: 40,
      mean: 20,
    });
  });

  it('reports a malformed line rather than throwing', () => {
    expect(parseHistoryRow('{not json').kind).toBe('malformed');
    expect(parseHistoryRow('{"v":1,"t":"nope","r":60}').kind).toBe('malformed');
    // A crash mid-append leaves a truncated final line.
    expect(parseHistoryRow('{"v":1,"t":170000000').kind).toBe('malformed');
  });

  it('distinguishes a future schema version from corruption, and keeps the raw line', () => {
    const line = JSON.stringify({ v: HISTORY_SCHEMA_VERSION + 1, t: 5, r: 60 });
    const parsed = parseHistoryRow(line);
    expect(parsed.kind).toBe('unknownVersion');
    if (parsed.kind !== 'unknownVersion') throw new Error('expected unknownVersion');
    expect(parsed.rawLine).toBe(line);
  });
});

describe('tiering', () => {
  it('assigns a tier by age', () => {
    expect(targetResolutionSecondsForAge(60_000)).toBe(FINE_RESOLUTION_SECONDS);
    expect(targetResolutionSecondsForAge(FINE_RETENTION_MS + 1)).toBe(MID_RESOLUTION_SECONDS);
    expect(targetResolutionSecondsForAge(MID_RETENTION_MS + 1)).toBe(COARSE_RESOLUTION_SECONDS);
  });

  it('never lowers the resolution of a row, whatever the clock says', () => {
    // Re-bucketing an hourly row into 5-minute buckets would fabricate detail
    // that was already discarded.
    const hourly = row({ resolutionSeconds: COARSE_RESOLUTION_SECONDS });
    expect(effectiveResolutionSeconds(hourly, 60_000)).toBe(COARSE_RESOLUTION_SECONDS);
    expect(effectiveResolutionSeconds(hourly, MID_RETENTION_MS + 1)).toBe(COARSE_RESOLUTION_SECONDS);
  });

  it('aligns buckets to the epoch, not to now', () => {
    // Epoch alignment is what makes compaction idempotent.
    expect(bucketStartMs(1_700_000_123_456, MID_RESOLUTION_SECONDS)).toBe(1_700_000_100_000);
    expect(bucketStartMs(1_700_000_100_000, MID_RESOLUTION_SECONDS)).toBe(1_700_000_100_000);
  });
});

describe('aggregation', () => {
  it('sums counters, keeps the maximum gauge, and window-weights the mean', () => {
    const merged = aggregateHistoryRows(
      [
        row({ timestampMs: 1_700_000_100_000, windowMs: 60_000, framesForwardedDelta: 10, activeConnections: { maximum: 10, mean: null } }),
        row({ timestampMs: 1_700_000_160_000, windowMs: 30_000, framesForwardedDelta: 5, activeConnections: { maximum: 40, mean: null } }),
      ],
      1_700_000_100_000,
      MID_RESOLUTION_SECONDS,
    );

    expect(merged.framesForwardedDelta).toBe(15);
    expect(merged.windowMs).toBe(90_000);
    // Max preserves the spike; the mean says whether it sat there or burst once.
    expect(merged.activeConnections.maximum).toBe(40);
    expect(merged.activeConnections.mean).toBe(20);
    expect(merged.resolutionSeconds).toBe(MID_RESOLUTION_SECONDS);
    expect(merged.instanceId).toBeNull();
  });

  it('keeps restart markers, so a deploy survives compaction', () => {
    const merged = aggregateHistoryRows(
      [row({ restartCount: 0 }), row({ restartCount: 1 }), row({ restartCount: 0 })],
      1_700_000_100_000,
      MID_RESOLUTION_SECONDS,
    );
    expect(merged.restartCount).toBe(1);
    expect(merged.sourceRowCount).toBe(3);
  });

  it('keeps the worst queue depth in a bucket rather than averaging it away', () => {
    // A bucket that contained one badly backed-up consumer has to still say so:
    // averaging is how a real incident becomes invisible at 30d resolution.
    const merged = aggregateHistoryRows(
      [
        row({ maxOutboundBufferBytes: 1_024, backloggedConnections: 0, maxParkedBufferBytes: 10 }),
        row({ maxOutboundBufferBytes: 8_000_000, backloggedConnections: 4, maxParkedBufferBytes: 900 }),
      ],
      1_700_000_100_000,
      MID_RESOLUTION_SECONDS,
    );
    expect(merged.maxOutboundBufferBytes).toBe(8_000_000);
    expect(merged.backloggedConnections).toBe(4);
    expect(merged.maxParkedBufferBytes).toBe(900);
  });

  it('round-trips the queue fields, and reads older rows that predate them as null', () => {
    const withQueue = row({ maxOutboundBufferBytes: 4_096, backloggedConnections: 2, maxParkedBufferBytes: 64 });
    const parsed = parseHistoryRow(serializeHistoryRow(withQueue));
    if (parsed.kind !== 'row') throw new Error('expected a row');
    expect(parsed.row.maxOutboundBufferBytes).toBe(4_096);
    expect(parsed.row.backloggedConnections).toBe(2);

    // A row written before these fields existed must read as null, not zero, so
    // the chart shows a gap instead of inventing a flat healthy line.
    const older = parseHistoryRow(JSON.stringify({ v: 1, t: 5, r: 60, w: 60_000 }));
    if (older.kind !== 'row') throw new Error('expected a row');
    expect(older.row.maxOutboundBufferBytes).toBeNull();
    expect(older.row.backloggedConnections).toBeNull();
  });

  it('round-trips the waiting role split', () => {
    const split = row({
      waitingSlots: { maximum: 5, mean: null },
      waitingDesktop: { maximum: 3, mean: null },
      waitingMobile: { maximum: 2, mean: null },
      waitingUnknown: { maximum: 0, mean: null },
    });
    const parsed = parseHistoryRow(serializeHistoryRow(split));
    if (parsed.kind !== 'row') throw new Error('expected a row');
    expect(parsed.row.waitingDesktop).toEqual({ maximum: 3, mean: null });
    expect(parsed.row.waitingMobile).toEqual({ maximum: 2, mean: null });
    expect(parsed.row.waitingUnknown).toEqual({ maximum: 0, mean: null });
  });

  it('reads a row written before roles existed as unknown, never as zero', () => {
    // Those peers genuinely had no reported role, so unknown is the honest
    // bucket. Reading them as zero would draw a confident "no desktops, no
    // phones" across every interval recorded before this shipped.
    const older = parseHistoryRow(JSON.stringify({ v: 1, t: 5, r: 60, w: 60_000, ws: 3, wsm: 2.5 }));
    if (older.kind !== 'row') throw new Error('expected a row');
    expect(older.row.waitingSlots).toEqual({ maximum: 3, mean: 2.5 });
    expect(older.row.waitingUnknown).toEqual({ maximum: 3, mean: 2.5 });
    expect(older.row.waitingDesktop).toEqual({ maximum: 0, mean: null });
    expect(older.row.waitingMobile).toEqual({ maximum: 0, mean: null });
  });

  it('keeps an all-zero role split distinguishable from a row that predates roles', () => {
    // The marker key: 'wru' is written even at zero, so a quiet role-aware row
    // does not get its waiting total back-filled into unknown.
    const quiet = parseHistoryRow(serializeHistoryRow(row({ waitingSlots: { maximum: 4, mean: null } })));
    if (quiet.kind !== 'row') throw new Error('expected a row');
    expect(quiet.row.waitingSlots.maximum).toBe(4);
    expect(quiet.row.waitingUnknown).toEqual({ maximum: 0, mean: null });
  });

  it('keeps an aggregated role split intact rather than back-filling it', () => {
    // On an aggregated row every mean is non-null, so the mean keys are written
    // on a !== null guard. Matching the surrounding omit-if-zero style here
    // instead would drop the marker and silently back-fill the split away.
    const merged = aggregateHistoryRows(
      [
        row({ waitingSlots: { maximum: 2, mean: null }, waitingDesktop: { maximum: 2, mean: null } }),
        row({ waitingSlots: { maximum: 3, mean: null }, waitingMobile: { maximum: 3, mean: null } }),
      ],
      1_700_000_100_000,
      MID_RESOLUTION_SECONDS,
    );
    const parsed = parseHistoryRow(serializeHistoryRow(merged));
    if (parsed.kind !== 'row') throw new Error('expected a row');
    expect(parsed.row.waitingDesktop.maximum).toBe(2);
    expect(parsed.row.waitingMobile.maximum).toBe(3);
    // Aggregation takes the max of each series separately, so the role peaks
    // need not sum to the waiting peak. That is why the dashboard draws them as
    // independent lines and never stacks them.
    expect(parsed.row.waitingSlots.maximum).toBe(3);
    expect(parsed.row.waitingUnknown.maximum).toBe(0);
  });

  it('takes the maximum of event loop p99 rather than averaging tail statistics', () => {
    const merged = aggregateHistoryRows(
      [row({ eventLoopLagP99Ms: 2 }), row({ eventLoopLagP99Ms: 55 })],
      1_700_000_100_000,
      MID_RESOLUTION_SECONDS,
    );
    expect(merged.eventLoopLagP99Ms).toBe(55);
  });

  it('returns a single already-aligned row untouched, which is what makes compaction idempotent', () => {
    const aligned = row({ timestampMs: 1_700_000_100_000, resolutionSeconds: MID_RESOLUTION_SECONDS });
    expect(aggregateHistoryRows([aligned], 1_700_000_100_000, MID_RESOLUTION_SECONDS)).toBe(aligned);
  });
});
