/**
 * Child process for test/crashReporting.process.test.ts's wire check. Starts real crash reporting
 * (the SDK, its options, its HTTP transport) and a real relay whose admission policy throws an error
 * carrying the slot id and client IP, dials it twice, then dies with both in the fatal message. The
 * parent reads every byte the ingest stub received and asserts neither secret is in any of it.
 *
 * argv: <slot id> <client ip>. The client IP arrives as X-Forwarded-For from a trusted loopback
 * proxy, so it is distinct from every loopback address in the run, the DSN host included.
 */
import * as Sentry from '@sentry/node';
import { WebSocket } from 'ws';
import type { AdmissionPolicy } from '../../src/admission.js';
import { loadConfig } from '../../src/config.js';
import { FATAL_FLUSH_TIMEOUT_MS, startCrashReporting } from '../../src/crashReporting.js';
import { createLogger } from '../../src/logging.js';
import { createRelay } from '../../src/server.js';

const [slotId = '', clientIp = ''] = process.argv.slice(2);
const config = loadConfig(process.env);
const logger = createLogger(config);
const crashReporter = await startCrashReporting(config, { logger });
if (crashReporter === null) throw new Error('scrub fixture: SENTRY_DSN must be set');

// A stand-in for an SDK upgrade that starts attaching request data by default: every scope
// surface an event can inherit from now carries the slot and the IP. The allowlist must drop all.
Sentry.setUser({ id: slotId, ip_address: clientIp });
Sentry.setTags({ slot: slotId, 'client.ip': clientIp });
Sentry.setExtra('rawUrl', `/?slot=${slotId}`);
Sentry.setContext('request', { url: `/?slot=${slotId}`, headers: { 'x-forwarded-for': clientIp } });
Sentry.addBreadcrumb({ message: `dial ${slotId} from ${clientIp}` });

const throwingPolicy: AdmissionPolicy = {
  admit: (context) => {
    const error = new Error(`admission exploded for ${context.slotId} from ${context.ip}`, {
      cause: { slotId: context.slotId, ip: context.ip },
    });
    throw Object.assign(error, { slotId: context.slotId, ip: context.ip, rawUrl: context.rawUrl, headers: context.headers });
  },
};
const relay = createRelay(config, { logger, crashReporter, admissionPolicy: throwingPolicy });
const { port } = await relay.listen();

function dial(): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?slot=${slotId}`, { headers: { 'x-forwarded-for': clientIp } });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      resolve();
    });
    socket.once('error', () => resolve());
  });
}

// Twice: the per-site cap must absorb the second, so exactly one upgrade_handler event arrives.
await dial();
await dial();
await crashReporter.flush(FATAL_FLUSH_TIMEOUT_MS);

// The fatal error carries both the way the captured one does, in its message, its cause and its own
// properties, since it travels the SDK's uncaught-exception handler rather than captureException.
setTimeout(() => {
  const error = new Error(`fatal with ${slotId} from ${clientIp}`, { cause: { slotId, clientIp } });
  throw Object.assign(error, { slotId, ip: clientIp });
}, 0);
