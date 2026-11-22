import { connect as connectTcp } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import type { AdmissionDecision, AdmissionPolicy } from '../src/admission.js';
import { CLOSE_CODE } from '../src/closeCodes.js';
import {
  createDialLog,
  describeDialClose,
  describeDialRejection,
  markDialOpened,
  resolveClientDialId,
  startDialCorrelation,
} from '../src/dialCorrelation.js';
import { createMetrics } from '../src/http/metrics.js';
import type { Logger } from '../src/logging.js';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { createSlotTableHarness, READY_STATE } from './helpers/slotTableHarness.js';

const SLOT = 'a'.repeat(64);
const OTHER_SLOT = 'b'.repeat(64);
const SHORT_SLOT = 'c'.repeat(32);
const DESKTOP_DIAL_ID = '0123456789abcdef';
const PHONE_DIAL_ID = 'fedcba9876543210';
const VALID_CF_RAY = '8c1f2e3d4b5a6978-ATL';

interface CapturedLine {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

function capturingLogger(lines: CapturedLine[]): Logger {
  const capture = (message: string, fields?: Record<string, unknown>): void => {
    lines.push({ message, fields: fields ?? {} });
  };
  return { error: capture, warn: capture, info: capture, debug: capture, slotRef: (slotId) => slotId };
}

function linesWithMessage(lines: readonly CapturedLine[], message: string): CapturedLine[] {
  return lines.filter((line) => line.message === message);
}

function dialLines(lines: readonly CapturedLine[]): CapturedLine[] {
  return lines.filter((line) => line.message === 'dial rejected' || line.message === 'dial closed');
}

function dialQuery(slot: string, dialId?: string): string {
  return `/?slot=${slot}${dialId === undefined ? '' : `&dial=${encodeURIComponent(dialId)}`}`;
}

type UpgradeOutcome =
  | { readonly opened: true; readonly socket: NodeWebSocket }
  | { readonly opened: false; readonly status: number };

/**
 * Attempts an upgrade and reports whether it opened (handing back the open
 * socket) or which HTTP status refused it, the same way upgradeGuards.test.ts
 * observes the guard ladder from the wire.
 */
function attemptUpgrade(relayUrl: string, query: string, headers: Record<string, string> = {}): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    const socket = new NodeWebSocket(`${relayUrl}${query}`, { headers });
    let settled = false;
    socket.once('open', () => {
      settled = true;
      resolve({ opened: true, socket });
    });
    socket.once('unexpected-response', (_request, response) => {
      settled = true;
      socket.terminate();
      response.resume();
      resolve({ opened: false, status: response.statusCode ?? 0 });
    });
    socket.on('error', (error: Error) => {
      if (!settled) reject(error);
    });
  });
}

async function openClient(relayUrl: string, query: string, headers: Record<string, string> = {}): Promise<NodeWebSocket> {
  const outcome = await attemptUpgrade(relayUrl, query, headers);
  if (!outcome.opened) throw new Error(`upgrade refused with HTTP ${outcome.status}`);
  return outcome.socket;
}

