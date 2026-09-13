/**
 * The closed set of reported peer roles. Frozen and exported so every surface
 * that emits a role dimension iterates THIS tuple rather than whatever values
 * it has observed, which is what fixes metric cardinality at three at compile
 * time.
 */
export const PEER_ROLES = Object.freeze(['desktop', 'mobile', 'unknown'] as const);

export type PeerRole = (typeof PEER_ROLES)[number];

/** Long enough for every accepted value, short enough that nothing else is worth comparing. */
const MAX_ROLE_LENGTH = 16;

/**
 * Reads the optional `role` query parameter into the closed enum.
 *
 * Unlike every other thing read off the upgrade URL, this is not a guard: it
 * cannot fail. Absent, empty, oversized, misspelled, wrong case, or actively
 * hostile all collapse to 'unknown'. Three reasons that has to stay true:
 *
 * - Every client deployed today omits it. Rejecting on it would break all of
 *   them at once, and it must not consume rate-limit budget or mint a reject
 *   reason on the way.
 * - A rejection here would be an oracle. The relay deliberately refuses to tell
 *   a prober which of its checks they tripped (docs/security-model.md).
 * - The value is client-supplied and authenticated by nothing, so anyone can
 *   claim any role. It is a hint for attributing a gauge, never a control, and
 *   nothing in pairing, routing, caps, or rate limiting may read it.
 *
 * The raw string is never returned, stored, or emitted. That is the load-bearing
 * part: an unvalidated value reaching a Prometheus label would let a stranger
 * mint unbounded label values and grow the registry without bound, which is a
 * metrics-cardinality denial of service against the process. Length is bounded
 * before any comparison, mirroring isValidSlotId.
 */
export function parsePeerRole(raw: string | null): PeerRole {
  if (raw === null || raw.length === 0 || raw.length > MAX_ROLE_LENGTH) return 'unknown';
  // Exact match only. Never case-fold or trim: a client that cannot send the
  // literal value is a client that has not adopted this yet, and 'unknown' is
  // the honest answer for it.
  if (raw === 'desktop') return 'desktop';
  if (raw === 'mobile') return 'mobile';
  return 'unknown';
}
