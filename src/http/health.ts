import type { IncomingMessage, ServerResponse } from 'node:http';

export interface HealthState {
  draining: boolean;
}

export function handleHealthzRequest(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
}

export function handleReadyzRequest(_request: IncomingMessage, response: ServerResponse, health: HealthState): void {
  if (health.draining) {
    response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'draining' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ready' }));
}
