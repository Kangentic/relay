import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from '../types.js';

const IPV4_MAPPED_PREFIX = '::ffff:';

/** Normalizes an IPv4-mapped IPv6 address ("::ffff:1.2.3.4") down to plain IPv4. */
export function normalizeIp(address: string): string {
  const trimmed = address.trim();
  if (trimmed.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
    return trimmed.slice(IPV4_MAPPED_PREFIX.length);
  }
  return trimmed;
}

function ipToBits(address: string): { bits: bigint; length: number } | null {
  const normalized = normalizeIp(address);
  if (normalized.includes('.') && !normalized.includes(':')) {
    const octets = normalized.split('.');
    if (octets.length !== 4) return null;
    let value = 0n;
    for (const octet of octets) {
      const numeric = Number(octet);
      if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) return null;
      value = (value << 8n) | BigInt(numeric);
    }
    return { bits: value, length: 32 };
  }
  if (normalized.includes(':')) {
    const groups = expandIpv6(normalized);
    if (!groups) return null;
    let value = 0n;
    for (const group of groups) value = (value << 16n) | BigInt(group);
    return { bits: value, length: 128 };
  }
  return null;
}

function expandIpv6(address: string): number[] | null {
  const [head, tail] = address.split('::');
  const parseGroups = (segment: string): number[] | null => {
    if (segment === undefined || segment === '') return [];
    const parts = segment.split(':');
    const values: number[] = [];
    for (const part of parts) {
      const numeric = Number.parseInt(part, 16);
      if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffff) return null;
      values.push(numeric);
    }
    return values;
  };

  if (tail === undefined) {
    const groups = parseGroups(address);
    return groups && groups.length === 8 ? groups : null;
  }
  const headGroups = parseGroups(head ?? '');
  const tailGroups = parseGroups(tail);
  if (!headGroups || !tailGroups) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  return [...headGroups, ...new Array<number>(missing).fill(0), ...tailGroups];
}

/** Returns true if `address` falls inside `cidr` ("1.2.3.0/24" or "::1/128"). */
export function isInCidr(address: string, cidr: string): boolean {
  const [network, prefixLengthRaw] = cidr.split('/');
  if (!network || prefixLengthRaw === undefined) return false;
  const prefixLength = Number(prefixLengthRaw);
  const addressBits = ipToBits(address);
  const networkBits = ipToBits(network);
  if (!addressBits || !networkBits || addressBits.length !== networkBits.length) return false;
  if (prefixLength < 0 || prefixLength > addressBits.length) return false;
  if (prefixLength === 0) return true;
  const shift = BigInt(addressBits.length - prefixLength);
  return (addressBits.bits >> shift) === (networkBits.bits >> shift);
}

function isTrustedProxy(remoteAddress: string, trustedCidrs: readonly string[]): boolean {
  if (trustedCidrs.length === 0) return true;
  return trustedCidrs.some((cidr) => isInCidr(remoteAddress, cidr));
}

/**
 * Resolves the real client IP for a connection. With trustProxy disabled
 * (the default), always trusts the raw socket address, so a self-hoster
 * with no reverse proxy cannot have its caps bypassed via a forged header.
 * With trustProxy enabled, prefers Cloudflare's authoritative
 * CF-Connecting-IP, then falls back to the outermost X-Forwarded-For entry
 * once any listed trusted-proxy hops are stripped.
 */
export function resolveClientIp(
  headers: IncomingHttpHeaders,
  socketRemoteAddress: string | undefined,
  config: Pick<Config, 'trustProxy' | 'trustedProxyCidrs'>,
): string {
  const fallback = normalizeIp(socketRemoteAddress ?? '0.0.0.0');
  if (!config.trustProxy) return fallback;
  if (!isTrustedProxy(fallback, config.trustedProxyCidrs)) return fallback;

  const cfConnectingIp = headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.length > 0) {
    return normalizeIp(cfConnectingIp);
  }

  const forwardedFor = headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof forwardedValue === 'string' && forwardedValue.length > 0) {
    const hops = forwardedValue.split(',').map((entry) => normalizeIp(entry));
    const clientHop = hops.find((hop) => !isTrustedProxy(hop, config.trustedProxyCidrs));
    if (clientHop) return clientHop;
    const firstHop = hops[0];
    if (firstHop) return firstHop;
  }

  return fallback;
}

/**
 * Buckets an IP into a cap/rate-limit key: IPv4 addresses are used as-is,
 * IPv6 addresses are truncated to their leading `ipv6PrefixBits` so a
 * single client cannot evade per-IP limits by rotating through its /64 (or
 * configured prefix) of addresses.
 */
export function bucketIp(address: string, ipv6PrefixBits: number): string {
  const normalized = normalizeIp(address);
  if (!normalized.includes(':')) return normalized;
  const groups = expandIpv6(normalized);
  if (!groups) return normalized;
  const keepGroups = Math.ceil(ipv6PrefixBits / 16);
  return groups
    .slice(0, keepGroups)
    .map((group) => group.toString(16))
    .join(':');
}
