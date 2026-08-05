/**
 * Application WebSocket close codes, in the private-use range 4000-4999.
 * Every non-standard close the relay issues uses one of these so a client
 * (or an operator reading logs) can tell rejection reasons apart.
 *
 * Not every rejection reaches a close code. Everything the relay decides
 * *before* completing the upgrade answers with a plain HTTP status instead
 * (400 for a bad slot, 429 rate limited, 503 capped or draining), because
 * there is no WebSocket yet to close. The RESERVED block below is what that
 * leaves stranded: codes a client must never be written to wait for.
 */
export const CLOSE_CODE = {
  /** The peer half of a paired tunnel closed; this half is torn down too. */
  PEER_CLOSED: 4000,
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

  // --- Reserved: allocated but never sent by this relay. ---

  /**
   * RESERVED, never sent. A missing or malformed `slot` is rejected before
   * the upgrade completes, so the client sees HTTP 400 and no WebSocket.
   */
  BAD_SLOT: 4400,
  /**
   * RESERVED, never sent. Draining refuses new upgrades with HTTP 503 and
   * closes established connections with the standard 1001 (going away).
   */
  SHUTTING_DOWN: 4503,
  /**
   * RESERVED, never sent. An unanswered ping is reaped with terminate(),
   * which yields the standard abnormal-closure 1006 rather than a code.
   */
  IDLE_TIMEOUT: 4410,
} as const;

export type RejectReason =
  | 'slot_format'
  | 'rate_limit_ip'
  | 'rate_limit_slot'
  | 'global_cap'
  // Rejected by MAX_UNPAIRED_CONNECTIONS. Sent as the same HTTP 503 as
  // 'global_cap' so the wire reveals nothing extra, but counted separately so
  // an operator can tell parking pressure from genuine saturation.
  | 'unpaired_cap'
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
