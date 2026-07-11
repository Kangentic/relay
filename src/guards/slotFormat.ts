const MAX_SLOT_LENGTH_BEFORE_REGEX = 256;

/**
 * Validates a slot id's shape before it is used as a rendezvous key. The
 * relay cannot validate a slot cryptographically (it is blind), so this is
 * the only gate: reject anything malformed or oversized before it ever
 * reaches the regex engine or the slot table. Never normalize case here -
 * the slot is used as an exact-match key downstream, and folding case would
 * risk misrouting two distinct rendezvous secrets into one slot.
 */
export function isValidSlotId(slot: string, pattern: RegExp): boolean {
  if (slot.length === 0 || slot.length > MAX_SLOT_LENGTH_BEFORE_REGEX) return false;
  return pattern.test(slot);
}
