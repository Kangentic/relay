import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config, Conn } from './types.js';
import { millisecondsSinceUpgrade, startConnectionTrace, type ConnectionTrace } from './connectionTrace.js';
import {
  createDialLog,
  markDialOpened,
  recordTeardownCause,
  resolveClientDialId,
  startDialCorrelation,
  type DialCorrelation,
  type DialRejectAnswer,
  type DialRejectReason,
} from './dialCorrelation.js';
import type { RejectReason } from './closeCodes.js';
import { createLogger, type Logger } from './logging.js';
import type { CrashReporter } from './crashReporting.js';
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
import { parsePeerRole, type PeerRole } from './guards/peerRole.js';
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
  /** Null or absent when SENTRY_DSN is unset, which is the default: nothing is reported. */
  readonly crashReporter?: CrashReporter | null;
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
 * The request target as a URL, or null when it does not parse. The target is the client's to
 * choose, including absolute form (`GET http://localhost:99999/ HTTP/1.1`), and `new URL` throws on
 * a bad one. Unguarded, that throw inside the synchronous request listener was an uncaught
 * exception, so a single request from anyone stopped the process; on the upgrade path it reached
 * the "upgrade handler failed" catch, a stranger-triggerable error report.
 */
function parseRequestTarget(rawTarget: string | undefined): URL | null {
  try {
    return new URL(rawTarget ?? '/', 'http://localhost');
  } catch {
    return null;
  }
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
  const crashReporter = deps.crashReporter ?? null;

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

  // The waiting gauge is derived from the slot table rather than counted as
  // connections park and leave, so it cannot drift away from the table it
  // describes. Bound here rather than at createMetrics because the table needs
  // the metrics object to exist first; an injected deps.metrics is bound to
  // this relay's table, which is what a caller sharing one across two relays
  // would need to know.
  metrics.setWaitingSlotsSource(() => slotTable.waitingByRole());

  const liveConnections = new Set<Conn>();
  const health: HealthState = { draining: false };

  // Null when DIAL_LOG_MAX_PER_MIN is 0: then no dial id is even parsed.
  const dialLog = createDialLog({ logger, metrics, maxLinesPerMinute: config.dialLogMaxPerMinute });

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
          crashReporter,
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
      eventLoopLagMaxMs: sample?.eventLoopLagMaxMs ?? null,
      gcPauseMaxMs: sample?.gcPauseMaxMs ?? null,
      rssPercent: sample?.rssPercent ?? null,
      historyRecorderHealthy: historyRecorder.healthy(),
      historyPersistence: historyRecorder.persistence(),
    };
  }

  function handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    const url = parseRequestTarget(request.url);
    if (url === null) {
      response.writeHead(400).end();
      return;
    }
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
          crashReporter?.capture('admin_data_request', error);
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

  // Null unless CONNECTION_TRACE is on, so a relay with tracing off registers
  // no accept listener at all. A WeakMap so a socket that never upgrades
  // leaves nothing behind.
  const socketAcceptedAt: WeakMap<Socket, number> | null = config.connectionTrace ? new WeakMap() : null;
  if (socketAcceptedAt !== null) {
    httpServer.on('connection', (socket: Socket) => {
      socketAcceptedAt.set(socket, performance.now());
    });
  }
  // permessage-deflate is explicitly disabled (not just left to the `ws`
  // default): every frame this relay carries is ciphertext, which is
  // incompressible, so compression would burn CPU per frame, add latency,
  // and pin a zlib context's worth of memory to every connection for zero
  // byte savings. Frames pass through byte-for-byte, uncompressed.
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes, perMessageDeflate: false });

  function onWebSocketConnection(
    ws: WebSocket,
    slotId: string,
    ip: string,
    role: PeerRole,
    releaseCapReservation: () => void,
    trace: ConnectionTrace | null,
    dial: DialCorrelation | null,
  ): void {
    const conn = createConn(ws, slotId, ip, role, trace, dial);
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
      dialLog,
      onClosed: () => {
        releaseCapReservation();
        liveConnections.delete(conn);
      },
    });

    slotTable.handleConnection(conn);
  }

  async function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    // First, so the clock starts when the upgrade arrived rather than after
    // the guards. A rejected upgrade drops its trace unlogged; what records a
    // rejection is the dial line below, for a client that sent a dial id.
    const trace =
      socketAcceptedAt === null ? null : startConnectionTrace(request.headers['cf-ray'], socketAcceptedAt.get(socket));
    // The three rejects before the dial id is read (an unparseable request
    // target, the wrong path, and the slot_format one below) write no dial
    // line, and that is deliberate rather than an ordering accident: they
    // cannot carry the id. A real client never sends a malformed target, the
    // wrong path or a malformed slot, so these only ever answer probers, and
    // reading the id earlier would buy a log line per probe and nothing else.
    const url = parseRequestTarget(request.url);
    if (url === null) {
      destroySocket(socket, 400);
      return;
    }
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

    // Optional, advisory, and deliberately not a guard: it sits after the slot
    // check so a malformed slot still costs nothing, and it cannot reject, so
    // it spends no rate-limit budget and adds no reject reason for a prober to
    // read. Every client deployed today omits it and is counted as 'unknown'.
    // Validated to the closed enum here, at the edge, so the client's raw
    // string never reaches a metric label.
    const role = parsePeerRole(url.searchParams.get('role'));

    // The client's per-dial correlation id, on the same terms as role and
    // after the slot check for the same reason: advisory, unauthenticated,
    // and unable to reject, so it spends no rate-limit budget and adds no
    // reject reason. Validated here to sixteen lowercase hex characters, and
    // it goes only into log lines, never into a metric. Not read at all when
    // the dial lines are off.
    const clientDialId = dialLog === null ? null : resolveClientDialId(url.searchParams.get('dial'), slotId);
    const dial = clientDialId === null ? null : startDialCorrelation(clientDialId, request.headers['cf-ray']);
    const logDialRejection = (reason: DialRejectReason, answer: DialRejectAnswer | null): void => {
      if (dial !== null) dialLog?.rejected(dial, role, reason, answer);
    };
    // Every pre-upgrade refusal from here on: counted, logged for a client
    // that sent a dial id, and answered with a bare status.
    const refuseUpgrade = (reason: RejectReason, statusCode: number): void => {
      metrics.onReject(reason);
      logDialRejection(reason, { httpStatus: statusCode });
      destroySocket(socket, statusCode);
    };

    const ip = resolveClientIp(request.headers, request.socket.remoteAddress, config);
    const ipBucket = bucketIp(ip, config.ipv6PrefixBits);

    if (!ipRateLimiter.tryConsume(ipBucket)) {
      refuseUpgrade('rate_limit_ip', 429);
      return;
    }
    if (!slotRateLimiter.tryConsume(slotId)) {
      refuseUpgrade('rate_limit_slot', 429);
      return;
    }

    const reservation = connectionCaps.reserve(ipBucket);
    if (!reservation.ok) {
      refuseUpgrade(reservation.reason, 503);
      return;
    }

    if (!unpairedConnectionCap.tryReserve()) {
      reservation.release();
      // Same 503 as global-cap exhaustion: the wire must not tell a prober
      // which ceiling they hit. The reject counter distinguishes them.
      refuseUpgrade('unpaired_cap', 503);
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
      refuseUpgrade('shutting_down', 503);
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
      // holding; the outer handler turns this into a 503. The dial line is
      // written here because the outer handler has no dial in scope.
      releaseReservations();
      logDialRejection('admission_error', { httpStatus: 503 });
      throw error;
    }

    if (health.draining) {
      releaseReservations();
      refuseUpgrade('shutting_down', 503);
      return;
    }
    if (trace !== null) trace.admittedAfterMs = millisecondsSinceUpgrade(trace);

    let handshakeCompleted = false;
    try {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handshakeCompleted = true;
        // ws invokes this after writing the 101, so this is "101 written".
        if (trace !== null) trace.handshakeCompletedAfterMs = millisecondsSinceUpgrade(trace);
        if (dial !== null) markDialOpened(dial);
        if (!decision.allow) {
          metrics.onReject('admission');
          releaseReservations();
          logDialRejection('admission', { closeCode: decision.closeCode });
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
        onWebSocketConnection(ws, slotId, ip, role, reservation.release, trace, dial);
      });
    } finally {
      // ws aborts the handshake without ever invoking the callback for a
      // missing or bad Sec-WebSocket-Key/-Version, a non-GET method, or a
      // socket that died while the admission decision was awaited. No Conn
      // owns the reservations on those paths, so they are given back here.
      // The last of those is a real client whose network dropped mid-dial,
      // which is exactly the dial it cannot diagnose, so it gets a line too.
      if (!handshakeCompleted) {
        releaseReservations();
        logDialRejection('handshake_aborted', null);
      }
    }
  }

  httpServer.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket as Socket, head).catch((error: unknown) => {
      logger.error('upgrade handler failed', { error: error instanceof Error ? error.message : String(error) });
      // Capped per site: a custom admission policy that throws reaches this once per connection.
      crashReporter?.capture('upgrade_handler', error);
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

        // Every half is marked before any close event can fire, so a pair's
        // second half reads shutting_down rather than its partner's peer_closed.
        for (const conn of liveConnections) {
          if (conn.socket.readyState !== conn.socket.OPEN) continue;
          recordTeardownCause(conn, 'shutting_down');
          conn.socket.close(1001, 'shutting_down');
        }

        // Records no cause, on purpose. The sweep above named every half the
        // relay closed, and no Conn can join after it (draining refuses every
        // upgrade still in flight). So a half that reaches this unnamed was
        // already CLOSING when shutdown began, which means its own client
        // started the close, and its cause stays null like any client close.
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
