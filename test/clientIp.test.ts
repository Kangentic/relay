import { describe, it, expect } from 'vitest';
import { resolveClientIp, bucketIp, normalizeIp, isInCidr, isValidCidr } from '../src/net/clientIp.js';

describe('normalizeIp', () => {
  it('strips the IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIp('::ffff:203.0.113.1')).toBe('203.0.113.1');
  });

  it('leaves a plain IPv4 address unchanged', () => {
    expect(normalizeIp('203.0.113.1')).toBe('203.0.113.1');
  });

  it('leaves a plain IPv6 address unchanged', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('isInCidr', () => {
  it('matches an IPv4 address inside its /24', () => {
    expect(isInCidr('203.0.113.42', '203.0.113.0/24')).toBe(true);
  });

  it('rejects an IPv4 address outside its /24', () => {
    expect(isInCidr('203.0.114.42', '203.0.113.0/24')).toBe(false);
  });

  it('matches an IPv6 address inside its prefix', () => {
    expect(isInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
  });

  it('returns false instead of throwing for a non-numeric prefix', () => {
    expect(isInCidr('10.0.0.1', '10.0.0.0/x')).toBe(false);
  });

  it('rejects an empty prefix segment rather than treating it as /0', () => {
    expect(isInCidr('203.0.113.9', '10.0.0.0/')).toBe(false);
  });
});

describe('isValidCidr', () => {
  it('accepts a well-formed IPv4 CIDR', () => {
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
  });

  it('accepts a well-formed IPv6 CIDR', () => {
    expect(isValidCidr('2001:db8::/32')).toBe(true);
  });

  it('rejects a non-numeric prefix', () => {
    expect(isValidCidr('10.0.0.0/x')).toBe(false);
  });

  it('rejects a prefix out of range for the address family', () => {
    expect(isValidCidr('10.0.0.0/99')).toBe(false);
  });

  it('rejects a network that is not a valid IP', () => {
    expect(isValidCidr('notanip/24')).toBe(false);
  });

  it('rejects a CIDR with no prefix', () => {
    expect(isValidCidr('10.0.0.0')).toBe(false);
  });

  it('rejects a trailing-slash typo instead of accepting it as /0', () => {
    expect(isValidCidr('10.0.0.0/')).toBe(false);
  });

  it('rejects a non-decimal prefix that Number() would coerce', () => {
    expect(isValidCidr('10.0.0.0/0x8')).toBe(false);
  });
});

describe('resolveClientIp', () => {
  it('uses the raw socket address when trustProxy is disabled', () => {
    const ip = resolveClientIp(
      { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' },
      '10.0.0.5',
      { trustProxy: false, trustedProxyCidrs: [] },
    );
    expect(ip).toBe('10.0.0.5');
  });

  it('prefers CF-Connecting-IP when trustProxy is enabled', () => {
    const ip = resolveClientIp(
      { 'cf-connecting-ip': '203.0.113.9' },
      '10.0.0.5',
      { trustProxy: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    );
    expect(ip).toBe('203.0.113.9');
  });

  it('falls back to X-Forwarded-For when there is no CF-Connecting-IP', () => {
    const ip = resolveClientIp(
      { 'x-forwarded-for': '198.51.100.1, 10.0.0.5' },
      '10.0.0.5',
      { trustProxy: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    );
    expect(ip).toBe('198.51.100.1');
  });

  it('does not trust proxy headers from an untrusted socket peer', () => {
    const ip = resolveClientIp(
      { 'cf-connecting-ip': '203.0.113.9' },
      '198.51.100.7',
      { trustProxy: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    );
    expect(ip).toBe('198.51.100.7');
  });

  it('normalizes an IPv4-mapped IPv6 socket address', () => {
    const ip = resolveClientIp({}, '::ffff:10.0.0.5', { trustProxy: false, trustedProxyCidrs: [] });
    expect(ip).toBe('10.0.0.5');
  });

  it('picks the rightmost untrusted hop instead of a forged leftmost one', () => {
    const ip = resolveClientIp(
      { 'x-forwarded-for': '1.2.3.4, 198.51.100.1, 10.0.0.5' },
      '10.0.0.5',
      { trustProxy: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    );
    expect(ip).toBe('198.51.100.1');
  });

  it('strips multiple trusted hops from the right before returning the client hop', () => {
    const ip = resolveClientIp(
      { 'x-forwarded-for': '198.51.100.1, 10.0.0.6, 10.0.0.5' },
      '10.0.0.5',
      { trustProxy: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    );
    expect(ip).toBe('198.51.100.1');
  });

  it('ignores X-Forwarded-For and falls back to the socket peer when no CIDRs are trusted', () => {
    const ip = resolveClientIp(
      { 'x-forwarded-for': '198.51.100.1, 10.0.0.5' },
      '10.0.0.5',
      { trustProxy: true, trustedProxyCidrs: [] },
    );
    expect(ip).toBe('10.0.0.5');
  });

  it('skips a malformed rightmost hop and returns the next untrusted valid hop', () => {
    const ip = resolveClientIp(
      { 'x-forwarded-for': '198.51.100.1, not-an-ip, 10.0.0.5' },
      '10.0.0.5',
      { trustProxy: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    );
    expect(ip).toBe('198.51.100.1');
  });

  it('falls back to the socket peer when every hop is trusted', () => {
    const ip = resolveClientIp(
      { 'x-forwarded-for': '10.0.0.6, 10.0.0.5' },
      '10.0.0.5',
      { trustProxy: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    );
    expect(ip).toBe('10.0.0.5');
  });

  it('does not trust CF-Connecting-IP when no CIDRs are trusted', () => {
    const ip = resolveClientIp(
      { 'cf-connecting-ip': '203.0.113.9' },
      '10.0.0.5',
      { trustProxy: true, trustedProxyCidrs: [] },
    );
    expect(ip).toBe('10.0.0.5');
  });

  it('joins multiple X-Forwarded-For header lines before walking hops', () => {
    const ip = resolveClientIp(
      { 'x-forwarded-for': ['1.2.3.4', '198.51.100.1, 10.0.0.5'] },
      '10.0.0.5',
      { trustProxy: true, trustedProxyCidrs: ['10.0.0.0/8'] },
    );
    expect(ip).toBe('198.51.100.1');
  });
});

describe('bucketIp', () => {
  it('leaves an IPv4 address unbucketed', () => {
    expect(bucketIp('203.0.113.1', 64)).toBe('203.0.113.1');
  });

  it('buckets two IPv6 addresses in the same /64 to the same key', () => {
    const bucketA = bucketIp('2001:db8:abcd:1::1', 64);
    const bucketB = bucketIp('2001:db8:abcd:1::2', 64);
    expect(bucketA).toBe(bucketB);
  });

  it('buckets two IPv6 addresses in different /64s to different keys', () => {
    const bucketA = bucketIp('2001:db8:abcd:1::1', 64);
    const bucketB = bucketIp('2001:db8:abcd:2::1', 64);
    expect(bucketA).not.toBe(bucketB);
  });
});
