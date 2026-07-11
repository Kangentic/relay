import { describe, it, expect } from 'vitest';
import { resolveClientIp, bucketIp, normalizeIp, isInCidr } from '../src/net/clientIp.js';

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
      { trustProxy: true, trustedProxyCidrs: [] },
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
