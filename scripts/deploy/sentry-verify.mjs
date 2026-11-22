// Crash reporting check for the hosted relay, run after setting or rotating the RELAY_SENTRY_DSN
// secret. See infra/README.md, "Verifying crash reporting".
//
// Runs as a SEPARATE process inside the serving relay container, so it shares the image, the env (and
// with it the DSN), the network namespace and the egress path, while the relay process itself is never
// touched. Piped in, since the image ships no scripts. `<box>` is the server's own address, since
// both public hostnames are proxied by Cloudflare and refuse SSH:
//
//   ssh deploy@<box> "docker exec -i -e SENTRY_ENVIRONMENT=verification compose-relay-1 node --input-type=module -" < scripts/deploy/sentry-verify.mjs
//
// (From PowerShell, which has no `<`: Get-Content -Raw scripts/deploy/sentry-verify.mjs | ssh ...)
//
// It plants canaries, a slot-shaped hex run and TEST-NET addresses, in the message, on the error,
// and on every scope surface, then dies of an uncaught exception. That is the real fatal path: the SDK's onUncaughtException handler captures,
// flushes for at most 2 s, and exits 1. The delivered event must carry none of the canaries.
//
// What it does not prove: a crash in the relay process itself (test/crashReporting.process.test.ts
// covers that path locally), or that the relay process initialized the SDK (its own startup log line,
// "crash reporting enabled", does).
import { randomBytes } from 'node:crypto';

const { loadConfig } = await import('/app/dist/config.js');
const { createLogger } = await import('/app/dist/logging.js');
const { startCrashReporting } = await import('/app/dist/crashReporting.js');

const config = loadConfig(process.env);
const logger = createLogger(config);
const reporter = await startCrashReporting(config, { logger });
if (reporter === null) {
  console.log('VERIFY: SENTRY_DSN is not set in this container; nothing to verify');
  process.exit(2);
}

// The same module instance crashReporting.js initialized, or the scope canaries below prove nothing.
const sentry = await import('@sentry/node');
if (sentry.getClient() === undefined) {
  console.log('VERIFY: @sentry/node resolved to a different instance than the relay initialized');
  process.exit(3);
}

const nonce = randomBytes(6).toString('hex');
const slotCanary = randomBytes(32).toString('hex');
const ipv4Canary = '192.0.2.44';
const ipv6Canary = '2001:db8::44';

sentry.setUser({ id: slotCanary, ip_address: ipv4Canary, username: slotCanary });
sentry.setTag('slot', slotCanary);
sentry.setTag('client_ip', ipv4Canary);
sentry.setExtra('connection', { slot: slotCanary, ip: ipv4Canary });
sentry.setContext('peer', { slot: slotCanary, ip: ipv6Canary });
sentry.addBreadcrumb({ message: `dial slot=${slotCanary} from ${ipv4Canary}` });

console.log(`VERIFY: nonce=${nonce} slotCanary=${slotCanary} release=${sentry.getClient()?.getOptions().release}`);

const thrownAtMs = Date.now();
process.on('exit', (code) => {
  console.log(`VERIFY: exit code=${code} ${Date.now() - thrownAtMs} ms after the throw`);
});

setTimeout(() => {
  const error = new Error(
    `crash reporting verification ${nonce}, deliberate, not a relay fault: slot=${slotCanary} ip=${ipv4Canary} ip6=${ipv6Canary}`,
  );
  error.slot = slotCanary;
  error.cause = new Error(`cause from ${ipv4Canary}`);
  throw error;
}, 0);
