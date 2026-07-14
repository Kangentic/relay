import { describe, it, expect } from 'vitest';
import { isValidSlotId } from '../src/guards/slotFormat.js';
import { loadConfig } from '../src/config.js';

// The shipped default, not a hand-copied regex: these tests lock the real
// out-of-the-box behavior, including the 32-hex ongoing-session slot that
// @kangentic/protocol's deriveSessionSlotId produces.
const DEFAULT_PATTERN = loadConfig({}).slotIdPattern;
const VALID_PAIRING_SLOT = 'a'.repeat(64);
const VALID_SESSION_SLOT = 'b'.repeat(32);

describe('isValidSlotId', () => {
  it('accepts a 64-char lowercase hex pairing slot', () => {
    expect(isValidSlotId(VALID_PAIRING_SLOT, DEFAULT_PATTERN)).toBe(true);
  });

  it('accepts a 32-char lowercase hex session slot', () => {
    expect(isValidSlotId(VALID_SESSION_SLOT, DEFAULT_PATTERN)).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidSlotId('', DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects a slot shorter than the session length', () => {
    expect(isValidSlotId('a'.repeat(31), DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects lengths between the session and pairing slot sizes', () => {
    expect(isValidSlotId('a'.repeat(33), DEFAULT_PATTERN)).toBe(false);
    expect(isValidSlotId('a'.repeat(48), DEFAULT_PATTERN)).toBe(false);
    expect(isValidSlotId('a'.repeat(63), DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects a slot longer than the pairing length', () => {
    expect(isValidSlotId('a'.repeat(65), DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects uppercase hex at both lengths', () => {
    expect(isValidSlotId('A'.repeat(64), DEFAULT_PATTERN)).toBe(false);
    expect(isValidSlotId('B'.repeat(32), DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidSlotId('z'.repeat(64), DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects an oversized input before the regex ever runs', () => {
    expect(isValidSlotId('a'.repeat(10_000), DEFAULT_PATTERN)).toBe(false);
  });

  it('honors a custom pattern', () => {
    expect(isValidSlotId('short', /^short$/)).toBe(true);
  });
});
