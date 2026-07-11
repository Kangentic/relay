import { describe, it, expect } from 'vitest';
import { isValidSlotId } from '../src/guards/slotFormat.js';

const DEFAULT_PATTERN = /^[0-9a-f]{64}$/;
const VALID_SLOT = 'a'.repeat(64);

describe('isValidSlotId', () => {
  it('accepts a 64-char lowercase hex slot', () => {
    expect(isValidSlotId(VALID_SLOT, DEFAULT_PATTERN)).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidSlotId('', DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects a slot that is too short', () => {
    expect(isValidSlotId('a'.repeat(63), DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects a slot that is too long', () => {
    expect(isValidSlotId('a'.repeat(65), DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects uppercase hex', () => {
    expect(isValidSlotId('A'.repeat(64), DEFAULT_PATTERN)).toBe(false);
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
