import { describe, it, expect } from 'vitest';
import { CLIENT_DIAL_ID_LENGTH, parseClientDialId } from '../src/guards/dialId.js';

const VALID_DIAL_ID = '0123456789abcdef';

describe('parseClientDialId', () => {
  it('accepts exactly sixteen lowercase hex characters and returns them unchanged', () => {
    expect(parseClientDialId(VALID_DIAL_ID)).toBe(VALID_DIAL_ID);
    expect(parseClientDialId('ffffffffffffffff')).toBe('ffffffffffffffff');
    expect(parseClientDialId('0000000000000000')).toBe('0000000000000000');
    expect(CLIENT_DIAL_ID_LENGTH).toBe(16);
  });

  it('reads an absent or empty parameter as null, never as a rejection', () => {
    // Every client deployed before this shipped omits it. If absence were an
    // error rather than a value, all of them would break at once.
    expect(parseClientDialId(null)).toBeNull();
    expect(parseClientDialId('')).toBeNull();
  });

  it('refuses one character short or one over', () => {
    expect(parseClientDialId(VALID_DIAL_ID.slice(0, 15))).toBeNull();
    expect(parseClientDialId(`${VALID_DIAL_ID}0`)).toBeNull();
  });

  it('bounds length before comparing, like the slot guard does', () => {
    expect(parseClientDialId('a'.repeat(1024))).toBeNull();
    expect(parseClientDialId(VALID_DIAL_ID.repeat(64))).toBeNull();
  });

  it('does not case-fold, so only the lowercase shape counts', () => {
    expect(parseClientDialId('0123456789ABCDEF')).toBeNull();
    expect(parseClientDialId('0123456789abcdeF')).toBeNull();
  });

  it('refuses anything outside [0-9a-f]', () => {
    expect(parseClientDialId('0123456789abcdeg')).toBeNull();
    expect(parseClientDialId('0123456789abcde-')).toBeNull();
    expect(parseClientDialId('zzzzzzzzzzzzzzzz')).toBeNull();
    // A UUID's hex digits, dashes and all, are not this shape either.
    expect(parseClientDialId('0123-4567-89ab-c')).toBeNull();
  });

  it('does not trim, so surrounding whitespace is refused rather than stripped', () => {
    expect(parseClientDialId(` ${VALID_DIAL_ID.slice(1)}`)).toBeNull();
    expect(parseClientDialId(`${VALID_DIAL_ID.slice(1)} `)).toBeNull();
    expect(parseClientDialId(`${VALID_DIAL_ID.slice(1)}\n`)).toBeNull();
  });

  it('refuses hostile input of the right length as well as the wrong one', () => {
    // The value reaches a log line, so the shape is the whole defense against
    // log injection. Sixteen characters is plenty to carry a payload.
    const hostile = [
      '0123456\n{"a":1}',
      '0123456789abcd"}',
      '<script>alert(1)',
      '../../etc/passwd',
      '0123456789abcdef"} 1\nrelay_fake_metric{x="',
      '{"dial":"0123456789abcdef"}',
      '0123456789abcd\u0000f',
    ];
    for (const raw of hostile) {
      expect(parseClientDialId(raw)).toBeNull();
    }
  });

  it('can only ever return null or a sixteen-character lowercase hex string', () => {
    const inputs = [null, '', VALID_DIAL_ID, VALID_DIAL_ID.toUpperCase(), 'x'.repeat(16), ' '.repeat(16)];
    for (const raw of inputs) {
      const parsed = parseClientDialId(raw);
      if (parsed !== null) expect(parsed).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
