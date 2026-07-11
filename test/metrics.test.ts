import { describe, it, expect, afterEach } from 'vitest';
import { createMetrics } from '../src/http/metrics.js';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';

describe('createMetrics', () => {
  it('moves counters and gauges as connections open, pair, forward, and reject', () => {
    const metrics = createMetrics();

    metrics.onConnectionOpened();
    metrics.waitingSlots.increment();
    expect(metrics.render()).toContain('relay_active_connections 1');
    expect(metrics.render()).toContain('relay_waiting_slots 1');

    metrics.onPair();
    metrics.waitingSlots.decrement();
    expect(metrics.render()).toContain('relay_paired_slots 1');
    expect(metrics.render()).toContain('relay_waiting_slots 0');

    metrics.onForward(128);
    expect(metrics.render()).toContain('relay_messages_forwarded_total 1');
    expect(metrics.render()).toContain('relay_bytes_forwarded_total 128');

    metrics.onReject('slot_busy');
    expect(metrics.render()).toContain('relay_rejects_total{reason="slot_busy"} 1');

    metrics.onPongTimeout();
    expect(metrics.render()).toContain('relay_pong_timeouts_total 1');

    metrics.onUnpair();
    metrics.onConnectionClosed();
    expect(metrics.render()).toContain('relay_paired_slots 0');
    expect(metrics.render()).toContain('relay_active_connections 0');
  });

  it('never renders a slot id, only aggregate counts', () => {
    const metrics = createMetrics();
    metrics.onReject('slot_busy');
    const rendered = metrics.render();
    expect(rendered).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('GET /metrics over the live server', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('serves Prometheus text with live counters after a pairing', async () => {
    relay = await startTestRelay();
    const slot = 'b'.repeat(64);
    const a = await connectTestClient(relay.url, slot);
    const b = await connectTestClient(relay.url, slot);
    a.send(Buffer.from('hi'));
    await b.nextMessage();

    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/metrics`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('relay_paired_slots 1');
    expect(body).toContain('relay_messages_forwarded_total 1');
    expect(body).not.toContain(slot);

    a.close();
    b.close();
  });

  it('returns 404 when METRICS_ENABLED is false', async () => {
    relay = await startTestRelay({ metricsEnabled: false });
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/metrics`);
    expect(response.status).toBe(404);
  });

  it('requires the bearer token when METRICS_TOKEN is set', async () => {
    relay = await startTestRelay({ metricsToken: 'secret-token' });
    const unauthorized = await fetch(`${relay.url.replace('ws://', 'http://')}/metrics`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${relay.url.replace('ws://', 'http://')}/metrics`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(authorized.status).toBe(200);
  });
});
