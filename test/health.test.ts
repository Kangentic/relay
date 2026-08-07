import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleReadyzRequest } from '../src/http/health.js';
import { startTestRelay, type RelayHarness } from './helpers/relayHarness.js';

function fakeResponse(): {
  response: ServerResponse;
  statusCode: () => number | undefined;
  body: () => string | undefined;
} {
  let capturedStatus: number | undefined;
  let capturedBody: string | undefined;
  const response = {
    writeHead: vi.fn((status: number) => {
      capturedStatus = status;
      return response;
    }),
    end: vi.fn((chunk?: string) => {
      capturedBody = chunk;
      return response;
    }),
  } as unknown as ServerResponse;
  return { response, statusCode: () => capturedStatus, body: () => capturedBody };
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

  it('GET /healthz reports the running build version, read from package.json', async () => {
    // Read the manifest independently rather than importing RELAY_VERSION, so an unresolvable
    // version cannot make this assertion pass by matching undefined against a missing key. The two
    // assertions before the fetch are that tautology guard.
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const { version: manifestVersion } = manifest as { version?: unknown };
    expect(typeof manifestVersion).toBe('string');
    expect(manifestVersion).not.toBe('');

    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/healthz`);
    const body = (await response.json()) as { status: string; version?: string };
    expect(body.status).toBe('ok');
    expect(body.version).toBe(manifestVersion);
  });

  it('GET /healthz keeps the exact "status":"ok" substring the deploy gate greps for', async () => {
    // scripts/deploy/deploy.sh's health gate runs every production deploy through
    // `grep -q '"status":"ok"'`, and the external uptime monitor matches the body too. The
    // substring has to survive verbatim: no pretty-printing, no space argument to JSON.stringify,
    // no key rename, nothing that splits the key from its value. Asserted on the raw text, not on
    // parsed JSON, because parsing is exactly what would hide a formatting regression.
    relay = await startTestRelay();
    const response = await fetch(`${relay.url.replace('ws://', 'http://')}/healthz`);
    expect(await response.text()).toContain('"status":"ok"');
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

// Last describe in the file on purpose: it swaps out a module the blocks above import, so it runs
// after every test that wants the real one.
describe('handleHealthzRequest when the version cannot be resolved', () => {
  afterEach(() => {
    vi.doUnmock('../src/version.js');
    vi.resetModules();
  });

  it('omits the version key entirely rather than publishing a sentinel', async () => {
    // README and CHANGELOG both promise omission over a faked value, and every other test in this
    // repo runs against a package.json that resolves fine, so this branch is otherwise dead. The
    // body is frozen into a module-level constant at import, so reaching it means re-importing
    // health.js with the version module mocked. Asserted on the exact raw string, because
    // `version: null` and `version: "unknown"` regressions both survive a parsed-object check for
    // `status`.
    vi.resetModules();
    vi.doMock('../src/version.js', () => ({ RELAY_VERSION: undefined }));
    const { handleHealthzRequest } = await import('../src/http/health.js');

    const { response, statusCode, body } = fakeResponse();
    handleHealthzRequest({} as IncomingMessage, response);

    expect(statusCode()).toBe(200);
    expect(body()).toBe('{"status":"ok"}');
  });
});
