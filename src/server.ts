import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config, Conn } from './types.js';
import { createLogger, type Logger } from './logging.js';
import {
  createMetrics,
  handleMetricsRequest,
  handleMetriczRequest,
  type Metrics,
  type MetricsProcessExtras,
} from './http/metrics.js';
import { handleHealthzRequest, handleReadyzRequest, type HealthState } from './http/health.js';
import { handleLandingRequest } from './http/landing.js';
import { handleAdminDataRequest, handleAdminPageRequest } from './http/admin.js';
import { createHistoryRecorder, type HistoryRecorder } from './history/recorder.js';
import type { ConnectionSample } from './history/rows.js';
import { resolveClientIp, bucketIp } from './net/clientIp.js';
import { isValidSlotId } from './guards/slotFormat.js';
import { RateLimiter } from './guards/rateLimit.js';
import { ConnectionCaps, SlotConnectionCaps, UnpairedConnectionCap } from './guards/caps.js';
import { allowAllPolicy, type AdmissionDecision, type AdmissionPolicy } from './admission.js';
import { SlotTable } from './rendezvous.js';
import { attachConnectionHandlers, createConn } from './connection.js';
import { startKeepalive } from './keepalive.js';

export interface RelayDeps {
  readonly admissionPolicy?: AdmissionPolicy;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly historyRecorder?: HistoryRecorder;
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
 * /metricz, a static splash page at /, and the WebSocket upgrade. All
 * admission work (slot format, rate limits, connection caps, the pluggable
 * AdmissionPolicy) happens during the async 'upgrade' handler; the
 * rendezvous decision itself is synchronous inside SlotTable.handleConnection,
 * called from the 'connection' event.
 */
export function createRelay(config: Config, deps: RelayDeps = {}): Relay {
  const logger = deps.logger ?? createLogger(config);
  const metrics = deps.metrics ?? createMetrics();
  const admissionPolicy = deps.admissionPolicy ?? allowAllPolicy;

  const connectionCaps = new ConnectionCaps(config.maxConnections, config.maxConnectionsPerIp);
  const slotConnectionCaps = new SlotConnectionCaps(config.maxConnectionsPerSlot);
  const unpairedConnectionCap = new UnpairedConnectionCap(config.maxUnpairedConnections);
  const ipRateLimiter = new RateLimiter(config.rateLimitIpPerMinute, config.rateLimitIpBurst);
  const slotRateLimiter = new RateLimiter(config.rateLimitSlotPerMinute, config.rateLimitSlotBurst);

  const slotTable = new SlotTable({
    slotCaps: slotConnectionCaps,
    unpairedCap: unpairedConnectionCap,
    metrics,
    logger,
    parkTimeoutMs: config.parkTimeoutMs,
    contentionProbeTimeoutMs: config.contentionProbeTimeoutMs,
    maxSessionMs: config.maxSessionMs,
    maxSessionBytes: config.maxSessionBytes,
    maxBufferedBytes: config.maxBufferedBytes,
  });

  const liveConnections = new Set<Conn>();
  const health: HealthState = { draining: false };

  /**
   * The relay's only latency-shaped signal. A socket's bufferedAmount is what
   * the kernel and ws have accepted but not yet flushed to that peer, so a
   * growing queue means that consumer is behind and every byte behind it is
   * waiting. Timestamping frames would answer this precisely and would also
   * put work in the forwarding hot path; this reads the same story once per
   * recorder tick for O(connections) and nothing per frame.
   */
  const backlogThresholdBytes = Math.max(1, Math.floor(config.maxBufferedBytes / 4));
  function sampleConnections(): ConnectionSample {
    let maxOutboundBufferBytes = 0;
    let backloggedConnections = 0;
    let maxParkedBufferBytes = 0;
    for (const conn of liveConnections) {
      const buffered = conn.socket.bufferedAmount;
      if (buffered > maxOutboundBufferBytes) maxOutboundBufferBytes = buffered;
      // A quarter of the teardown cap: far enough along to mean something, far
      // enough from the cap to still be a warning rather than a postmortem.
      if (buffered >= backlogThresholdBytes) backloggedConnections += 1;
      if (conn.pendingBytes > maxParkedBufferBytes) maxParkedBufferBytes = conn.pendingBytes;
    }
    return { maxOutboundBufferBytes, backloggedConnections, maxParkedBufferBytes };
  }

  // Null when neither the dashboard nor the history store is asked for, which
  // is the default. A null recorder is the structural proof of "no timer, no
  // file handle, no route" - nothing here is flag-checked at runtime.
  const historyRecorder: HistoryRecorder | null =
    deps.historyRecorder ??
    (config.adminEnabled || config.metricsHistoryPath !== null
      ? createHistoryRecorder({
          metrics,
          logger,
          historyFilePath: config.metricsHistoryPath,
          intervalMs: config.metricsHistoryIntervalMs,
          sampleConnections,
        })
      : null);

  if (config.adminEnabled) {
    // The relay does not authenticate /admin, by design: it stays a blind
    // relay that authenticates nothing, and the gate belongs upstream. Said
    // out loud at startup so no operator enables this without noticing.
    logger.warn('admin dashboard enabled and NOT authenticated by the relay', {
      path: '/admin',
      gateItUpstream: 'Cloudflare Access, a private network, or an SSH tunnel',
    });
  }

  function processExtras(): MetricsProcessExtras | null {
    // Null only when there is no recorder at all, so the extra keys appearing
    // on /metricz is itself the signal that one is running. Recorder health is
    // reportable immediately; the sampled values fill in on the first tick.
    if (historyRecorder === null) return null;
    const sample = historyRecorder.latestProcessSample();
    return {
      cpuPercent: sample?.cpuPercent ?? null,
      sampleWindowMs: sample?.windowMs ?? null,
      eventLoopLagP99Ms: sample?.eventLoopLagP99Ms ?? null,
      rssPercent: sample?.rssPercent ?? null,
      historyRecorderHealthy: historyRecorder.healthy(),
      historyPersistence: historyRecorder.persistence(),
    };
  }

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
      handleMetriczRequest(request, response, metrics, config, processExtras());
      return;
    }
    // With ADMIN_ENABLED=false both fall through to the 404 below, so a
    // disabled dashboard is indistinguishable on the wire from any other
    // unknown path.
    if (config.adminEnabled && (url.pathname === '/admin' || url.pathname === '/admin/')) {
      handleAdminPageRequest(request, response);
      return;
    }
    if (config.adminEnabled && url.pathname === '/admin/data') {
      const adminDeps = {
        metrics,
        recorder: historyRecorder,
        capacity: {
          maxConnections: config.maxConnections,
          maxUnpairedConnections: config.maxUnpairedConnections,
          maxBufferedBytes: config.maxBufferedBytes,
        },
      };
      handleAdminDataRequest(request, response, adminDeps, url).catch(
        (error: unknown) => {
          logger.error('admin data request failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!response.headersSent) response.writeHead(500).end();
        },
      );
      return;
    }
    if (url.pathname === '/') {
      handleLandingRequest(request, response);
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
    // The unpaired reservation taken during the upgrade now belongs to this
    // connection; the slot table releases it when the connection pairs or
    // closes, whichever comes first.
    conn.unpairedReserved = true;
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

    if (!unpairedConnectionCap.tryReserve()) {
      reservation.release();
      metrics.onReject('unpaired_cap');
      // Same 503 as global-cap exhaustion: the wire must not tell a prober
      // which ceiling they hit. The reject counter distinguishes them.
      destroySocket(socket, 503);
      return;
    }

    // Both reservations are held from here on, so every path that does not
    // hand them to a Conn has to give them back.
    const releaseReservations = (): void => {
      reservation.release();
      unpairedConnectionCap.release();
    };

    if (health.draining) {
      releaseReservations();
      metrics.onReject('shutting_down');
      destroySocket(socket, 503);
      return;
    }

    let decision: AdmissionDecision;
    try {
      decision = await admissionPolicy.admit({
        ip,
        slotId,
        headers: request.headers,
        rawUrl: request.url ?? '',
        connectedAt: Date.now(),
      });
    } catch (error) {
      // A custom policy that throws must not leak the reservations it was
      // holding; the outer handler turns this into a 503.
      releaseReservations();
      throw error;
    }

    if (health.draining) {
      releaseReservations();
      metrics.onReject('shutting_down');
      destroySocket(socket, 503);
      return;
    }

    let handshakeCompleted = false;
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handshakeCompleted = true;
        if (!decision.allow) {
          metrics.onReject('admission');
          releaseReservations();
          try {
            ws.close(decision.closeCode, decision.reason);
          } catch {
            // A malformed decision from a custom policy (close code outside
            // the sendable range, reason over the 123-byte close-frame limit)
            // must still tear the socket down, not abort the upgrade handler.
            ws.terminate();
          }
          return;
        }
        onWebSocketConnection(ws, slotId, ip, reservation.release);
      });
    } finally {
      // ws aborts the handshake without ever invoking the callback for a
      // missing or bad Sec-WebSocket-Key/-Version, a non-GET method, or a
      // socket that died while the admission decision was awaited. No Conn
      // owns the reservations on those paths, so they are given back here.
      if (!handshakeCompleted) releaseReservations();
    }
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
        // Before the graceful 1001 sweep below, so an armed probe can never
        // terminate() a connection the shutdown path is already closing
        // politely.
        slotTable.stopContentionProbes();
        // Started before connections are torn down, so the final flushed row
        // captures live state rather than an already-drained relay. The catch
        // is attached now so a recorder failure can never surface as an
        // unhandled rejection, nor fail close().
        const historyStopped = (historyRecorder?.stop() ?? Promise.resolve()).catch(() => undefined);

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
            if (error) {
              reject(error);
              return;
            }
            historyStopped.then(() => resolve(), () => resolve());
          });
        });
      }),
  };
}
