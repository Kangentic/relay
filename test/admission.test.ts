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

  it('treats a 4xx as an explicit deny even when admissionFailOpen is true', async () => {
    // A control plane that denies the natural REST way must not be turned into
    // an admit by the fail-open policy: 4xx is the gate speaking, not failing.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
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

  it('still denies on a 4xx whose body is unreadable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => {
          throw new Error('not json');
        },
      }),
    );
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('denied');
  });

  it('fails open on a 5xx, which is the control plane being unavailable rather than deciding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(true);
  });

  it('fails closed on a 5xx when admissionFailOpen is false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: false },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('admission_unavailable');
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

  it('aborts a webhook that exceeds ADMISSION_WEBHOOK_TIMEOUT_MS and applies the fail-open policy', async () => {
    // The timeout is the difference between a wedged control plane degrading
    // gracefully and it hanging every upgrade, so exercise the real
    // AbortController path rather than a plain rejection.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }),
      ),
    );

    const failOpen = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 5, admissionFailOpen: true },
      silentLogger,
    );
    expect((await failOpen.admit(baseContext)).allow).toBe(true);

    const failClosed = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 5, admissionFailOpen: false },
      silentLogger,
    );
    const decision = await failClosed.admit(baseContext);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('admission_unavailable');
  });

  it('does not leave the timeout timer armed after a fast webhook reply', async () => {
    // A leaked per-request timer would keep the event loop busy under load.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allow: true }) }));
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );

    await policy.admit(baseContext);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('degrades a deny reason too long for a close frame to the generic constant', async () => {
    // A close frame caps its reason at 123 UTF-8 bytes and ws throws
    // synchronously past that, which would abort the upgrade callback
    // mid-teardown. A control-plane reason is best-effort display text, so an
    // oversized one has to degrade rather than become a crash.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allow: false, reason: 'x'.repeat(124) }) }),
    );
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('denied');
  });

  it('keeps a deny reason sitting exactly on the 123-byte limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allow: false, reason: 'y'.repeat(123) }) }),
    );
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('y'.repeat(123));
  });

  it('measures the deny reason in UTF-8 bytes, not characters', async () => {
    // 42 three-byte characters is 126 bytes but only 42 characters, so a
    // character-length check would wave this through and ws would then throw
    // on the very close frame the deny needs to send.
    const multiByteReason = '€'.repeat(42);
    expect(multiByteReason.length).toBeLessThan(123);
    expect(Buffer.byteLength(multiByteReason, 'utf8')).toBeGreaterThan(123);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allow: false, reason: multiByteReason }) }),
    );
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('denied');
  });

  it('degrades an over-long reason on the 4xx path as well', async () => {
    // The 4xx branch builds its reason through readDenyReason(), a separate
    // call site from the allow:false body, so it needs its own clamp.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ allow: false, reason: 'z'.repeat(200) }),
      }),
    );
    const policy = createWebhookAdmissionPolicy(
      { admissionWebhookUrl: 'https://control-plane.example/admit', admissionWebhookTimeoutMs: 1000, admissionFailOpen: true },
      silentLogger,
    );
    const decision = await policy.admit(baseContext);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('denied');
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
