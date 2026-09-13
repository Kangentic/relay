import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { createMetrics, handleMetricsRequest, handleMetriczRequest } from '../src/http/metrics.js';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';
import { connectTestClient } from './helpers/wsClient.js';

interface FakeResponse {
  statusCode: number | null;
  body: string | null;
  writeHead(status: number, headers?: Record<string, string>): FakeResponse;
  end(body?: string): void;
}

function fakeResponse(): FakeResponse {
  const response: FakeResponse = {
    statusCode: null,
    body: null,
    writeHead(status: number) {
      response.statusCode = status;
      return response;
    },
    end(body?: string) {
      response.body = body ?? '';
    },
  };
  return response;
}

function requestWith(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage;
}

describe('metrics authorization gate', () => {
  const baseConfig = { metricsEnabled: true, metricsToken: null, metricsAllowUnauthenticated: false };

  it('hides an untokened surface behind 404 by default', () => {
    // Without this, an operator who exposes the relay publishes live pairing
    // gauges and the per-guard reject breakdown to anyone who asks.
    const response = fakeResponse();
    handleMetricsRequest(requestWith(), response as unknown as ServerResponse, createMetrics(), baseConfig);
    expect(response.statusCode).toBe(404);
  });

  it('answers 404 rather than 401 when untokened, so it does not advertise a gated surface', () => {
    const disabled = fakeResponse();
    handleMetricsRequest(
      requestWith(),
      disabled as unknown as ServerResponse,
      createMetrics(),
      { ...baseConfig, metricsEnabled: false },
    );

    const untokened = fakeResponse();
    handleMetricsRequest(requestWith(), untokened as unknown as ServerResponse, createMetrics(), baseConfig);

    expect(untokened.statusCode).toBe(disabled.statusCode);
  });

  it('serves an untokened surface only when explicitly opted in', () => {
    const response = fakeResponse();
    handleMetricsRequest(
      requestWith(),
      response as unknown as ServerResponse,
      createMetrics(),
      { ...baseConfig, metricsAllowUnauthenticated: true },
    );
    expect(response.statusCode).toBe(200);
  });

  it('requires an exact bearer match once a token is configured', () => {
    const config = { ...baseConfig, metricsToken: 'secret-token' };

    const authorized = fakeResponse();
    handleMetricsRequest(
      requestWith('Bearer secret-token'),
      authorized as unknown as ServerResponse,
      createMetrics(),
      config,
    );
    expect(authorized.statusCode).toBe(200);

    for (const header of [undefined, 'Bearer wrong-token', 'secret-token', 'Bearer secret-token-extra']) {
      const rejected = fakeResponse();
      handleMetricsRequest(requestWith(header), rejected as unknown as ServerResponse, createMetrics(), config);
      expect(rejected.statusCode).toBe(401);
    }
  });

  it('ignores the opt-out once a token is configured', () => {
    const response = fakeResponse();
    handleMetricsRequest(
      requestWith(),
      response as unknown as ServerResponse,
      createMetrics(),
      { ...baseConfig, metricsToken: 'secret-token', metricsAllowUnauthenticated: true },
    );
    expect(response.statusCode).toBe(401);
  });

  it('applies the same gate to /metricz', () => {
    const hidden = fakeResponse();
    handleMetriczRequest(requestWith(), hidden as unknown as ServerResponse, createMetrics(), baseConfig);
    expect(hidden.statusCode).toBe(404);

    const served = fakeResponse();
    handleMetriczRequest(
      requestWith(),
      served as unknown as ServerResponse,
      createMetrics(),
      { ...baseConfig, metricsAllowUnauthenticated: true },
    );
    expect(served.statusCode).toBe(200);
  });
});

