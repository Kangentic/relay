/** The one accepted shape: 64 random bits, hex-encoded lowercase. */
export const CLIENT_DIAL_ID_LENGTH = 16;

const CLIENT_DIAL_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Reads the optional `dial` query parameter: a per-dial-attempt id the client
 * mints from a CSPRNG and records in its own error reports, so a desktop or
 * mobile event can be joined to the relay's line for the same dial.
 *
 * Like `role`, this is not a guard: it cannot fail. Absent, empty, oversized,
 * malformed, wrong case, or actively hostile all collapse to null. Three
 * reasons that has to stay true:
 *
 * - Every client deployed today omits it. Rejecting on it would break all of
 *   them at once, and it must not consume rate-limit budget or mint a reject
 *   reason on the way.
 * - A rejection here would be an oracle. The relay deliberately refuses to tell
 *   a prober which of its checks they tripped (docs/security-model.md).
 * - The value is client-supplied and authenticated by nothing, so anyone can
 *   send any id. It is a join key for an operator reading logs, never a
 *   control, and nothing in pairing, routing, caps, or rate limiting may read
 *   it.
 *
 * One deliberate difference from `role`: the validated value IS returned and
 * logged, because being a join key is its whole job. That is safe in a log line
 * only because the accepted shape is fixed, sixteen characters from [0-9a-f],
 * so nothing that survives this parse can carry a newline, a quote, or a JSON
 * fragment. It is NOT safe in a metric. `role` collapses to a closed
 * three-value enum precisely so its cardinality is fixed; a dial id is
 * unbounded by nature, and one reaching a Prometheus label would let a stranger
 * mint a new series per dial, which is a metrics-cardinality denial of service
 * against the process. Log lines only, never the registry.
 *
 * Length is checked before the pattern, mirroring isValidSlotId, so an
 * oversized value costs one comparison and no regex work.
 */
export function parseClientDialId(raw: string | null): string | null {
  if (raw === null || raw.length !== CLIENT_DIAL_ID_LENGTH) return null;
  // Exact match only. Never case-fold or trim: a client that cannot send the
  // literal shape has not adopted the contract, and null is the honest answer.
  return CLIENT_DIAL_ID_PATTERN.test(raw) ? raw : null;
}
