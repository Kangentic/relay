import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../src/http/metrics.js';
import { createLogger, type Logger } from '../src/logging.js';
import { createHistoryRecorder, type HistoryRecorder } from '../src/history/recorder.js';
import type { ProcessSample, ProcessSampler } from '../src/history/processSampler.js';
import { parseHistoryRow, serializeHistoryRow, type HistoryRow } from '../src/history/rows.js';

const INTERVAL_MS = 60_000;
const START_MS = 1_700_000_000_000;

function stubSampler(): ProcessSampler {
  let latest: ProcessSample | null = null;
  return {
    sample: (nowMs) => {
      latest = {
        cpuPercent: 1.5,
        eventLoopLagP99Ms: 2.5,
        rssBytes: 48_000_000,
        rssPercent: 3.8,
        windowMs: INTERVAL_MS,
        sampledAtMs: nowMs,
      };
      return latest;
    },
    latest: () => latest,
    containerMemoryLimitBytes: () => 1_258_291_200,
    stop: () => undefined,
  };
}

function silentLogger(): Logger {
  return { ...createLogger({ logLevel: 'error', logSlotHashing: true, slotLogSalt: 'x' }), warn: () => undefined, error: () => undefined };
}

describe('history recorder', () => {
  let directory: string;
  let historyFilePath: string;
  let currentTimeMs: number;
  let recorder: HistoryRecorder | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    currentTimeMs = START_MS;
    directory = await mkdtemp(join(tmpdir(), 'relay-history-'));
    historyFilePath = join(directory, 'history.ndjson');
  });

  afterEach(async () => {
    await recorder?.stop();
    recorder = undefined;
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  function build(overrides: Partial<Parameters<typeof createHistoryRecorder>[0]> = {}): HistoryRecorder {
    return createHistoryRecorder({
      metrics: createMetrics(),
      logger: silentLogger(),
      historyFilePath,
      intervalMs: INTERVAL_MS,
      compactionIntervalMs: 60 * 60 * 1000,
      now: () => currentTimeMs,
      processSampler: stubSampler(),
      ...overrides,
    });
  }

  async function tick(times = 1): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      currentTimeMs += INTERVAL_MS;
      // Async advance: the sync variant does not drain the microtask queue, so
      // the tick callback would not even run. draining then waits for the real
      // filesystem work the tick enqueued, which no amount of timer advancing
      // can flush.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      await recorder?.drain();
    }
  }

  async function readRows(): Promise<HistoryRow[]> {
    const text = await readFile(historyFilePath, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(parseHistoryRow)
      .flatMap((parsed) => (parsed.kind === 'row' ? [parsed.row] : []));
  }

  it('takes its counter baseline at construction, so a pre-warmed Metrics is not a spike', async () => {
    // createRelay accepts an injected Metrics, which may already be warm. A
    // first-tick baseline would dump its entire accumulated history into one
    // interval, which is exactly the fake spike deltas exist to prevent.
    const metrics = createMetrics();
    for (let index = 0; index < 500; index += 1) metrics.onForward(1_000);

    recorder = build({ metrics });
    await tick();

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.framesForwardedDelta).toBe(0);
    expect(rows[0]?.bytesForwardedDelta).toBe(0);
  });

  it('marks the first row of a process as a restart boundary', async () => {
    recorder = build();
    await tick(2);
    const rows = await readRows();
    expect(rows[0]?.restartCount).toBe(1);
    expect(rows[1]?.restartCount).toBe(0);
  });

  it('records activity that happens between ticks as a per-interval delta', async () => {
    const metrics = createMetrics();
    recorder = build({ metrics });
    await tick();
    metrics.onForward(2_048);
    metrics.onForward(2_048);
    await tick();

    const rows = await readRows();
    expect(rows[1]?.framesForwardedDelta).toBe(2);
    expect(rows[1]?.bytesForwardedDelta).toBe(4_096);
  });

  it('serves a cursor inside the ring without touching the disk', async () => {
    recorder = build();
    await tick(3);
    // Deleting the file proves the read never reached it.
    await rm(historyFilePath, { force: true });

    // The cursor must be at or after the ring's oldest row: only then can the
    // ring prove it holds everything newer.
    const result = await recorder.readSince(START_MS + INTERVAL_MS);
    expect(result.servedFrom).toBe('ring');
    expect(result.rows).toHaveLength(2);
  });

  it('treats the cursor as exclusive, so the ring and disk cannot double-count a row', async () => {
    recorder = build();
    await tick(3);
    const all = await recorder.readSince(0);
    const boundary = all.rows[0];
    if (boundary === undefined) throw new Error('expected rows');

    const after = await recorder.readSince(boundary.timestampMs);
    expect(after.rows.map((row) => row.timestampMs)).not.toContain(boundary.timestampMs);
    expect(after.rows).toHaveLength(2);
  });

  it('falls back to the file when the cursor predates the oldest ring row', async () => {
    recorder = build({ ringCapacity: 2 });
    await tick(4);
    const result = await recorder.readSince(START_MS);
    // The ring only holds 2 of the 4 rows, so this has to come off disk.
    expect(result.servedFrom).toBe('file');
    expect(result.rows).toHaveLength(4);
  });

  it('bounds the ring, so an always-on recorder cannot grow without limit', async () => {
    recorder = build({ ringCapacity: 3 });
    await tick(10);

    // Rows 8, 9 and 10 are in the ring, so a cursor at row 8 is ring-served.
    const inRing = await recorder.readSince(START_MS + 8 * INTERVAL_MS);
    expect(inRing.servedFrom).toBe('ring');
    expect(inRing.rows).toHaveLength(2);

    // Row 7 has aged out, so the same query one interval earlier must go to disk.
    const evicted = await recorder.readSince(START_MS + 7 * INTERVAL_MS);
    expect(evicted.servedFrom).toBe('file');
    expect(evicted.rows).toHaveLength(3);
  });

  it('keeps the newest rows fine-grained and folds older ones into coarser buckets', async () => {
    // Rows spaced a minute apart across 40 days, so all three tiers are exercised.
    const seeded: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      const ageMs = index * 4 * 60 * 60 * 1000;
      seeded.push(
        serializeHistoryRow({
          schemaVersion: 1,
          timestampMs: START_MS - ageMs,
          resolutionSeconds: 60,
          windowMs: INTERVAL_MS,
          instanceId: 'seed0001',
          uptimeSeconds: 60,
          restartCount: 0,
          sourceRowCount: 1,
          connectionsDelta: 1,
          sessionsDelta: 0,
          framesForwardedDelta: 10,
          bytesForwardedDelta: 100,
          peerClosedDelta: 0,
          pongTimeoutsDelta: 0,
          rejectsByReasonDelta: {},
          activeConnections: { maximum: 2, mean: null },
          waitingSlots: { maximum: 0, mean: null },
          pairedSlots: { maximum: 1, mean: null },
          cpuPercent: { maximum: 1, mean: null },
          eventLoopLagP99Ms: 1,
          rssBytes: 1_000,
          rssPercent: 1,
          maxOutboundBufferBytes: null,
          backloggedConnections: null,
          maxParkedBufferBytes: null,
        }),
      );
    }
    await writeFile(historyFilePath, `${seeded.join('\n')}\n`, 'utf8');

    recorder = build({ compactionIntervalMs: 1 });
    await tick();

    const rows = await readRows();
    const byResolution = new Set(rows.map((row) => row.resolutionSeconds));
    expect(byResolution.has(300)).toBe(true);
    expect(byResolution.has(3600)).toBe(true);
    // Total frames must be conserved: aggregation sums, it does not sample.
    const totalFrames = rows.reduce((sum, row) => sum + row.framesForwardedDelta, 0);
    expect(totalFrames).toBe(400 * 10);
  });

  it('is idempotent: compacting again leaves already-aggregated rows unchanged', async () => {
    const seeded: string[] = [];
    for (let index = 1; index <= 200; index += 1) {
      seeded.push(
        serializeHistoryRow({
          schemaVersion: 1,
          timestampMs: START_MS - index * 3 * 60 * 60 * 1000,
          resolutionSeconds: 60,
          windowMs: INTERVAL_MS,
          instanceId: 'seed0001',
          uptimeSeconds: 60,
          restartCount: 0,
          sourceRowCount: 1,
          connectionsDelta: 1,
          sessionsDelta: 0,
          framesForwardedDelta: 7,
          bytesForwardedDelta: 70,
          peerClosedDelta: 0,
          pongTimeoutsDelta: 0,
          rejectsByReasonDelta: {},
          activeConnections: { maximum: 3, mean: null },
          waitingSlots: { maximum: 0, mean: null },
          pairedSlots: { maximum: 1, mean: null },
          cpuPercent: { maximum: 1, mean: null },
          eventLoopLagP99Ms: 1,
          rssBytes: 1_000,
          rssPercent: 1,
          maxOutboundBufferBytes: null,
          backloggedConnections: null,
          maxParkedBufferBytes: null,
        }),
      );
    }
    await writeFile(historyFilePath, `${seeded.join('\n')}\n`, 'utf8');

    recorder = build({ compactionIntervalMs: 1 });
    await tick();
    const afterFirst = (await readRows()).filter((row) => row.timestampMs < START_MS);
    await tick();
    const afterSecond = (await readRows()).filter((row) => row.timestampMs < START_MS);

    // Epoch-aligned bucketing means a second pass is a no-op on rows that were
    // already aggregated. Age-relative bucketing would drift and double count.
    expect(afterSecond).toEqual(afterFirst);
  });

  it('carries a future schema version through compaction verbatim, so a version bump cannot eat a year of history', async () => {
    // The whole point of versioning the rows: an older binary rolled back onto
    // a volume a newer one has written must not treat those rows as corrupt
    // and compact them away. Compaction rewrites the entire file, so this is
    // the one operation that could destroy them.
    const futureLine = JSON.stringify({ v: 2, t: START_MS - 60_000, r: 60, f: 99, fieldAddedLater: 'kept' });
    await writeFile(historyFilePath, `${futureLine}\n`, 'utf8');

    recorder = build({ compactionIntervalMs: 1 });
    await tick();

    const lines = (await readFile(historyFilePath, 'utf8')).split('\n').filter((line) => line.trim() !== '');
    expect(lines).toContain(futureLine);
    // The unknown line plus the row this recorder just sampled, and nothing
    // silently dropped between them.
    expect(lines).toHaveLength(2);

    const result = await recorder.readRange(24 * 60 * 60 * 1000);
    expect(result.unknownVersionLineCount).toBe(1);
    expect(result.skippedLineCount).toBe(0);
  });

  it('skips malformed lines and reports how many, instead of failing the read', async () => {
    await writeFile(historyFilePath, 'not json\n{"v":1,"t":"bad","r":60}\n', 'utf8');
    recorder = build();
    await tick();

    const result = await recorder.readRange(60 * 60 * 1000);
    expect(result.skippedLineCount).toBe(2);
    expect(result.rows).toHaveLength(1);
  });

  it('keeps serving from memory when the file cannot be written', async () => {
    // A missing directory is not self-healing, so the file half disables
    // immediately rather than retrying forever.
    recorder = build({ historyFilePath: join(directory, 'absent', 'history.ndjson') });
    await tick(2);

    expect(recorder.healthy()).toBe(false);
    expect(recorder.persistence()).toBe('memory');
    // The ring is the designed fallback: the dashboard still works.
    const result = await recorder.readSince(0);
    expect(result.rows).toHaveLength(2);
  });

  it('escalates to an error once compaction has failed repeatedly', async () => {
    // Appends keep succeeding while renames fail, and the row ceiling is only
    // enforced inside a SUCCESSFUL compaction, so a stuck rename grows the file
    // forever. Nothing here can break a foreign file lock, so the escalation is
    // loudness: this must not stay a warn that scrolls past.
    const lines: { level: string; message: string }[] = [];
    const recordingLogger: Logger = {
      error: (message) => lines.push({ level: 'error', message }),
      warn: (message) => lines.push({ level: 'warn', message }),
      info: () => undefined,
      debug: () => undefined,
      slotRef: (slotId: string) => slotId,
    };
    await mkdir(`${historyFilePath}.tmp`, { recursive: true });

    recorder = build({ compactionIntervalMs: 1, logger: recordingLogger });
    await tick(3);

    expect(lines.filter((line) => line.level === 'warn').length).toBeGreaterThan(0);
    const escalated = lines.find((line) => line.level === 'error' && line.message.includes('unbounded'));
    expect(escalated).toBeDefined();
  });

  it('does not poison the queue: appends keep landing after a compaction failure', async () => {
    // A directory where the temp file belongs makes every compaction fail. If
    // one rejection could poison the shared queue, every later append would
    // silently short-circuit and the file would stop growing.
    await mkdir(`${historyFilePath}.tmp`, { recursive: true });

    recorder = build({ compactionIntervalMs: 1 });
    await tick(3);

    const rows = await readRows();
    expect(rows).toHaveLength(3);
    // Compaction failing is not a reason to stop recording.
    expect(recorder.healthy()).toBe(true);
  });

  it('opens no file at all when no path is configured', async () => {
    recorder = build({ historyFilePath: null });
    await tick(2);

    expect(existsSync(historyFilePath)).toBe(false);
    expect(recorder.persistence()).toBe('memory');
    const result = await recorder.readSince(0);
    expect(result.rows).toHaveLength(2);
  });

  it('clears a temp file left behind by a crashed compaction', async () => {
    const temporaryPath = `${historyFilePath}.tmp`;
    await writeFile(temporaryPath, 'half written\n', 'utf8');
    recorder = build();
    await tick();
    expect(existsSync(temporaryPath)).toBe(false);
  });

  it('flushes a final partial row on stop, so a deploy has no blind spot', async () => {
    const metrics = createMetrics();
    recorder = build({ metrics });
    await tick();
    metrics.onForward(512);
    currentTimeMs += 15_000;

    await recorder.stop();
    recorder = undefined;

    const rows = await readRows();
    expect(rows).toHaveLength(2);
    // windowMs already says the row covers a short span, so no extra flag is needed.
    expect(rows[1]?.windowMs).toBe(15_000);
    expect(rows[1]?.framesForwardedDelta).toBe(1);
  });

  it('never writes an out-of-order timestamp when the clock steps backward', async () => {
    recorder = build();
    await tick();
    // NTP correction: now() jumps back an hour.
    currentTimeMs -= 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await recorder.drain();

    const rows = await readRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.timestampMs).toBeGreaterThan(rows[0]!.timestampMs);
  });
});
