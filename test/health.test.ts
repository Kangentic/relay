import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleReadyzRequest } from '../src/http/health.js';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';

function fakeResponse(): { response: ServerResponse; statusCode: () => number | undefined } {
  let capturedStatus: number | undefined;
  const response = {
    writeHead: vi.fn((status: number) => {
      capturedStatus = status;
      return response;
    }),
    end: vi.fn(),
  } as unknown as ServerResponse;
  return { response, statusCode: () => capturedStatus };
}

describe('health endpoints', () => {
  let relay: RelayHarness | undefined;

  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('GET /healthz is always 200 while the process is alive', async () => {
    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET /readyz is 200 before shutdown begins', async () => {
    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/readyz`);
    expect(response.status).toBe(200);
  });

  it('an unknown path is 404', async () => {
    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/unknown`);
    expect(response.status).toBe(404);
  });
});

describe('handleReadyzRequest', () => {
  it('reports 503 once the health state flips to draining', () => {
    const { response, statusCode } = fakeResponse();
    handleReadyzRequest({} as IncomingMessage, response, { draining: true });
    expect(statusCode()).toBe(503);
  });

  it('reports 200 while not draining', () => {
    const { response, statusCode } = fakeResponse();
    handleReadyzRequest({} as IncomingMessage, response, { draining: false });
    expect(statusCode()).toBe(200);
  });
});
