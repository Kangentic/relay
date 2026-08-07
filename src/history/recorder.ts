import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, open, rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Logger } from '../logging.js';
import type { Metrics, MetricsSnapshot } from '../http/metrics.js';
import { createProcessSampler, type ProcessSample, type ProcessSampler } from './processSampler.js';
import {
  aggregateHistoryRows,
  bucketStartMs,
  buildHistoryRow,
  COARSE_RETENTION_MS,
  effectiveResolutionSeconds,
  MAX_HISTORY_ROW_COUNT,
  parseHistoryRow,
  serializeHistoryRow,
  type HistoryRow,
} from './rows.js';

const DEFAULT_COMPACTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RING_CAPACITY = 120;
/**
 * Matched to MAX_HISTORY_ROW_COUNT, because a widest-range read spans all three
 * tiers at once, not just the hourly one: roughly 2880 fine plus 8000 mid plus
 * 8000 coarse. A smaller cap here would silently drop the oldest half of a
 * "1 year" request after about a month of uptime, which is ordinary rather than
 * pathological. A range read is a rare operator action, not a poll, so the
 * larger bounded payload is the right trade.
 */
const MAX_RESPONSE_ROW_COUNT = MAX_HISTORY_ROW_COUNT;
/** Consecutive failed compactions before the log moves from warn to error. */
const COMPACTION_FAILURES_BEFORE_ESCALATION = 3;
const SHUTDOWN_FLUSH_TIMEOUT_MS = 1_000;
const CONSECUTIVE_FAILURES_BEFORE_DISABLE = 5;

/**
 * Errors that will not heal on their own: a read-only mount or a missing
 * directory stays broken until an operator intervenes, so retrying every
 * minute forever only produces noise.
 */
const FATAL_APPEND_ERROR_CODES: ReadonlySet<string> = new Set([
  'EROFS',
  'EACCES',
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
]);

export interface HistoryRecorderDeps {
  readonly metrics: Metrics;
  readonly logger: Logger;
  /** Null keeps the recorder memory-only: ring served, no file ever opened. */
  readonly historyFilePath: string | null;
  readonly intervalMs: number;
  readonly compactionIntervalMs?: number;
  readonly ringCapacity?: number;
  readonly now?: () => number;
  readonly processSampler?: ProcessSampler;
}

export interface HistoryReadResult {
  readonly rows: readonly HistoryRow[];
  readonly servedFrom: 'ring' | 'file' | 'none';
  readonly skippedLineCount: number;
  readonly unknownVersionLineCount: number;
  readonly truncated: boolean;
}

