import type { IncomingHttpHeaders } from 'node:http';
import { CLOSE_CODE } from './closeCodes.js';
import type { Config } from './types.js';
import type { Logger } from './logging.js';

/**
 * Everything an admission policy is allowed to see: connection-level
 * metadata only. There is deliberately no socket, frame, or payload access
 * here, so an entitlement gate can decide WHETHER a device may use this
 * relay instance without ever being able to read what flows through it.
 */
export interface AdmissionContext {
  readonly ip: string;
  readonly slotId: string;
  readonly headers: IncomingHttpHeaders;
  readonly rawUrl: string;
  readonly connectedAt: number;
}

export type AdmissionDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly closeCode: number; readonly reason: string };

export interface AdmissionPolicy {
  admit(context: AdmissionContext): AdmissionDecision | Promise<AdmissionDecision>;
}

/** The v1 default: free and accountless, every connection is admitted. */
export const allowAllPolicy: AdmissionPolicy = {
  admit: () => ({ allow: true }),
};

interface WebhookAdmissionResponseBody {
  readonly allow: boolean;
  readonly reason?: string;
}

function isWebhookAdmissionResponseBody(value: unknown): value is WebhookAdmissionResponseBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['allow'] === 'boolean';
}

/**
 * A WebSocket close frame caps its reason text at 123 UTF-8 bytes, and `ws`
 * throws synchronously on anything longer, which would abort the upgrade
 * callback mid-teardown. A control-plane reason is best-effort display text,
 * so an oversized one degrades to the generic constant instead.
 */
const MAX_CLOSE_REASON_BYTES = 123;

function clampDenyReason(reason: string): string {
  return Buffer.byteLength(reason, 'utf8') > MAX_CLOSE_REASON_BYTES ? 'denied' : reason;
}

/**
 * Best-effort reason for a 4xx deny. Deliberately swallows every parse
 * failure: a 4xx is already an explicit deny, and letting a malformed body
 * throw here would route it into the fail-open catch and turn the deny into
 * an admit.
 */
async function readDenyReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const reason = (body as Record<string, unknown>)['reason'];
      if (typeof reason === 'string' && reason.length > 0) return clampDenyReason(reason);
    }
  } catch {
    // No readable JSON body; the status alone is the decision.
  }
  return 'denied';
}

/**
 * Because this relay is AGPL-3.0-only, a private control plane must not
 * link it in-process (that would pull the control plane under AGPL). This
 * policy is the out-of-process seam instead: it POSTs the AdmissionContext
 * (never frame data) to ADMISSION_WEBHOOK_URL and honors the allow/deny
 * response. The relay artifact itself stays unmodified and fully open; a
 * separate, private service implements the endpoint.
 */
export function createWebhookAdmissionPolicy(
  config: Pick<Config, 'admissionWebhookUrl' | 'admissionWebhookTimeoutMs' | 'admissionFailOpen'>,
  logger: Logger,
): AdmissionPolicy {
  const webhookUrl = config.admissionWebhookUrl;
  if (!webhookUrl) return allowAllPolicy;

  return {
    async admit(context: AdmissionContext): Promise<AdmissionDecision> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.admissionWebhookTimeoutMs);
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ip: context.ip,
            slotId: context.slotId,
            rawUrl: context.rawUrl,
            connectedAt: context.connectedAt,
          }),
          signal: controller.signal,
        });
        // A 4xx is the control plane speaking, not the control plane failing.
        // It must deny even under ADMISSION_FAIL_OPEN, so that a gate written
        // the natural REST way (403 with {"allow": false}) does not silently
        // admit everyone. Only 5xx, timeouts, and network errors count as
        // "unavailable" and fall through to the fail-open policy below.
        if (response.status >= 400 && response.status < 500) {
          return { allow: false, closeCode: CLOSE_CODE.ADMISSION_DENIED, reason: await readDenyReason(response) };
        }
        if (!response.ok) {
          throw new Error(`admission webhook returned HTTP ${response.status}`);
        }
        const body: unknown = await response.json();
        if (!isWebhookAdmissionResponseBody(body)) {
          throw new Error('admission webhook returned a malformed body');
        }
        if (body.allow) return { allow: true };
        return { allow: false, closeCode: CLOSE_CODE.ADMISSION_DENIED, reason: clampDenyReason(body.reason ?? 'denied') };
      } catch (error) {
        logger.warn('admission webhook call failed', {
          error: error instanceof Error ? error.message : String(error),
          failOpen: config.admissionFailOpen,
        });
        if (config.admissionFailOpen) return { allow: true };
        return { allow: false, closeCode: CLOSE_CODE.ADMISSION_DENIED, reason: 'admission_unavailable' };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