describe('createMetrics', () => {
  it('moves counters and gauges as connections open, pair, forward, and reject', () => {
    const metrics = createMetrics();
    // The waiting gauge is read from the slot table rather than counted here,
    // so a test drives it by changing what the source says.
    let waiting = { desktop: 0, mobile: 0, unknown: 0 };
    metrics.setWaitingSlotsSource(() => waiting);

    metrics.onConnectionOpened();
    waiting = { desktop: 1, mobile: 0, unknown: 0 };
    expect(metrics.render()).toContain('relay_active_connections 1');
    expect(metrics.render()).toContain('relay_waiting_slots 1');

    metrics.onPair();
    waiting = { desktop: 0, mobile: 0, unknown: 0 };
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

  it('emits all three role series always, so no client input can mint a label', () => {
    // The cardinality bound. Series come from the frozen tuple rather than
    // from whatever roles happened to connect, so the registry cannot grow.
    const metrics = createMetrics();
    metrics.setWaitingSlotsSource(() => ({ desktop: 2, mobile: 0, unknown: 0 }));

    const rendered = metrics.render();
    expect(rendered).toContain('relay_waiting_slots_by_reported_role{role="desktop"} 2');
    expect(rendered).toContain('relay_waiting_slots_by_reported_role{role="mobile"} 0');
    expect(rendered).toContain('relay_waiting_slots_by_reported_role{role="unknown"} 0');
    expect(rendered.match(/relay_waiting_slots_by_reported_role\{/g)).toHaveLength(3);
    // The caveat rides on the wire, because a dashboard panel built on this
    // loses every word of surrounding documentation.
    expect(rendered).toContain('# HELP relay_waiting_slots_by_reported_role');
    expect(rendered).toContain('never verified');
    // The unlabelled total stays, so anything reading it today keeps working.
    expect(rendered).toContain('relay_waiting_slots 2');
  });

  it('never renders a slot id, only aggregate counts', () => {
    const metrics = createMetrics();
    metrics.onReject('slot_busy');
    const rendered = metrics.render();
    expect(rendered).not.toMatch(/[0-9a-f]{64}/);
  });

  it('counts peer-closed teardowns and exposes them in render and snapshot', () => {
    const metrics = createMetrics();
    metrics.onPeerClosed();
    metrics.onPeerClosed();
    expect(metrics.render()).toContain('relay_peer_closed_total 2');
    expect(metrics.snapshot().peerClosedTotal).toBe(2);
  });

  it('snapshot mirrors every counter the Prometheus surface renders', () => {
    const metrics = createMetrics();
    metrics.setWaitingSlotsSource(() => ({ desktop: 1, mobile: 0, unknown: 0 }));
    metrics.onConnectionOpened();
    metrics.onPair();
    metrics.onForward(64);
    metrics.onReject('backpressure');
    metrics.onPongTimeout();

    const snapshot = metrics.snapshot();
    expect(snapshot.activeConnections).toBe(1);
    expect(snapshot.waitingSlots).toBe(1);
    expect(snapshot.waitingSlotsByRole).toEqual({ desktop: 1, mobile: 0, unknown: 0 });
    expect(snapshot.pairedSlots).toBe(1);
    expect(snapshot.connectionsTotal).toBe(1);
    expect(snapshot.sessionsTotal).toBe(1);
    expect(snapshot.framesForwardedTotal).toBe(1);
    expect(snapshot.bytesForwardedTotal).toBe(64);
    expect(snapshot.pongTimeoutsTotal).toBe(1);
    expect(snapshot.rejectsByReason.backpressure).toBe(1);
  });
});

describe('GET /metrics over the live server', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('serves Prometheus text with live counters after a pairing', async () => {
    relay = await startTestRelay({ metricsAllowUnauthenticated: true });
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

describe('GET /metricz over the live server', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('serves a JSON snapshot with process memory and closed-by-cause counters', async () => {
    relay = await startTestRelay({ metricsAllowUnauthenticated: true });
    const slot = 'c'.repeat(64);
    const a = await connectTestClient(relay.url, slot);
    const b = await connectTestClient(relay.url, slot);
    a.send(Buffer.from('hi'));
    await b.nextMessage();

    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/metricz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const bodyText = await response.text();
    expect(bodyText).not.toContain(slot);

    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body['activeConnections']).toBe(2);
    expect(body['pairedSlots']).toBe(1);
    expect(body['framesForwardedTotal']).toBe(1);
    expect(body['bytesForwardedTotal']).toBe(2);
    expect(typeof body['rssBytes']).toBe('number');
    expect(typeof body['uptimeSeconds']).toBe('number');
    expect(body['closedByCause']).toMatchObject({
      peerClosed: 0,
      backpressure: 0,
      parkedOverflow: 0,
      heartbeat: 0,
      parkTimeout: 0,
    });

    a.close();
    const closeAtB = await b.nextClose();
    expect(closeAtB.code).toBe(4000);

    const afterClose = await fetch(`${relay.url.replace('ws://', 'http://')}/metricz`);
    const afterBody = (await afterClose.json()) as { closedByCause: { peerClosed: number } };
    expect(afterBody.closedByCause.peerClosed).toBe(1);
  });

  it('attributes a parked peer to the role it sent on the URL, all the way to the wire', async () => {
    // The one path nothing else covers. Every other role assertion drives the
    // slot table directly and hands createConn a role, so it would still pass
    // if server.ts read the wrong query key or passed a constant. This dials a
    // real socket and reads the number back off the HTTP surfaces, which is
    // what a client and a scraper actually see.
    relay = await startTestRelay({ metricsAllowUnauthenticated: true });
    const desktop = await connectTestClient(relay.url, 'a'.repeat(64), 'desktop');
    const mobile = await connectTestClient(relay.url, 'b'.repeat(64), 'mobile');
    // Sent nothing at all, exactly like every client that predates the
    // parameter, plus one that sent something this relay has never heard of.
    const silent = await connectTestClient(relay.url, 'c'.repeat(64));
    const bogus = await connectTestClient(relay.url, 'd'.repeat(64), 'toaster');

    expect(relay.metrics.snapshot().waitingSlotsByRole).toEqual({ desktop: 1, mobile: 1, unknown: 2 });

    const httpBase = relay.url.replace('ws://', 'http://');
    const metriczBody = (await (await fetch(`${httpBase}/metricz`)).json()) as Record<string, unknown>;
    // /metricz is the machine surface monitor.yml and loadTest.mjs consume, so
    // the split has to be on it and not only on /admin/data.
    expect(metriczBody['waitingSlotsByRole']).toEqual({ desktop: 1, mobile: 1, unknown: 2 });
    expect(metriczBody['waitingSlots']).toBe(4);

    const prometheusText = await (await fetch(`${httpBase}/metrics`)).text();
    expect(prometheusText).toContain('relay_waiting_slots_by_reported_role{role="desktop"} 1');
    expect(prometheusText).toContain('relay_waiting_slots_by_reported_role{role="mobile"} 1');
    expect(prometheusText).toContain('relay_waiting_slots_by_reported_role{role="unknown"} 2');
    // The client's raw string never reaches the label set, which is the whole
    // cardinality bound.
    expect(prometheusText).not.toContain('toaster');

    desktop.close();
    mobile.close();
    silent.close();
    bogus.close();
  });

  it('honors METRICS_ENABLED and METRICS_TOKEN exactly like /metrics', async () => {
    relay = await startTestRelay({ metricsToken: 'secret-token' });
    const unauthorized = await fetch(`${relay.url.replace('ws://', 'http://')}/metricz`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${relay.url.replace('ws://', 'http://')}/metricz`, {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(authorized.status).toBe(200);

    await relay.close();
    relay = await startTestRelay({ metricsEnabled: false });
    const disabled = await fetch(`${relay.url.replace('ws://', 'http://')}/metricz`);
    expect(disabled.status).toBe(404);
  });

  it('reports lifetime CPU with no recorder running, and costs nothing to do so', async () => {
    relay = await startTestRelay({ metricsAllowUnauthenticated: true });
    const body = (await (await fetch(`${relay.url.replace('ws://', 'http://')}/metricz`)).json()) as Record<
      string,
      unknown
    >;

    // process.cpuUsage() is cumulative, so this needs no background sampler.
    expect(typeof body['cpuPercent']).toBe('number');
    // Null window means the figure covers the whole process lifetime.
    expect(body['cpuPercentWindowMs']).toBeNull();
    // The event loop delay monitor installs a recurring libuv timer, so it is
    // only built when the recorder is, keeping "off" genuinely free.
    expect(body['eventLoopLagP99Ms']).toBeNull();
    expect(body['rssPercent']).toBeNull();
  });

  it('reports sampled process health once a recorder is running', async () => {
    relay = await startTestRelay({
      metricsAllowUnauthenticated: true,
      adminEnabled: true,
      metricsHistoryIntervalMs: 1_000,
    });
    const body = (await (await fetch(`${relay.url.replace('ws://', 'http://')}/metricz`)).json()) as Record<
      string,
      unknown
    >;

    expect(body['historyRecorderHealthy']).toBe(true);
    expect(body['historyPersistence']).toBe('memory');
  });
});
