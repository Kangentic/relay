import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config, Conn } from './types.js';
import { createLogger, type Logger } from './logging.js';
import { createMetrics, handleMetricsRequest, handleMetriczRequest, type Metrics } from './http/metrics.js';
import { handleHealthzRequest, handleReadyzRequest, type HealthState } from './http/health.js';
import { resolveClientIp, bucketIp } from './net/clientIp.js';
import { isValidSlotId } from './guards/slotFormat.js';
import { RateLimiter } from './guards/rateLimit.js';
import { ConnectionCaps, SlotConnectionCaps } from './guards/caps.js';
import { allowAllPolicy, type AdmissionPolicy } from './admission.js';
import { SlotTable } from './rendezvous.js';
import { attachConnectionHandlers, createConn } from './connection.js';
import { startKeepalive } from './keepalive.js';

export interface RelayDeps {
  readonly admissionPolicy?: AdmissionPolicy;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

export interface Relay {
  readonly httpServer: HttpServer;
  readonly metrics: Metrics;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

function destroySocket(socket: Socket, statusCode: number): void {
  const statusText = STATUS_TEXT[statusCode] ?? 'Error';
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  }
  socket.destroy();
}

/**
 * Builds the relay: one HTTP server handles /healthz, /readyz, /metrics,
 * and the WebSocket upgrade. All admission work (slot format, rate limits,
 * connection caps, the pluggable AdmissionPolicy) happens during the async
 * 'upgrade' handler; the rendezvous decision itself is synchronous inside
 * SlotTable.handleConnection, called from the 'connection' event.
 */
export function createRelay(config: Config, deps: RelayDeps = {}): Relay {
  const logger = deps.logger ?? createLogger(config);
  const metrics = deps.metrics ?? createMetrics();
  const admissionPolicy = deps.admissionPolicy ?? allowAllPolicy;

  const connectionCaps = new ConnectionCaps(config.maxConnections, config.maxConnectionsPerIp);
  const slotConnectionCaps = new SlotConnectionCaps(config.maxConnectionsPerSlot);
  const ipRateLimiter = new RateLimiter(config.rateLimitIpPerMinute, config.rateLimitIpBurst);
  const slotRateLimiter = new RateLimiter(config.rateLimitSlotPerMinute, config.rateLimitSlotBurst);

  const slotTable = new SlotTable({
    slotCaps: slotConnectionCaps,
    metrics,
    logger,
    parkTimeoutMs: config.parkTimeoutMs,
    maxSessionMs: config.maxSessionMs,
  });

  const liveConnections = new Set<Conn>();
  const health: HealthState = { draining: false };

  function handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      handleHealthzRequest(request, response);
      return;
    }
    if (url.pathname === '/readyz') {
      handleReadyzRequest(request, response, health);
      return;
    }
    if (url.pathname === '/metrics') {
      handleMetricsRequest(request, response, metrics, config);
      return;
    }
    if (url.pathname === '/metricz') {
      handleMetriczRequest(request, response, metrics, config);
      return;
    }
    response.writeHead(404).end();
  }

  const httpServer = createServer(handleHttpRequest);
  // permessage-deflate is explicitly disabled (not just left to the `ws`
  // default): every frame this relay carries is ciphertext, which is
  // incompressible, so compression would burn CPU per frame, add latency,
  // and pin a zlib context's worth of memory to every connection for zero
  // byte savings. Frames pass through byte-for-byte, uncompressed.
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes, perMessageDeflate: false });

  function onWebSocketConnection(ws: WebSocket, slotId: string, ip: string, releaseCapReservation: () => void): void {
    const conn = createConn(ws, slotId, ip);
    liveConnections.add(conn);

    attachConnectionHandlers(conn, {
      slotTable,
      metrics,
      logger,
      config,
      onClosed: () => {
        releaseCapReservation();
        liveConnections.delete(conn);
      },
    });

    slotTable.handleConnection(conn);
  }

  async function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== config.wsPath) {
      destroySocket(socket, 404);
      return;
    }

    const slotId = url.searchParams.get('slot') ?? '';
    if (!isValidSlotId(slotId, config.slotIdPattern)) {
      metrics.onReject('slot_format');
      destroySocket(socket, 400);
      return;
    }

    const ip = resolveClientIp(request.headers, request.socket.remoteAddress, config);
    const ipBucket = bucketIp(ip, config.ipv6PrefixBits);

    if (!ipRateLimiter.tryConsume(ipBucket)) {
      metrics.onReject('rate_limit_ip');
      destroySocket(socket, 429);
      return;
    }
    if (!slotRateLimiter.tryConsume(slotId)) {
      metrics.onReject('rate_limit_slot');
      destroySocket(socket, 429);
      return;
    }

    const reservation = connectionCaps.reserve(ipBucket);
    if (!reservation.ok) {
      metrics.onReject(reservation.reason);
      destroySocket(socket, 503);
      return;
    }

    if (health.draining) {
      reservation.release();
      metrics.onReject('shutting_down');
      destroySocket(socket, 503);
      return;
    }

    const decision = await admissionPolicy.admit({
      ip,
      slotId,
      headers: request.headers,
      rawUrl: request.url ?? '',
      connectedAt: Date.now(),
    });

    if (health.draining) {
      reservation.release();
      metrics.onReject('shutting_down');
      destroySocket(socket, 503);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      if (!decision.allow) {
        metrics.onReject('admission');
        ws.close(decision.closeCode, decision.reason);
        reservation.release();
        return;
      }
      onWebSocketConnection(ws, slotId, ip, reservation.release);
    });
  }

  httpServer.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket as Socket, head).catch((error: unknown) => {
      logger.error('upgrade handler failed', { error: error instanceof Error ? error.message : String(error) });
      destroySocket(socket as Socket, 503);
    });
  });

  const keepalive = startKeepalive(liveConnections, { metrics, pingIntervalMs: config.pingIntervalMs });

  return {
    httpServer,
    metrics,
    listen: () =>
      new Promise((resolve) => {
        httpServer.listen(config.port, config.bindAddress, () => {
          const address = httpServer.address();
          const port = typeof address === 'object' && address ? address.port : config.port;
          logger.info('relay listening', { port, bindAddress: config.bindAddress });
          resolve({ port });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        health.draining = true;
        keepalive.stop();

        for (const conn of liveConnections) {
          if (conn.socket.readyState === conn.socket.OPEN) conn.socket.close(1001, 'shutting_down');
        }

        const forceTimer = setTimeout(() => {
          for (const conn of liveConnections) conn.socket.terminate();
        }, config.shutdownGraceMs);
        forceTimer.unref?.();

        wss.close(() => {
          httpServer.close((error) => {
            clearTimeout(forceTimer);
            if (error) reject(error);
            else resolve();
          });
        });
      }),
  };
}