/** A raw upgrade with no Sec-WebSocket-Key, which ws refuses without invoking its callback. */
function attemptAbortedUpgrade(port: number, query: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1', () => {
      socket.write(
        `GET ${query} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });
    socket.once('error', reject);
    socket.once('close', () => resolve());
    socket.once('data', () => socket.destroy());
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function onlyLine(lines: readonly CapturedLine[], message: string): Record<string, unknown> {
  const matching = linesWithMessage(lines, message);
  expect(matching).toHaveLength(1);
  const [line] = matching;
  if (line === undefined) throw new Error(`expected one '${message}' line`);
  return line.fields;
}

/** The privacy contract, checked on the serialized line: the slot's value and the client's IP never appear. */
function expectNoSlotOrIp(fields: Record<string, unknown>): void {
  const serialized = JSON.stringify(fields);
  for (const slot of [SLOT, OTHER_SLOT, SHORT_SLOT]) expect(serialized).not.toContain(slot);
  expect(serialized).not.toContain('127.0.0.1');
}

describe('resolveClientDialId', () => {
  it('returns a valid id', () => {
    expect(resolveClientDialId(DESKTOP_DIAL_ID, SLOT)).toBe(DESKTOP_DIAL_ID);
  });

  it('returns null for anything the parser refuses', () => {
    expect(resolveClientDialId(null, SLOT)).toBeNull();
    expect(resolveClientDialId('not-a-dial-id', SLOT)).toBeNull();
  });

  it('drops an id that appears inside the slot, so a truncated slot never reaches a log line', () => {
    const slot = `${DESKTOP_DIAL_ID}${'9'.repeat(48)}`;
    expect(resolveClientDialId(slot.slice(0, 16), slot)).toBeNull();
    expect(resolveClientDialId(slot.slice(10, 26), slot)).toBeNull();
    expect(resolveClientDialId(slot.slice(-16), slot)).toBeNull();
  });
});

describe('the dial lines', () => {
  it('answer a rejection with whichever of status or close code applies, never both', () => {
    const dial = startDialCorrelation(DESKTOP_DIAL_ID, VALID_CF_RAY);
    const refused = describeDialRejection(dial, 'desktop', 'rate_limit_ip', { httpStatus: 429 });
    expect(refused).toMatchObject({ clientDialId: DESKTOP_DIAL_ID, cfRay: VALID_CF_RAY, role: 'desktop', httpStatus: 429, closeCode: null });
    expect(refused.rejectedAfterMs).toBeGreaterThanOrEqual(0);
    expect(refused.upgradeReceivedAt).toBe(new Date(dial.upgradeReceivedAtEpochMs).toISOString());

    const denied = describeDialRejection(dial, 'mobile', 'admission', { closeCode: CLOSE_CODE.ADMISSION_DENIED });
    expect(denied).toMatchObject({ httpStatus: null, closeCode: CLOSE_CODE.ADMISSION_DENIED });

    const aborted = describeDialRejection(dial, 'unknown', 'handshake_aborted', null);
    expect(aborted).toMatchObject({ httpStatus: null, closeCode: null });
  });

  it('drop a forged CF-Ray rather than copying a client-controlled header into the line', () => {
    const dial = startDialCorrelation(DESKTOP_DIAL_ID, '8c1f2e3d4b5a6978-ATL\n{"level":"error"}');
    expect(describeDialRejection(dial, 'unknown', 'rate_limit_ip', { httpStatus: 429 }).cfRay).toBeNull();
  });

  it('stamp the 101 once, and a close line reads it back', () => {
    const dial = startDialCorrelation(DESKTOP_DIAL_ID, undefined);
    expect(dial.openedAfterMs).toBeNull();
    markDialOpened(dial);
    const opened = dial.openedAfterMs;
    expect(opened).toEqual(expect.any(Number));
    markDialOpened(dial);
    expect(dial.openedAfterMs).toBe(opened);

    const { conn } = createSlotTableHarness().connect(SLOT);
    const closeLine = describeDialClose(conn, dial, 1006);
    expect(closeLine).toMatchObject({ clientDialId: DESKTOP_DIAL_ID, connId: conn.id, openedAfterMs: opened, paired: false, closeCode: 1006, teardownCause: null });
    expect(closeLine.closedAfterMs).toBeGreaterThanOrEqual(opened ?? 0);
  });
});

describe('the dial line ceiling', () => {
  it('builds no writer at all at 0, so nothing is parsed or budgeted', () => {
    expect(createDialLog({ logger: capturingLogger([]), metrics: createMetrics(), maxLinesPerMinute: 0 })).toBeNull();
  });

  it('drops and counts a line over a minute of budget, then refills with time', () => {
    let nowMs = 1_000_000;
    const lines: CapturedLine[] = [];
    const metrics = createMetrics();
    const dialLog = createDialLog({ logger: capturingLogger(lines), metrics, maxLinesPerMinute: 2, now: () => nowMs });
    if (dialLog === null) throw new Error('expected a dial log');
    const dial = startDialCorrelation(DESKTOP_DIAL_ID, undefined);

    for (let attempt = 0; attempt < 3; attempt += 1) dialLog.rejected(dial, 'desktop', 'rate_limit_ip', { httpStatus: 429 });
    expect(linesWithMessage(lines, 'dial rejected')).toHaveLength(2);
    expect(metrics.snapshot().dialLogSuppressedTotal).toBe(1);

    // Half a minute refills half of a two-line budget: one more line.
    nowMs += 30_000;
    dialLog.rejected(dial, 'desktop', 'rate_limit_ip', { httpStatus: 429 });
    dialLog.rejected(dial, 'desktop', 'rate_limit_ip', { httpStatus: 429 });
    expect(linesWithMessage(lines, 'dial rejected')).toHaveLength(3);
    expect(metrics.snapshot().dialLogSuppressedTotal).toBe(2);
  });

  it('shares one budget between rejection and close lines', () => {
    const lines: CapturedLine[] = [];
    const metrics = createMetrics();
    const dialLog = createDialLog({ logger: capturingLogger(lines), metrics, maxLinesPerMinute: 1, now: () => 0 });
    if (dialLog === null) throw new Error('expected a dial log');
    const dial = startDialCorrelation(DESKTOP_DIAL_ID, undefined);
    const { conn } = createSlotTableHarness().connect(SLOT);

    dialLog.rejected(dial, 'desktop', 'rate_limit_ip', { httpStatus: 429 });
    dialLog.closed(conn, dial, 1000);

    expect(dialLines(lines).map((line) => line.message)).toEqual(['dial rejected']);
    expect(metrics.snapshot().dialLogSuppressedTotal).toBe(1);
  });
});

describe('the relay-side teardown cause', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is null when the client ends a connection the relay never decided to end', () => {
    const parked = createSlotTableHarness().connect(SLOT);
    parked.socket.readyState = READY_STATE.CLOSED;
    parked.socket.emit('close', 1000);
    expect(parked.conn.teardownCause).toBeNull();
  });

  it('names slot_busy on a third arrival', () => {
    const harness = createSlotTableHarness();
    harness.connect(SLOT);
    harness.connect(SLOT);
    expect(harness.connect(SLOT).conn.teardownCause).toBe('slot_busy');
  });

  it('names park_timeout on a peer that waited too long', () => {
    vi.useFakeTimers();
    const parked = createSlotTableHarness({}, 2, 1_000).connect(SLOT);
    vi.advanceTimersByTime(1_000);
    expect(parked.conn.teardownCause).toBe('park_timeout');
  });

  it('names parked_overflow on a parked peer that overran its buffer', () => {
    const parked = createSlotTableHarness({ maxParkedBufferBytes: 8 }).connect(SLOT);
    parked.socket.emit('message', Buffer.alloc(16), true);
    expect(parked.conn.teardownCause).toBe('parked_overflow');
  });

  it('names the tripped guard on both halves, and the partner close that follows does not overwrite it', () => {
    const harness = createSlotTableHarness({ maxBufferedBytes: 64 });
    const first = harness.connect(SLOT);
    const second = harness.connect(SLOT);
    second.socket.bufferedAmount = 1_024;

    first.socket.emit('message', Buffer.alloc(4), true);
    expect(first.conn.teardownCause).toBe('backpressure');
    expect(second.conn.teardownCause).toBe('backpressure');

    // The tripping half's own close reaches handleClose's peer_closed branch
    // for its partner; first writer wins, so the guard stays the answer.
    first.socket.readyState = READY_STATE.CLOSED;
    first.socket.emit('close', CLOSE_CODE.BACKPRESSURE);
    expect(second.conn.teardownCause).toBe('backpressure');
  });

  it('names peer_closed on the survivor of a pair whose other half left, and nothing on the half that left', () => {
    const harness = createSlotTableHarness();
    const first = harness.connect(SLOT);
    const second = harness.connect(SLOT);
    first.socket.readyState = READY_STATE.CLOSED;
    first.socket.emit('close', 1000);
    expect(first.conn.teardownCause).toBeNull();
    expect(second.conn.teardownCause).toBe('peer_closed');
  });

  it('names socket_error on a socket the relay terminated after an error', () => {
    const parked = createSlotTableHarness().connect(SLOT);
    parked.socket.emit('error', new Error('read ECONNRESET'));
    expect(parked.socket.terminate).toHaveBeenCalledTimes(1);
    expect(parked.conn.teardownCause).toBe('socket_error');
  });

  it('names probe_evicted on an incumbent that failed the contention probe, and nothing on the one that answered', () => {
    vi.useFakeTimers();
    const harness = createSlotTableHarness({}, 2, 60_000, 2_000);
    const first = harness.connect(SLOT);
    const second = harness.connect(SLOT);
    harness.connect(SLOT);

    second.socket.emit('pong');
    vi.advanceTimersByTime(2_000);

    expect(first.conn.teardownCause).toBe('probe_evicted');
    expect(second.conn.teardownCause).toBeNull();
  });
});

describe('dial lines over a live relay', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('writes one close line per opened connection, joined by the client id, with no slot or IP', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({}, { logger: capturingLogger(lines) });

    const desktop = await openClient(relay.url, `${dialQuery(SLOT, DESKTOP_DIAL_ID)}&role=desktop`, { 'cf-ray': VALID_CF_RAY });
    const phone = await openClient(relay.url, `${dialQuery(SLOT, PHONE_DIAL_ID)}&role=mobile`);
    await waitFor(() => relay?.metrics.snapshot().pairedSlots === 1);
    desktop.close();
    await waitFor(() => linesWithMessage(lines, 'dial closed').length === 2);
    phone.terminate();

    const closeLines = linesWithMessage(lines, 'dial closed').map((line) => line.fields);
    const desktopLine = closeLines.find((fields) => fields['clientDialId'] === DESKTOP_DIAL_ID);
    const phoneLine = closeLines.find((fields) => fields['clientDialId'] === PHONE_DIAL_ID);
    if (desktopLine === undefined || phoneLine === undefined) throw new Error('expected a close line per dial');

    expect(desktopLine).toMatchObject({ cfRay: VALID_CF_RAY, role: 'desktop', paired: true, teardownCause: null });
    // The desktop left; the relay then closed the phone's half for it.
    expect(phoneLine).toMatchObject({ cfRay: null, role: 'mobile', paired: true, teardownCause: 'peer_closed' });
    for (const fields of [desktopLine, phoneLine]) {
      expect(fields['closeCode']).toEqual(expect.any(Number));
      const openedAfterMs = fields['openedAfterMs'] as number;
      expect(openedAfterMs).toBeGreaterThanOrEqual(0);
      expect(fields['closedAfterMs'] as number).toBeGreaterThanOrEqual(openedAfterMs);
      expectNoSlotOrIp(fields);
    }
    expect(desktopLine['connId']).not.toBe(phoneLine['connId']);
  });

  it('writes nothing for a client that sent no dial id, a malformed one, or one cut from its own slot', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({}, { logger: capturingLogger(lines) });

    for (const query of [
      dialQuery(SLOT),
      dialQuery(OTHER_SLOT, 'not-a-dial-id\n{"level":"error"}'),
      dialQuery(SHORT_SLOT, SHORT_SLOT.slice(0, 16)),
    ]) {
      const socket = await openClient(relay.url, query);
      socket.close();
    }
    await waitFor(() => relay?.metrics.snapshot().activeConnections === 0);

    expect(dialLines(lines)).toHaveLength(0);
  });

  it('writes the close line with the connection trace off, and joins the trace line when it is on', async () => {
    const untracedLines: CapturedLine[] = [];
    relay = await startTestRelay({ connectionTrace: false }, { logger: capturingLogger(untracedLines) });
    (await openClient(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID))).close();
    await waitFor(() => linesWithMessage(untracedLines, 'dial closed').length === 1);
    expect(linesWithMessage(untracedLines, 'connection trace')).toHaveLength(0);
    await relay.close();

    const tracedLines: CapturedLine[] = [];
    relay = await startTestRelay({ connectionTrace: true }, { logger: capturingLogger(tracedLines) });
    (await openClient(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID))).close();
    await waitFor(() => linesWithMessage(tracedLines, 'dial closed').length === 1);
    expect(onlyLine(tracedLines, 'connection trace')['clientDialId']).toBe(DESKTOP_DIAL_ID);
    expect(onlyLine(tracedLines, 'dial closed')['clientDialId']).toBe(DESKTOP_DIAL_ID);
  });

  it('names shutting_down on a connection the relay closed on its way out', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({}, { logger: capturingLogger(lines) });
    await openClient(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID));

    await relay.close();
    relay = undefined;

    await waitFor(() => linesWithMessage(lines, 'dial closed').length === 1);
    expect(onlyLine(lines, 'dial closed')).toMatchObject({ teardownCause: 'shutting_down', paired: false });
  });

  it('logs a rate-limited dial, and the dial id itself spends no budget and cannot reject', async () => {
    const lines: CapturedLine[] = [];
    // Two tokens: exactly what two plain dials would get, dial id or not.
    relay = await startTestRelay({ rateLimitIpPerMinute: 1, rateLimitIpBurst: 2 }, { logger: capturingLogger(lines) });

    const first = await attemptUpgrade(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID), { 'cf-ray': VALID_CF_RAY });
    const second = await attemptUpgrade(relay.url, dialQuery(OTHER_SLOT, 'not-a-dial-id'));
    const third = await attemptUpgrade(relay.url, dialQuery(SHORT_SLOT, PHONE_DIAL_ID), { 'cf-ray': VALID_CF_RAY });

    expect(first.opened).toBe(true);
    expect(second.opened).toBe(true);
    expect(third).toEqual({ opened: false, status: 429 });
    const rejected = onlyLine(lines, 'dial rejected');
    expect(rejected).toMatchObject({
      clientDialId: PHONE_DIAL_ID,
      cfRay: VALID_CF_RAY,
      reason: 'rate_limit_ip',
      httpStatus: 429,
      closeCode: null,
    });
    expect(rejected['rejectedAfterMs']).toEqual(expect.any(Number));
    expectNoSlotOrIp(rejected);
    for (const outcome of [first, second]) if (outcome.opened) outcome.socket.close();
  });

  it('logs a dial refused by the per-slot rate limit', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({ rateLimitSlotPerMinute: 1, rateLimitSlotBurst: 1 }, { logger: capturingLogger(lines) });
    const first = await openClient(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID));
    expect(await attemptUpgrade(relay.url, dialQuery(SLOT, PHONE_DIAL_ID))).toEqual({ opened: false, status: 429 });
    expect(onlyLine(lines, 'dial rejected')).toMatchObject({ clientDialId: PHONE_DIAL_ID, reason: 'rate_limit_slot' });
    first.close();
  });

  it('logs a dial refused by the global cap', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({ maxConnections: 1, maxUnpairedConnections: 50 }, { logger: capturingLogger(lines) });
    const first = await openClient(relay.url, dialQuery(SLOT));
    expect(await attemptUpgrade(relay.url, dialQuery(OTHER_SLOT, PHONE_DIAL_ID))).toEqual({ opened: false, status: 503 });
    expect(onlyLine(lines, 'dial rejected')).toMatchObject({ reason: 'global_cap', httpStatus: 503 });
    first.close();
  });

  it('logs a dial refused by the unpaired cap', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({ maxUnpairedConnections: 2 }, { logger: capturingLogger(lines) });
    const parked = [await openClient(relay.url, dialQuery(SLOT)), await openClient(relay.url, dialQuery(OTHER_SLOT))];
    expect(await attemptUpgrade(relay.url, dialQuery(SHORT_SLOT, PHONE_DIAL_ID))).toEqual({ opened: false, status: 503 });
    expect(onlyLine(lines, 'dial rejected')).toMatchObject({ reason: 'unpaired_cap', httpStatus: 503 });
    for (const socket of parked) socket.close();
  });

  it('logs a dial refused because the relay began draining while admission was pending', async () => {
    const lines: CapturedLine[] = [];
    let releaseAdmission = (_decision: AdmissionDecision): void => undefined;
    let notifyAdmissionStarted = (): void => undefined;
    const admissionStarted = new Promise<void>((resolve) => {
      notifyAdmissionStarted = resolve;
    });
    const pendingPolicy: AdmissionPolicy = {
      admit: () =>
        new Promise<AdmissionDecision>((resolve) => {
          releaseAdmission = resolve;
          notifyAdmissionStarted();
        }),
    };
    relay = await startTestRelay({}, { logger: capturingLogger(lines), admissionPolicy: pendingPolicy });

    const outcome = attemptUpgrade(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID));
    await admissionStarted;
    const closing = relay.close();
    relay = undefined;
    releaseAdmission({ allow: true });

    expect(await outcome).toEqual({ opened: false, status: 503 });
    await closing;
    expect(onlyLine(lines, 'dial rejected')).toMatchObject({ reason: 'shutting_down', httpStatus: 503 });
  });

  it('logs an admission deny with the close code the policy chose', async () => {
    const lines: CapturedLine[] = [];
    const denyPolicy: AdmissionPolicy = {
      admit: () => ({ allow: false, closeCode: CLOSE_CODE.ADMISSION_DENIED, reason: 'denied' }),
    };
    relay = await startTestRelay({}, { logger: capturingLogger(lines), admissionPolicy: denyPolicy });

    await attemptUpgrade(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID));
    await waitFor(() => linesWithMessage(lines, 'dial rejected').length === 1);

    expect(onlyLine(lines, 'dial rejected')).toMatchObject({
      reason: 'admission',
      httpStatus: null,
      closeCode: CLOSE_CODE.ADMISSION_DENIED,
    });
    // A denied dial never became a Conn, so it has no close line as well.
    expect(linesWithMessage(lines, 'dial closed')).toHaveLength(0);
  });

  it('logs a dial whose admission policy threw', async () => {
    const lines: CapturedLine[] = [];
    const throwingPolicy: AdmissionPolicy = {
      admit: () => {
        throw new Error('policy exploded');
      },
    };
    relay = await startTestRelay({}, { logger: capturingLogger(lines), admissionPolicy: throwingPolicy });

    expect(await attemptUpgrade(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID))).toEqual({ opened: false, status: 503 });
    expect(onlyLine(lines, 'dial rejected')).toMatchObject({ reason: 'admission_error', httpStatus: 503 });
    // Not a reject reason the counters know, so nothing new is counted.
    expect(relay.metrics.snapshot().rejectsByReason).toEqual({});
  });

  it('logs a dial whose handshake ws aborted itself', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({}, { logger: capturingLogger(lines) });

    await attemptAbortedUpgrade(Number(new URL(relay.url).port), dialQuery(SLOT, DESKTOP_DIAL_ID));
    await waitFor(() => linesWithMessage(lines, 'dial rejected').length === 1);

    expect(onlyLine(lines, 'dial rejected')).toMatchObject({
      clientDialId: DESKTOP_DIAL_ID,
      reason: 'handshake_aborted',
      httpStatus: null,
      closeCode: null,
    });
  });

  it('writes nothing for the two rejects that sit before the dial id is read', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({ wsPath: '/ws' }, { logger: capturingLogger(lines) });

    expect(await attemptUpgrade(relay.url, `/nope?slot=${SLOT}&dial=${DESKTOP_DIAL_ID}`)).toEqual({ opened: false, status: 404 });
    expect(await attemptUpgrade(relay.url, `/ws?slot=nothex&dial=${DESKTOP_DIAL_ID}`)).toEqual({ opened: false, status: 400 });

    expect(dialLines(lines)).toHaveLength(0);
  });

  it('never lets a dial id reach either metrics surface', async () => {
    relay = await startTestRelay({ metricsAllowUnauthenticated: true }, { logger: capturingLogger([]) });
    (await openClient(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID))).close();
    expect(await attemptUpgrade(relay.url, `/?slot=nothex&dial=${PHONE_DIAL_ID}`)).toEqual({ opened: false, status: 400 });
    await waitFor(() => relay?.metrics.snapshot().activeConnections === 0);

    const httpBase = relay.url.replace('ws://', 'http://');
    const prometheus = await (await fetch(`${httpBase}/metrics`)).text();
    const json = await (await fetch(`${httpBase}/metricz`)).text();
    for (const body of [prometheus, json]) {
      expect(body).not.toContain(DESKTOP_DIAL_ID);
      expect(body).not.toContain(PHONE_DIAL_ID);
    }
  });

  it('drops and counts lines past DIAL_LOG_MAX_PER_MIN, and writes and counts nothing at 0', async () => {
    const cappedLines: CapturedLine[] = [];
    relay = await startTestRelay({ dialLogMaxPerMinute: 1 }, { logger: capturingLogger(cappedLines) });
    (await openClient(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID))).close();
    (await openClient(relay.url, dialQuery(OTHER_SLOT, PHONE_DIAL_ID))).close();
    await waitFor(() => relay?.metrics.snapshot().dialLogSuppressedTotal === 1);
    expect(linesWithMessage(cappedLines, 'dial closed')).toHaveLength(1);
    await relay.close();

    const offLines: CapturedLine[] = [];
    relay = await startTestRelay({ dialLogMaxPerMinute: 0 }, { logger: capturingLogger(offLines) });
    (await openClient(relay.url, dialQuery(SLOT, DESKTOP_DIAL_ID))).close();
    await waitFor(() => relay?.metrics.snapshot().activeConnections === 0);
    expect(dialLines(offLines)).toHaveLength(0);
    expect(relay.metrics.snapshot().dialLogSuppressedTotal).toBe(0);
  });
});
