import { describe, it, expect } from 'vitest';
import { isValidSlotId } from '../src/guards/slotFormat.js';
import { loadConfig } from '../src/config.js';

// The shipped default, not a hand-copied regex: these tests lock the real
// out-of-the-box behavior at both accepted lengths. Current clients derive
// both the pairing slot and the ongoing-session slot as 16 bytes, so both
// arrive as 32 hex. The default also accepts 64 hex, the shape a
// pre-protocol-v0.12.0 client dialed when the slot id was the pairing token
// hex-encoded; no current client produces it and the pattern has simply never
// been narrowed.
const DEFAULT_PATTERN = loadConfig({}).slotIdPattern;
const VALID_LEGACY_SLOT = 'a'.repeat(64);
const VALID_DERIVED_SLOT = 'b'.repeat(32);

describe('isValidSlotId', () => {
  it('accepts the legacy 64-char lowercase hex slot', () => {
    expect(isValidSlotId(VALID_LEGACY_SLOT, DEFAULT_PATTERN)).toBe(true);
  });

  it('accepts the 32-char lowercase hex slot current clients derive', () => {
    expect(isValidSlotId(VALID_DERIVED_SLOT, DEFAULT_PATTERN)).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isValidSlotId('', DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects a slot shorter than the derived length', () => {
    expect(isValidSlotId('a'.repeat(31), DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects lengths between the two accepted sizes', () => {
    expect(isValidSlotId('a'.repeat(33), DEFAULT_PATTERN)).toBe(false);
    expect(isValidSlotId('a'.repeat(48), DEFAULT_PATTERN)).toBe(false);
    expect(isValidSlotId('a'.repeat(63), DEFAULT_PATTERN)).toBe(false);
  });

  it('rejects a slot longer than the legacy length', () => {
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
