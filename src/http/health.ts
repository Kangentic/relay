import type { IncomingMessage, ServerResponse } from 'node:http';
import { RELAY_VERSION } from '../version.js';

export interface HealthState {
  draining: boolean;
}

/**
 * Serialized once at module load, the way `landing.ts` precomputes its page. `JSON.stringify` is
 * called with no spacing argument, and that is the load-bearing part: it keeps key and value
 * adjacent so the body carries the contiguous substring `"status":"ok"` that
 * `scripts/deploy/deploy.sh`'s health gate and the external uptime monitor both match on. Key
 * *order* does not affect that substring, so appending fields stays safe; passing a spacing
 * argument, renaming `status`, or switching a consumer to whole-body equality does not.
 *
 * `version` is dropped entirely when it could not be resolved, so a client sees a real version or
 * no field at all, never a sentinel it would render verbatim.
 */
const HEALTHZ_BODY_JSON = JSON.stringify({ status: 'ok', version: RELAY_VERSION });

export function handleHealthzRequest(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'application/json' }).end(HEALTHZ_BODY_JSON);
}

export function handleReadyzRequest(_request: IncomingMessage, response: ServerResponse, health: HealthState): void {
  if (health.draining) {
    response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'draining' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ready' }));
}
