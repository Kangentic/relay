import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import type { HistoryRecorder } from '../history/recorder.js';
import {
  COARSE_RETENTION_MS,
  deriveClosedByCause,
  FINE_RETENTION_MS,
  MID_RETENTION_MS,
  type HistoryRow,
} from '../history/rows.js';
import { ADMIN_PAGE_HTML } from './adminPage.js';
import { closedByCauseFromSnapshot, type Metrics } from './metrics.js';

const gzip = promisify(gzipCallback);

/** Below this a gzip round trip costs more than it saves. */
const MINIMUM_GZIP_BYTES = 1_024;
const DEFAULT_RANGE_MS = 6 * 60 * 60 * 1000;

export interface AdminDeps {
  readonly metrics: Metrics;
  readonly recorder: HistoryRecorder | null;
  readonly now?: () => number;
}

/**
 * The dashboard document. Deliberately no-store: it is a private operational
 * surface, and no-referrer keeps the path out of any onward request.
 */
export function handleAdminPageRequest(_request: IncomingMessage, response: ServerResponse): void {
  response
    .writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
    })
    .end(ADMIN_PAGE_HTML);
}

function readPositiveInteger(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Rows carry per-interval deltas, so closedByCause is derived at read time
 * rather than stored: it is a pure projection of fields already in the row, and
 * storing it would both duplicate bytes and let it drift from its own inputs.
 */
function withClosedByCause(row: HistoryRow): Record<string, unknown> {
  return { ...row, closedByCause: deriveClosedByCause(row) };
}

/**
 * The dashboard's only data source. Two modes:
 *
 * - `?since=<epochMs>` is the 5-second poll. When the cursor is inside the
 *   in-memory ring it is answered without touching the disk at all, which is
 *   what keeps an open dashboard nearly free.
 * - `?range=<ms>` is the once-per-page-load read, and the only path that
 *   streams the history file.
 *
 * Carries aggregate counters only: no slot ids, no IPs, no traffic content.
 */
export async function handleAdminDataRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: AdminDeps,
  url: URL,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const { metrics, recorder } = deps;

  const since = readPositiveInteger(url.searchParams.get('since'));
  const requestedRange = readPositiveInteger(url.searchParams.get('range'));
  const rangeMs = Math.min(requestedRange ?? DEFAULT_RANGE_MS, COARSE_RETENTION_MS);

  const read =
    recorder === null
      ? null
      : since === null
        ? await recorder.readRange(rangeMs)
        : await recorder.readSince(since);

  const snapshot = metrics.snapshot();
  const processSample = recorder?.latestProcessSample() ?? null;
  const rows = read?.rows ?? [];
  const newestTimestampMs = rows.reduce((newest, row) => Math.max(newest, row.timestampMs), 0);

  const body = {
    live: {
      activeConnections: snapshot.activeConnections,
      waitingSlots: snapshot.waitingSlots,
      pairedSlots: snapshot.pairedSlots,
      connectionsTotal: snapshot.connectionsTotal,
      sessionsTotal: snapshot.sessionsTotal,
      framesForwardedTotal: snapshot.framesForwardedTotal,
      bytesForwardedTotal: snapshot.bytesForwardedTotal,
      closedByCause: closedByCauseFromSnapshot(snapshot),
      rejectsByReason: snapshot.rejectsByReason,
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: processSample?.rssBytes ?? process.memoryUsage.rss(),
      cpuPercent: processSample?.cpuPercent ?? null,
      eventLoopLagP99Ms: processSample?.eventLoopLagP99Ms ?? null,
      rssPercent: processSample?.rssPercent ?? null,
    },
    rows: rows.map(withClosedByCause),
    // Exclusive, and taken from the returned rows rather than server time, so a
    // row landing between the read and the response is not skipped. Falls back
    // to the incoming cursor when nothing new arrived.
    cursorMs: newestTimestampMs > 0 ? newestTimestampMs : (since ?? 0),
    meta: {
      serverTimeMs: now(),
      servedFrom: read?.servedFrom ?? 'none',
      historyEnabled: recorder !== null,
      historyPersistence: recorder?.persistence() ?? 'memory',
      recorderHealthy: recorder?.healthy() ?? false,
      intervalMs: recorder?.intervalMs() ?? 0,
      ringCapacity: recorder?.ringCapacity() ?? 0,
      truncated: read?.truncated ?? false,
      skippedLineCount: read?.skippedLineCount ?? 0,
      unknownVersionLineCount: read?.unknownVersionLineCount ?? 0,
      retention: { fineMs: FINE_RETENTION_MS, midMs: MID_RETENTION_MS, coarseMs: COARSE_RETENTION_MS },
    },
  };

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const acceptEncoding = request.headers['accept-encoding'];
  const acceptsGzip = typeof acceptEncoding === 'string' && acceptEncoding.includes('gzip');

  if (acceptsGzip && payload.byteLength >= MINIMUM_GZIP_BYTES) {
    const compressed = await gzip(payload);
    response
      .writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'cache-control': 'no-store',
      })
      .end(compressed);
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(payload);
}
