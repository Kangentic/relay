/**
 * Application WebSocket close codes, in the private-use range 4000-4999.
 * Every non-standard close the relay issues uses one of these so a client
 * (or an operator reading logs) can tell rejection reasons apart.
 */
export const CLOSE_CODE = {
  /** The peer half of a paired tunnel closed; this half is torn down too. */
  PEER_CLOSED: 4000,
  /** No `slot` query param, or it failed the configured format pattern. */
  BAD_SLOT: 4400,
  /** A second connection tried to join a slot that already has two peers. */
  SLOT_BUSY: 4409,
  /** A connection stayed unpaired past PARK_TIMEOUT_MS. */
  PARK_TIMEOUT: 4408,
  /** A parked or forwarding connection exceeded a byte/backpressure guard. */
  BACKPRESSURE: 4431,
  /** A paired tunnel exceeded MAX_SESSION_BYTES. */
  SESSION_BYTE_CAP: 4432,
  /** A paired tunnel exceeded MAX_SESSION_MS. */
  SESSION_TIME_CAP: 4433,
  /** The admission policy (in-process or webhook) denied the connection. */
  ADMISSION_DENIED: 4403,
  /** The server is draining for shutdown; retry against another instance. */
  SHUTTING_DOWN: 4503,
  /** A ping went unanswered for the configured window. */
  IDLE_TIMEOUT: 4410,
} as const;

export type RejectReason =
  | 'slot_format'
  | 'rate_limit_ip'
  | 'rate_limit_slot'
  | 'global_cap'
  | 'ip_cap'
  | 'slot_cap'
  | 'admission'
  | 'shutting_down'
  | 'slot_busy'
  | 'park_timeout'
  | 'parked_overflow'
  | 'backpressure'
  | 'session_byte_cap'
  | 'session_time_cap'
  | 'idle_timeout';
