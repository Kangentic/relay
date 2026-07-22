import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads with defaults when no env vars are set', () => {
    const config = loadConfig({});
    expect(config.trustProxy).toBe(false);
    expect(config.trustedProxyCidrs).toEqual([]);
  });

  it('throws when TRUST_PROXY is true and TRUSTED_PROXY_CIDRS is empty', () => {
    expect(() => loadConfig({ TRUST_PROXY: 'true' })).toThrow(/TRUSTED_PROXY_CIDRS/);
  });

  it('loads when TRUST_PROXY is true and TRUSTED_PROXY_CIDRS names a valid CIDR', () => {
    const config = loadConfig({ TRUST_PROXY: 'true', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' });
    expect(config.trustProxy).toBe(true);
    expect(config.trustedProxyCidrs).toEqual(['10.0.0.0/8']);
  });

  it('throws when a TRUSTED_PROXY_CIDRS entry has a non-numeric prefix', () => {
    expect(() =>
      loadConfig({ TRUST_PROXY: 'true', TRUSTED_PROXY_CIDRS: '10.0.0.0/x' }),
    ).toThrow(/TRUSTED_PROXY_CIDRS/);
  });

  it('throws when a TRUSTED_PROXY_CIDRS entry has an out-of-range prefix', () => {
    expect(() =>
      loadConfig({ TRUST_PROXY: 'true', TRUSTED_PROXY_CIDRS: '10.0.0.0/99' }),
    ).toThrow(/TRUSTED_PROXY_CIDRS/);
  });

  it('throws when a TRUSTED_PROXY_CIDRS entry is not a valid IP network', () => {
    expect(() =>
      loadConfig({ TRUST_PROXY: 'true', TRUSTED_PROXY_CIDRS: 'notanip/24' }),
    ).toThrow(/TRUSTED_PROXY_CIDRS/);
  });

  it('throws on a trailing-slash CIDR typo that would otherwise trust every peer', () => {
    expect(() =>
      loadConfig({ TRUST_PROXY: 'true', TRUSTED_PROXY_CIDRS: '10.0.0.0/' }),
    ).toThrow(/TRUSTED_PROXY_CIDRS/);
  });
});
