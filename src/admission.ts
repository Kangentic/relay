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
        if (!response.ok) {
          throw new Error(`admission webhook returned HTTP ${response.status}`);
        }
        const body: unknown = await response.json();
        if (!isWebhookAdmissionResponseBody(body)) {
          throw new Error('admission webhook returned a malformed body');
        }
        if (body.allow) return { allow: true };
        return { allow: false, closeCode: CLOSE_CODE.ADMISSION_DENIED, reason: body.reason ?? 'denied' };
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