export interface HistoryRecorder {
  /** The last sampled process values. Never disturbs the sampling window. */
  latestProcessSample(): ProcessSample | null;
  /** False once the file half has been disabled by repeated failures. */
  healthy(): boolean;
  persistence(): 'memory' | 'file';
  /** How many recent rows the in-memory ring holds, for the dashboard to explain itself. */
  ringCapacity(): number;
  intervalMs(): number;
  /** Resolves once every currently-queued file operation has settled. */
  drain(): Promise<void>;
  readSince(sinceMs: number): Promise<HistoryReadResult>;
  readRange(rangeMs: number): Promise<HistoryReadResult>;
  /** Idempotent: stops timers, flushes a final partial row, drains the queue. */
  stop(): Promise<void>;
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const EMPTY_READ_RESULT: HistoryReadResult = {
  rows: [],
  servedFrom: 'none',
  skippedLineCount: 0,
  unknownVersionLineCount: 0,
  truncated: false,
};

/**
 * Samples aggregate metrics on a timer and appends them as NDJSON, so relay
 * history survives the process restart that zeroes every counter.
 *
 * The cost when running is one snapshot plus one append per interval. The hot
 * forwarding path is untouched: nothing here runs per frame.
 */
export function createHistoryRecorder(deps: HistoryRecorderDeps): HistoryRecorder {
  const now = deps.now ?? Date.now;
  const { logger, metrics, historyFilePath } = deps;
  const compactionIntervalMs = deps.compactionIntervalMs ?? DEFAULT_COMPACTION_INTERVAL_MS;
  const ringCapacity = deps.ringCapacity ?? DEFAULT_RING_CAPACITY;
  const processSampler = deps.processSampler ?? createProcessSampler({ now });

  const instanceId = randomBytes(4).toString('hex');
  const temporaryFilePath = historyFilePath === null ? null : `${historyFilePath}.tmp`;

  const ring: HistoryRow[] = [];
  let stopped = false;
  let fileHalfDisabled = historyFilePath === null;
  let consecutiveFailureCount = 0;
  let lastFailureLoggedAtMs = 0;
  let consecutiveCompactionFailureCount = 0;

  // Baseline taken at CONSTRUCTION, not on the first tick. createRelay accepts
  // an injected Metrics (deps.metrics), which may already be warm, and a
  // first-tick baseline would attribute its entire accumulated history to one
  // interval - exactly the giant fake spike the delta scheme exists to stop.
  let previousSnapshot: MetricsSnapshot = metrics.snapshot();
  let previousTimestampMs = now();
  let isFirstRow = true;
  let lastCompactionAtMs = now();

  let fileOperationQueue: Promise<void> = Promise.resolve();

  /**
   * Serializes every file operation, including reads. Two reasons reads must
   * queue too: on Windows a concurrent open makes compaction's rename fail
   * with EPERM, and on any platform a read racing a rename can observe a
   * half-written file. In-process only; this is not a cross-process lock, and
   * two relays pointed at one volume are not made safe by it.
   */
  function enqueueFileOperation<T>(operation: () => Promise<T>, fallbackValue: T): Promise<T> {
    const operationResult = fileOperationQueue.then(operation);
    // Both arms resolve, so one rejection cannot poison the chain and silently
    // short-circuit every operation that follows.
    fileOperationQueue = operationResult.then(
      () => undefined,
      () => undefined,
    );
    return operationResult.catch(() => fallbackValue);
  }

  function recordAppendFailure(error: unknown): void {
    consecutiveFailureCount += 1;
    const code = errorCodeOf(error);
    const isFatal = FATAL_APPEND_ERROR_CODES.has(code);

    if (isFatal || consecutiveFailureCount >= CONSECUTIVE_FAILURES_BEFORE_DISABLE) {
      fileHalfDisabled = true;
      logger.error('metrics history disabled after write failure', {
        code,
        error: errorMessageOf(error),
        consecutiveFailureCount,
      });
      return;
    }
    // Suppress repeats so a persistently full disk cannot flood the log.
    const nowMs = now();
    if (nowMs - lastFailureLoggedAtMs >= DEFAULT_COMPACTION_INTERVAL_MS || consecutiveFailureCount === 1) {
      lastFailureLoggedAtMs = nowMs;
      logger.warn('metrics history write failed', { code, error: errorMessageOf(error) });
    }
  }

  async function appendRow(row: HistoryRow): Promise<void> {
    if (historyFilePath === null) return;
    try {
      // The line and its newline go in ONE call: two would let a concurrent
      // writer interleave mid-line. No fsync - the OS flush is enough here.
      await appendFile(historyFilePath, `${serializeHistoryRow(row)}\n`, 'utf8');
      consecutiveFailureCount = 0;
    } catch (error: unknown) {
      recordAppendFailure(error);
    }
  }

  async function streamRows(
    filePath: string,
    onRow: (row: HistoryRow) => void,
    onUnknownVersion?: (rawLine: string) => void,
  ): Promise<{ skippedLineCount: number; unknownVersionLineCount: number }> {
    let skippedLineCount = 0;
    let unknownVersionLineCount = 0;
    // Held separately: readline.close() releases the interface but not the file
    // descriptor underneath it, so an early exit would leak one per read.
    const input = createReadStream(filePath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === '') continue;
        const parsed = parseHistoryRow(line);
        if (parsed.kind === 'malformed') {
          // Includes a truncated final line from a crash mid-append. That line
          // is unrecoverable, and compaction drops it permanently.
          skippedLineCount += 1;
          continue;
        }
        if (parsed.kind === 'unknownVersion') {
          unknownVersionLineCount += 1;
          onUnknownVersion?.(parsed.rawLine);
          continue;
        }
        onRow(parsed.row);
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return { skippedLineCount, unknownVersionLineCount };
  }

  /**
   * Rewrites the file at tiered resolution. Streams in, aggregates into one
   * accumulator per bucket, and streams out through a temp file so a crash
   * mid-write cannot destroy the original.
   */
  async function compactHistoryFile(): Promise<void> {
    if (historyFilePath === null || temporaryFilePath === null) return;
    const nowMs = now();
    const buckets = new Map<string, HistoryRow>();
    const unknownVersionLines: string[] = [];

    try {
      await streamRows(
        historyFilePath,
        (row) => {
          const ageMs = nowMs - row.timestampMs;
          if (ageMs > COARSE_RETENTION_MS) return;
          const resolutionSeconds = effectiveResolutionSeconds(row, ageMs);
          const startMs = bucketStartMs(row.timestampMs, resolutionSeconds);
          const key = `${resolutionSeconds}:${startMs}`;
          const existing = buckets.get(key);
          // Aggregating incrementally keeps one row per bucket in memory
          // instead of every raw row. Sum, max, and the window-weighted mean
          // are all associative, so this equals aggregating the bucket at once.
          buckets.set(
            key,
            existing === undefined
              ? aggregateHistoryRows([row], startMs, resolutionSeconds)
              : aggregateHistoryRows([existing, row], startMs, resolutionSeconds),
          );
        },
        (rawLine) => unknownVersionLines.push(rawLine),
      );
    } catch (error: unknown) {
      if (errorCodeOf(error) === 'ENOENT') return;
      throw error;
    }

    let rows = [...buckets.values()].sort((left, right) => left.timestampMs - right.timestampMs);
    if (rows.length > MAX_HISTORY_ROW_COUNT) {
      const dropped = rows.length - MAX_HISTORY_ROW_COUNT;
      rows = rows.slice(dropped);
      logger.warn('metrics history row ceiling reached, dropped oldest rows', { dropped });
    }

    // Unknown-version lines are copied through verbatim and written first, so
    // a future schema change never destroys a year of history.
    const body = [...unknownVersionLines, ...rows.map(serializeHistoryRow)].join('\n');
    const handle = await open(temporaryFilePath, 'w');
    try {
      await handle.writeFile(body.length === 0 ? '' : `${body}\n`, 'utf8');
      // The one place fsync earns its cost: without it a crash between write
      // and rename can leave a renamed-but-empty file, losing the whole year
      // rather than just the tail.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryFilePath, historyFilePath);
  }

  function scheduleCompaction(): void {
    if (historyFilePath === null || fileHalfDisabled) return;
    if (now() - lastCompactionAtMs < compactionIntervalMs) return;
    lastCompactionAtMs = now();
    void enqueueFileOperation(async () => {
      try {
        await compactHistoryFile();
        consecutiveCompactionFailureCount = 0;
      } catch (error: unknown) {
        // A failed compaction is not fatal: the original file is untouched by
        // the temp-then-rename ordering, so the next attempt retries. On
        // Windows a rename over a file another handle has open fails EPERM,
        // which is exactly this case.
        //
        // But appends keep succeeding while renames fail (appending needs no
        // exclusive access), and the row ceiling is only enforced INSIDE a
        // successful compaction. So a persistently stuck rename, say an
        // antivirus or backup agent holding a read handle, grows the file at
        // fine resolution forever. Nothing in this process can break that lock,
        // so the escalation is loudness: after a few consecutive failures this
        // stops being a transient warning and becomes an error an operator is
        // meant to act on.
        consecutiveCompactionFailureCount += 1;
        const details = {
          code: errorCodeOf(error),
          error: errorMessageOf(error),
          consecutiveCompactionFailureCount,
        };
        if (consecutiveCompactionFailureCount >= COMPACTION_FAILURES_BEFORE_ESCALATION) {
          logger.error('metrics history compaction failing repeatedly, file will grow unbounded', details);
        } else {
          logger.warn('metrics history compaction failed', details);
        }
      }
    }, undefined);
  }

  function recordSample(): void {
    const rawNowMs = now();
    // Date.now() steps backward on NTP correction, and the compactor treats
    // this file as time-sorted.
    const timestampMs = Math.max(previousTimestampMs + 1, rawNowMs);
    const windowMs = Math.max(1, timestampMs - previousTimestampMs);
    const currentSnapshot = metrics.snapshot();
    const processSample = processSampler.sample(timestampMs);

    const row = buildHistoryRow({
      timestampMs,
      windowMs,
      instanceId,
      uptimeSeconds: Math.round(process.uptime()),
      isRestartBoundary: isFirstRow,
      previousSnapshot,
      currentSnapshot,
      processSample,
    });

    previousSnapshot = currentSnapshot;
    previousTimestampMs = timestampMs;
    isFirstRow = false;

    // Pushed unconditionally, so the ring keeps serving the dashboard even
    // after the file half has been disabled. That is a designed fallback.
    ring.push(row);
    if (ring.length > ringCapacity) ring.shift();

    if (!fileHalfDisabled) void enqueueFileOperation(() => appendRow(row), undefined);
  }

  // The callback is synchronous and guarded. An async setInterval callback that
  // throws becomes an unhandled rejection, which terminates the process under
  // Node's default - a metrics recorder must never be able to kill the relay.
  const historyTimer = setInterval(() => {
    try {
      recordSample();
      scheduleCompaction();
    } catch (error: unknown) {
      logger.warn('metrics history sample failed', { error: errorMessageOf(error) });
    }
  }, deps.intervalMs);
  historyTimer.unref?.();

  // A crashed compaction leaves a temp file behind; drop it before the first
  // rename tries to replace it.
  if (temporaryFilePath !== null) {
    void enqueueFileOperation(() => rm(temporaryFilePath, { force: true }), undefined);
  }

  function rowsFromRing(predicate: (row: HistoryRow) => boolean): HistoryRow[] {
    return ring.filter(predicate);
  }

  async function readFromFile(predicate: (row: HistoryRow) => boolean): Promise<HistoryReadResult> {
    if (historyFilePath === null) return EMPTY_READ_RESULT;
    const collected: HistoryRow[] = [];
    let counts = { skippedLineCount: 0, unknownVersionLineCount: 0 };
    try {
      counts = await streamRows(historyFilePath, (row) => {
        if (predicate(row)) collected.push(row);
      });
    } catch (error: unknown) {
      if (errorCodeOf(error) !== 'ENOENT') throw error;
    }
    collected.sort((left, right) => left.timestampMs - right.timestampMs);
    const truncated = collected.length > MAX_RESPONSE_ROW_COUNT;
    return {
      rows: truncated ? collected.slice(collected.length - MAX_RESPONSE_ROW_COUNT) : collected,
      servedFrom: 'file',
      skippedLineCount: counts.skippedLineCount,
      unknownVersionLineCount: counts.unknownVersionLineCount,
      truncated,
    };
  }

  return {
    latestProcessSample: () => processSampler.latest(),
    healthy: () => historyFilePath === null || !fileHalfDisabled,
    persistence: () => (historyFilePath === null || fileHalfDisabled ? 'memory' : 'file'),
    ringCapacity: () => ringCapacity,
    intervalMs: () => deps.intervalMs,
    drain: () => fileOperationQueue,

    readSince: async (sinceMs) => {
      // Compared against the ring's OLDEST ROW, not a computed window. The ring
      // holds a contiguous suffix of this process's series, so if its oldest
      // row predates the cursor then every row after the cursor is in it. A
      // computed window diverges from that whenever ticks were missed, and the
      // difference is exactly a silently dropped range.
      const oldest = ring[0];
      if (oldest !== undefined && oldest.timestampMs <= sinceMs) {
        // Cursor is exclusive, so a client switching from a disk read to ring
        // polling cannot double-count the boundary row.
        return { ...EMPTY_READ_RESULT, rows: rowsFromRing((row) => row.timestampMs > sinceMs), servedFrom: 'ring' };
      }
      if (historyFilePath === null || fileHalfDisabled) {
        return { ...EMPTY_READ_RESULT, rows: rowsFromRing((row) => row.timestampMs > sinceMs), servedFrom: 'ring' };
      }
      return enqueueFileOperation(() => readFromFile((row) => row.timestampMs > sinceMs), EMPTY_READ_RESULT);
    },

    readRange: async (rangeMs) => {
      const oldestAllowedMs = now() - rangeMs;
      if (historyFilePath === null || fileHalfDisabled) {
        return {
          ...EMPTY_READ_RESULT,
          rows: rowsFromRing((row) => row.timestampMs >= oldestAllowedMs),
          servedFrom: 'ring',
        };
      }
      return enqueueFileOperation(
        () => readFromFile((row) => row.timestampMs >= oldestAllowedMs),
        EMPTY_READ_RESULT,
      );
    },

    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(historyTimer);

      // A deploy is exactly when this data matters most, so the trailing
      // partial interval is flushed rather than dropped. windowMs already says
      // the row covers a short span, so no extra flag is needed.
      try {
        recordSample();
      } catch (error: unknown) {
        logger.warn('metrics history final flush failed', { error: errorMessageOf(error) });
      }
      processSampler.stop();

      // Raced against a timeout so a hung filesystem cannot stall shutdown
      // past shutdownGraceMs.
      await Promise.race([
        fileOperationQueue,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    },
  };
}
