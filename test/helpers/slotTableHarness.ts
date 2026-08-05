import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { WebSocket } from 'ws';
import { attachConnectionHandlers, createConn } from '../../src/connection.js';
import { SlotTable } from '../../src/rendezvous.js';
import { SlotConnectionCaps, UnpairedConnectionCap } from '../../src/guards/caps.js';
import { createMetrics, type Metrics } from '../../src/http/metrics.js';
import type { Logger } from '../../src/logging.js';
import type { Config, Conn } from '../../src/types.js';

/** WebSocket readyState values, named so tests read as intent rather than digits. */
export const READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

export class FakeSocket extends EventEmitter {
  readonly OPEN = READY_STATE.OPEN;
  readonly CONNECTING = READY_STATE.CONNECTING;
  readyState: number = READY_STATE.OPEN;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
  terminate = vi.fn();
  ping = vi.fn();
}

export interface SlotTableHarness {
  readonly slotTable: SlotTable;
  readonly metrics: Metrics;
  readonly slotCaps: SlotConnectionCaps;
  readonly unpairedCap: UnpairedConnectionCap;
  connect(slot: string, initialBufferedAmount?: number): { conn: Conn; socket: FakeSocket };
}

export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  slotRef: (slotId) => slotId,
};

export type ByteCapOverrides = Partial<
  Pick<Config, 'maxParkedBufferBytes' | 'maxBufferedBytes' | 'maxSessionBytes'>
>;

/**
 * Drives a real SlotTable over fake sockets, so a test can control
 * readyState and close ordering precisely. The wire-level suites cover what
 * a real client observes; this one covers the state machine underneath.
 */
export function createSlotTableHarness(
  configOverrides: ByteCapOverrides = {},
  maxConnectionsPerSlot = 2,
  parkTimeoutMs = 60_000,
): SlotTableHarness {
  const metrics = createMetrics();
  const config = {
    maxParkedBufferBytes: 1_048_576,
    maxBufferedBytes: 16_777_216,
    maxSessionBytes: 1_073_741_824,
    ...configOverrides,
  };
  const slotCaps = new SlotConnectionCaps(maxConnectionsPerSlot);
  // High enough never to bind here; the wire-level suite covers the cap itself.
  const unpairedCap = new UnpairedConnectionCap(1_000);
  const slotTable = new SlotTable({
    slotCaps,
    unpairedCap,
    metrics,
    logger: silentLogger,
    parkTimeoutMs,
    maxSessionMs: 0,
    maxSessionBytes: config.maxSessionBytes,
    maxBufferedBytes: config.maxBufferedBytes,
  });

  return {
    slotTable,
    metrics,
    slotCaps,
    unpairedCap,
    connect: (slot: string, initialBufferedAmount = 0) => {
      const socket = new FakeSocket();
      socket.bufferedAmount = initialBufferedAmount;
      const conn = createConn(socket as unknown as WebSocket, slot, '127.0.0.1');
      // Mirrors server.ts: the reservation is taken during the upgrade and
      // handed to the connection, which releases it on pair or on close.
      unpairedCap.tryReserve();
      conn.unpairedReserved = true;
      attachConnectionHandlers(conn, { slotTable, metrics, logger: silentLogger, config, onClosed: () => {} });
      slotTable.handleConnection(conn);
      return { conn, socket };
    },
  };
}
