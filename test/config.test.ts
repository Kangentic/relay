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

describe('connection cap configuration', () => {
  it('derives MAX_UNPAIRED_CONNECTIONS from MAX_CONNECTIONS so raising one raises both', () => {
    expect(loadConfig({}).maxUnpairedConnections).toBe(5_000);
    expect(loadConfig({ MAX_CONNECTIONS: '400' }).maxUnpairedConnections).toBe(200);
  });

  it('honors an explicit MAX_UNPAIRED_CONNECTIONS over the derived default', () => {
    const config = loadConfig({ MAX_CONNECTIONS: '400', MAX_UNPAIRED_CONNECTIONS: '25' });
    expect(config.maxUnpairedConnections).toBe(25);
  });

  it('refuses a MAX_UNPAIRED_CONNECTIONS below 2, which could never complete a pairing', () => {
    // Both halves are unpaired at the moment they are admitted, so a ceiling
    // of 1 would deadlock every rendezvous rather than merely tightening it.
    expect(() => loadConfig({ MAX_UNPAIRED_CONNECTIONS: '1' })).toThrow(/MAX_UNPAIRED_CONNECTIONS/);
    expect(() => loadConfig({ MAX_UNPAIRED_CONNECTIONS: '0' })).toThrow(/MAX_UNPAIRED_CONNECTIONS/);
    expect(() => loadConfig({ MAX_CONNECTIONS: '2' })).toThrow(/MAX_UNPAIRED_CONNECTIONS/);
  });

  it('refuses a MAX_CONNECTIONS_PER_SLOT below 1', () => {
    expect(() => loadConfig({ MAX_CONNECTIONS_PER_SLOT: '0' })).toThrow(/MAX_CONNECTIONS_PER_SLOT/);
  });

  it('reads METRICS_ALLOW_UNAUTHENTICATED from the environment, defaulting to closed', () => {
    // The rest of the suite sets this field on a Config object directly, which
    // never exercises the env parsing. Without this, the documented variable
    // could be inert and nothing would notice.
    expect(loadConfig({}).metricsAllowUnauthenticated).toBe(false);
    expect(loadConfig({ METRICS_ALLOW_UNAUTHENTICATED: 'true' }).metricsAllowUnauthenticated).toBe(true);
    expect(loadConfig({ METRICS_ALLOW_UNAUTHENTICATED: 'false' }).metricsAllowUnauthenticated).toBe(false);
    expect(() => loadConfig({ METRICS_ALLOW_UNAUTHENTICATED: 'yes' })).toThrow(/METRICS_ALLOW_UNAUTHENTICATED/);
  });

  it('keeps the shipped slot-id pattern anchored to exactly 32 or 64 lowercase hex', () => {
    // The anti-enumeration guarantee is a property of this default, so pin it.
    const { slotIdPattern } = loadConfig({});
    expect(slotIdPattern.test('a'.repeat(64))).toBe(true);
    expect(slotIdPattern.test('a'.repeat(32))).toBe(true);
    expect(slotIdPattern.test('A'.repeat(64))).toBe(false);
    expect(slotIdPattern.test(`prefix${'a'.repeat(64)}`)).toBe(false);
    expect(slotIdPattern.test(`${'a'.repeat(64)}suffix`)).toBe(false);
    expect(slotIdPattern.test('123456')).toBe(false);
  });
});

describe('admin dashboard and metrics history configuration', () => {
  it('defaults to fully off, so the public image is unaffected', () => {
    const config = loadConfig({});
    expect(config.adminEnabled).toBe(false);
    expect(config.metricsHistoryPath).toBeNull();
    expect(config.metricsHistoryIntervalMs).toBe(60_000);
  });

  it('reads all three variables from the environment', () => {
    const config = loadConfig({
      ADMIN_ENABLED: 'true',
      METRICS_HISTORY_PATH: '/var/lib/relay/history.ndjson',
      METRICS_HISTORY_INTERVAL_MS: '30000',
    });
    expect(config.adminEnabled).toBe(true);
    expect(config.metricsHistoryPath).toBe('/var/lib/relay/history.ndjson');
    expect(config.metricsHistoryIntervalMs).toBe(30_000);
  });

  it('rejects a sampling interval that would spin the event loop', () => {
    // readInt accepts 0, and setInterval(fn, 0) is a hot loop.
    expect(() => loadConfig({ METRICS_HISTORY_INTERVAL_MS: '0' })).toThrow(/METRICS_HISTORY_INTERVAL_MS/);
    expect(() => loadConfig({ METRICS_HISTORY_INTERVAL_MS: '999' })).toThrow(/METRICS_HISTORY_INTERVAL_MS/);
  });

  it('refuses a relative history path, which would write to the ephemeral layer', () => {
    // A relative path resolves against the container cwd, so history would be
    // discarded by the very deploy it is supposed to survive.
    expect(() => loadConfig({ METRICS_HISTORY_PATH: 'history.ndjson' })).toThrow(/METRICS_HISTORY_PATH/);
    expect(() => loadConfig({ METRICS_HISTORY_PATH: './data/history.ndjson' })).toThrow(/METRICS_HISTORY_PATH/);
  });

  it('rejects a non-boolean ADMIN_ENABLED rather than silently disabling', () => {
    expect(() => loadConfig({ ADMIN_ENABLED: 'yes' })).toThrow(/ADMIN_ENABLED/);
  });
});
