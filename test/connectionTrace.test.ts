import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { parseCfRay, startConnectionTrace, TRACE_FRAME_LIMIT } from '../src/connectionTrace.js';
import type { Logger } from '../src/logging.js';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { createSlotTableHarness } from './helpers/slotTableHarness.js';

const SLOT = 'c'.repeat(64);
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

interface OpenedClient {
  readonly socket: WebSocket;
  /**
   * Armed before the handshake, because pairing flushes a parked frame to the
   * newcomer synchronously and that can beat any listener attached after
   * 'open' (see test/helpers/wsClient.ts).
   */
  readonly firstMessage: Promise<void>;
}

function openClient(url: string, headers: Record<string, string>): Promise<OpenedClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url}?slot=${SLOT}&role=desktop`, { headers });
    const firstMessage = new Promise<void>((resolveMessage) => socket.once('message', () => resolveMessage()));
    socket.once('open', () => resolve({ socket, firstMessage }));
    socket.once('error', reject);
  });
}

function nextMessage(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once('message', () => resolve()));
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function traceLines(lines: readonly CapturedLine[]): CapturedLine[] {
  return lines.filter((line) => line.message === 'connection trace');
}

describe('parsing CF-Ray', () => {
  it('accepts a well-formed ray id', () => {
    expect(parseCfRay(VALID_CF_RAY)).toBe(VALID_CF_RAY);
    expect(parseCfRay([VALID_CF_RAY, 'ignored'])).toBe(VALID_CF_RAY);
  });

  it('drops anything else rather than copying a client-controlled header into a log line', () => {
    // Reachable directly, the origin sees whatever a client sends. A newline or
    // a JSON fragment here would be a log-injection vector.
    expect(parseCfRay(undefined)).toBeNull();
    expect(parseCfRay('')).toBeNull();
    expect(parseCfRay('8c1f2e3d4b5a6978-ATL\n{"level":"error"}')).toBeNull();
    expect(parseCfRay('8C1F2E3D4B5A6978-ATL')).toBeNull();
    expect(parseCfRay('8c1f2e3d4b5a6978-atl')).toBeNull();
    expect(parseCfRay('not-a-ray')).toBeNull();
  });
});

describe('the traced message listener', () => {
  it('is absent from an untraced connection', () => {
    const { conn, socket } = createSlotTableHarness().connect(SLOT);
    expect(conn.trace).toBeNull();
    expect(socket.listenerCount('message')).toBe(1);
  });

  it('records the first TRACE_FRAME_LIMIT frames, then swaps itself for the plain listener', () => {
    const trace = startConnectionTrace(undefined, undefined);
    const parked = createSlotTableHarness().connectTraced(SLOT, trace);
    for (let index = 0; index < TRACE_FRAME_LIMIT + 5; index += 1) {
      parked.socket.emit('message', Buffer.alloc(16), true);
    }

    expect(trace.frames).toHaveLength(TRACE_FRAME_LIMIT);
    // Still parked, so nothing was forwarded on arrival.
    expect(trace.frames.every((frame) => frame.queuedAheadBytes === null && frame.bytes === 16)).toBe(true);
    // One listener left, and it is the plain one: further frames are no
    // longer recorded.
    expect(parked.socket.listenerCount('message')).toBe(1);
    // The frames past the limit were still handled: they are parked, not lost.
    expect(parked.conn.pending).toHaveLength(TRACE_FRAME_LIMIT + 5);
  });

  it('records the partner queue a forwarded frame was written behind', () => {
    const harness = createSlotTableHarness();
    const trace = startConnectionTrace(undefined, undefined);
    const waiting = harness.connect(SLOT);
    const traced = harness.connectTraced(SLOT, trace);
    waiting.socket.bufferedAmount = 4_096;

    traced.socket.emit('message', Buffer.alloc(32), true);

    expect(trace.pairedAfterMs).not.toBeNull();
    expect(trace.frames).toEqual([expect.objectContaining({ bytes: 32, queuedAheadBytes: 4_096 })]);
    expect(waiting.socket.send).toHaveBeenCalledTimes(1);
  });
});

describe('connection trace over a live relay', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('logs one line per connection with dial timings and early frames, and no slot or IP', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({ connectionTrace: true }, { logger: capturingLogger(lines) });

    const { socket: desktop } = await openClient(relay.url, { 'cf-ray': VALID_CF_RAY });
    // Sent while parked: travels the pre-pair buffer and flushes at pairing.
    desktop.send(Buffer.from('parked-frame'));
    const { socket: phone, firstMessage } = await openClient(relay.url, { 'cf-ray': '{"forged":"ray"}' });
    await firstMessage;

    for (let index = 0; index < TRACE_FRAME_LIMIT + 3; index += 1) {
      const delivered = nextMessage(desktop);
      phone.send(Buffer.alloc(64, index));
      await delivered;
    }

    desktop.close();
    phone.close();
    await waitFor(() => traceLines(lines).length === 2);

    const [first, second] = traceLines(lines);
    const desktopLine = first?.fields['cfRay'] === VALID_CF_RAY ? first : second;
    const phoneLine = desktopLine === first ? second : first;
    if (desktopLine === undefined || phoneLine === undefined) throw new Error('expected two trace lines');

    expect(desktopLine.fields['role']).toBe('desktop');
    expect(phoneLine.fields['cfRay']).toBeNull();

    for (const line of [desktopLine, phoneLine]) {
      const admitted = line.fields['admittedAfterMs'] as number;
      const handshake = line.fields['handshakeCompletedAfterMs'] as number;
      const paired = line.fields['pairedAfterMs'] as number;
      expect(admitted).toBeGreaterThanOrEqual(0);
      expect(handshake).toBeGreaterThanOrEqual(admitted);
      expect(paired).toBeGreaterThanOrEqual(handshake);
      expect(line.fields['socketAgeAtUpgradeMs']).toEqual(expect.any(Number));
      expect(typeof line.fields['closeCode']).toBe('number');

      // The privacy contract, checked on the serialized line itself.
      const serialized = JSON.stringify(line.fields);
      expect(serialized).not.toContain(SLOT);
      expect(serialized).not.toContain('127.0.0.1');
      expect(serialized).not.toContain('slot');
    }

    const desktopFrames = desktopLine.fields['frames'] as { queuedAheadBytes: number | null }[];
    expect(desktopFrames).toHaveLength(1);
    expect(desktopFrames[0]?.queuedAheadBytes).toBeNull();

    // Capped, even though more frames than the limit crossed the relay.
    const phoneFrames = phoneLine.fields['frames'] as { bytes: number; queuedAheadBytes: number | null }[];
    expect(phoneFrames).toHaveLength(TRACE_FRAME_LIMIT);
    expect(phoneFrames.every((frame) => frame.bytes === 64 && typeof frame.queuedAheadBytes === 'number')).toBe(true);
  });

  it('logs nothing and records nothing when tracing is off', async () => {
    const lines: CapturedLine[] = [];
    relay = await startTestRelay({ connectionTrace: false }, { logger: capturingLogger(lines) });

    const { socket: desktop } = await openClient(relay.url, { 'cf-ray': VALID_CF_RAY });
    const { socket: phone } = await openClient(relay.url, {});
    const delivered = nextMessage(desktop);
    phone.send(Buffer.from('hello'));
    await delivered;
    desktop.close();
    phone.close();
    await waitFor(() => relay?.metrics.snapshot().activeConnections === 0);

    expect(traceLines(lines)).toHaveLength(0);
  });
});
