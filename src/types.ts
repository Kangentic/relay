import type { RawData, WebSocket } from 'ws';
import type { RejectReason } from './closeCodes.js';

export interface Config {
  readonly port: number;
  readonly bindAddress: string;
  readonly wsPath: string;
  readonly slotIdPattern: RegExp;
  readonly maxConnections: number;
  readonly maxUnpairedConnections: number;
  readonly maxConnectionsPerIp: number;
  readonly maxConnectionsPerSlot: number;
  readonly rateLimitIpPerMinute: number;
  readonly rateLimitIpBurst: number;
  readonly rateLimitSlotPerMinute: number;
  readonly rateLimitSlotBurst: number;
  readonly maxMessageBytes: number;
  readonly maxSessionBytes: number;
  readonly maxParkedBufferBytes: number;
  readonly maxBufferedBytes: number;
  readonly pingIntervalMs: number;
  /**
   * How long the incumbents of a contended slot have to answer a liveness
   * probe before the silent one is reaped. 0 disables probing entirely.
   */
  readonly contentionProbeTimeoutMs: number;
  readonly parkTimeoutMs: number;
  readonly maxSessionMs: number;
  readonly shutdownGraceMs: number;
  readonly trustProxy: boolean;
  readonly trustedProxyCidrs: readonly string[];
  readonly ipv6PrefixBits: number;
  readonly metricsEnabled: boolean;
  readonly metricsToken: string | null;
  readonly metricsAllowUnauthenticated: boolean;
  /**
   * Serves the private /admin dashboard. The relay deliberately does not
   * authenticate it - gate it upstream (Cloudflare Access, a private network,
   * an SSH tunnel). Off by default, so the public image is unaffected.
   */
  readonly adminEnabled: boolean;
  /**
   * Absolute path to the append-only NDJSON metrics history store. Null keeps
   * the recorder memory-only (the in-process ring still serves /admin), so no
   * file is ever opened.
   */
  readonly metricsHistoryPath: string | null;
  readonly metricsHistoryIntervalMs: number;
  readonly logLevel: LogLevel;
  readonly logSlotHashing: boolean;
  readonly slotLogSalt: string;
  readonly admissionWebhookUrl: string | null;
  readonly admissionWebhookTimeoutMs: number;
  readonly admissionFailOpen: boolean;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export type ConnState = 'waiting' | 'paired' | 'closed';

export interface PendingFrame {
  readonly data: RawData;
  readonly isBinary: boolean;
}

export interface Conn {
  readonly id: string;
  readonly socket: WebSocket;
  readonly slot: string;
  readonly ip: string;
  readonly connectedAt: number;
  state: ConnState;
  partner: Conn | null;
  isAlive: boolean;
  /**
   * Whether a contention probe is currently awaiting this connection's pong.
   * Deliberately separate from `isAlive`, which the keepalive loop owns on its
   * own interval: a probe that wrote `isAlive` would race the reaper in both
   * directions, either rescuing a dead socket or condemning a live one.
   */
  probePending: boolean;
  pending: PendingFrame[];
  pendingBytes: number;
  parkTimer: ReturnType<typeof setTimeout> | null;
  sessionTimer: ReturnType<typeof setTimeout> | null;
  torndown: boolean;
  /**
   * Whether this connection currently holds a per-slot cap reservation.
   * Rejected connections never reserve one, so releasing unconditionally on
   * close would decrement a reservation that was never taken and erode the
   * cap for the peers that do hold one.
   */
  slotReserved: boolean;
  /**
   * Whether this connection currently holds an unpaired-connection cap
   * reservation. Released when it pairs, not only when it closes.
   */
  unpairedReserved: boolean;
  /**
   * The shared paired-slot state, set while this connection is half of a
   * live pair and cleared on teardown. Kept directly on the connection so
   * the per-frame forwarding hot path never does a slot-table lookup.
   */
  pairState: PairedSlotState | null;
}

export interface WaitingSlotState {
  readonly status: 'waiting';
  readonly peer: Conn;
}

export interface PairedSlotState {
  readonly status: 'paired';
  readonly a: Conn;
  readonly b: Conn;
  sessionBytes: number;
}

export type SlotState = WaitingSlotState | PairedSlotState;

export interface RejectDeps {
  metricsOnReject(reason: RejectReason): void;
}
