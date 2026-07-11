import { describe, it, expect, vi, afterEach } from 'vitest';
import { allowAllPolicy, createWebhookAdmissionPolicy, type AdmissionContext } from '../src/admission.js';
import { CLOSE_CODE } from '../src/closeCodes.js';
import { createLogger } from '../src/logging.js';

const baseContext: AdmissionContext = {
  ip: '203.0.113.1',
  slotId: 'a'.repeat(64),
  headers: {},
  rawUrl: '/?slot=' + 'a'.repeat(64),
  connectedAt: 0,
};

const silentLogger = createLogger({ logLevel: 'error', logSlotHashing: true, slotLogSalt: 'test-salt' });

describe('allowAllPolicy', () => {
  it('admits every connection', async () => {
    const decision = await allowAllPolicy.admit(baseContext);
    expect(decision.allow).toBe(true);
  });

  it('never touches the socket, payload, or frame contents (context is metadata-only)', () => {
    const keys = Object.keys(baseContext);
    expect(keys).toEqual(['ip', 'slotId', 'headers', 'rawUrl', 'connectedAt']);
  });
});

describe('createWebhookAdmissionPolicy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to allow-all when no webhook URL is configured', async () => {
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: null, admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(true);
  });

  it('denies with the webhook-provided close code and reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ allow: false, reason: 'no_entitlement' }),
      }),
    );
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.closeCode).toBe(CLOSE_CODE.ADMISSION_DENIED);
      expect(decision.reason).toBe('no_entitlement');
    }
  });

  it('allows when the webhook approves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allow: true }) }),
    );
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(true);
  });

  it('fails open when the webhook errors and admissionFailOpen is true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(true);
  });

  it('fails closed when the webhook errors and admissionFailOpen is false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: false },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(false);
  });

  it('sends only connection metadata in the webhook request body, never frame data', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allow: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    await policy.admit(baseContext);

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(requestInit.body as string) as Record<string, unknown>;
    expect(Object.keys(sentBody).sort()).toEqual(['connectedAt', 'ip', 'rawUrl', 'slotId']);
  });
});
