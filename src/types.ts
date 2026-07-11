import type { RawData, WebSocket } from 'ws';
import type { RejectReason } from './closeCodes.js';

export interface Config {
  readonly port: number;
  readonly bindAddress: string;
  readonly wsPath: string;
  readonly slotIdPattern: RegExp;
  readonly maxConnections: number;
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
  readonly parkTimeoutMs: number;
  readonly maxSessionMs: number;
  readonly shutdownGraceMs: number;
  readonly trustProxy: boolean;
  readonly trustedProxyCidrs: readonly string[];
  readonly ipv6PrefixBits: number;
  readonly metricsEnabled: boolean;
  readonly metricsToken: string | null;
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
  pending: PendingFrame[];
  pendingBytes: number;
  parkTimer: ReturnType<typeof setTimeout> | null;
  sessionTimer: ReturnType<typeof setTimeout> | null;
  torndown: boolean;
}

export type SlotState =
  | { readonly status: 'waiting'; readonly peer: Conn }
  | { readonly status: 'paired'; readonly a: Conn; readonly b: Conn; sessionBytes: number };

export interface RejectDeps {
  metricsOnReject(reason: RejectReason): void;
}
