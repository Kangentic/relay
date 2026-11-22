import { isIP } from 'node:net';
// Type-only: erased at compile time under verbatimModuleSyntax, so this line loads nothing. The one
// runtime reference to the SDK is the dynamic import inside startCrashReporting, below the DSN check.
import type { ErrorEvent, Exception, NodeOptions, StackFrame } from '@sentry/node';
import type { Logger } from './logging.js';
import type { Config } from './types.js';
import { RELAY_VERSION } from './version.js';

type SentryModule = typeof import('@sentry/node');

/**
 * How long a dying process waits for its last report before it exits anyway, and the bound on the
 * shutdown path's flush. A Sentry outage must never be able to hang a crashed relay: Docker's
 * restart and the monitor's uptime check both depend on the process actually dying.
 */
export const FATAL_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Each non-fatal capture site reports at most once per window. The fatal handler is the only
 * uncapped path, because a process can only die once; every site below can repeat, and at least one
 * (`upgrade_handler`) can be reached by a stranger, so without a cap they would spend the quota.
 */
export const CAPTURE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The only places the relay reports a handled error from. Deliberately a closed list: anything a
 * client can trigger per connection (socket errors, admission webhook failures) is left to the log,
 * because no per-site cap would make a per-connection signal worth its quota.
 */
export type CaptureSite =
  | 'admin_data_request'
  | 'history_write_disabled'
  | 'history_compaction'
  | 'shutdown'
  | 'upgrade_handler';

const CAPTURE_SITES: ReadonlySet<string> = new Set<CaptureSite>([
  'admin_data_request',
  'history_write_disabled',
  'history_compaction',
  'shutdown',
  'upgrade_handler',
]);

/** The one tag an event may carry, and only with a value from CAPTURE_SITES. */
export const CAPTURE_SITE_TAG = 'capture_site';

export interface CrashReporter {
  /** Reports a handled error from one fixed site, at most once per CAPTURE_WINDOW_MS per site. */
  capture(site: CaptureSite, error: unknown): void;
  /** Waits for queued reports to send, for at most timeoutMs. Never rejects. */
  flush(timeoutMs: number): Promise<void>;
}

export interface CrashReportingOptions {
  readonly logger: Logger;
  /** Replaces the network transport. Tests only: production always uses the SDK's own. */
  readonly transport?: NonNullable<NodeOptions['transport']>;
  readonly now?: () => number;
}

const HEX_RUN = /[0-9a-f]{32,}/gi;
const IPV4_ADDRESS = /\d{1,3}(?:\.\d{1,3}){3}/g;
const COLON_RUN = /[0-9a-f]*(?::[0-9a-f]*){2,}/gi;

/**
 * Masks anything shaped like a slot id (a long hex run) or an IP address in free text. The event
 * allowlist below is the real guarantee; this covers the one free-text field it keeps, an error
 * message, in case a future message ever interpolates a slot or an address. Over-masking a version
 * string or a clock time is the accepted cost.
 */
export function redactIdentifiers(text: string): string {
  return text
    .replace(HEX_RUN, '[redacted-hex]')
    .replace(IPV4_ADDRESS, '[redacted-ip]')
    .replace(COLON_RUN, (token) => (isIP(token) === 6 ? '[redacted-ip]' : token));
}

function scrubFrame(frame: StackFrame): StackFrame {
  const scrubbed: StackFrame = {};
  if (frame.filename !== undefined) scrubbed.filename = frame.filename;
  if (frame.module !== undefined) scrubbed.module = frame.module;
  if (frame.function !== undefined) scrubbed.function = frame.function;
  if (frame.lineno !== undefined) scrubbed.lineno = frame.lineno;
  if (frame.colno !== undefined) scrubbed.colno = frame.colno;
  if (frame.in_app !== undefined) scrubbed.in_app = frame.in_app;
  return scrubbed;
}

function scrubException(exception: Exception): Exception {
  const scrubbed: Exception = {};
  if (exception.type !== undefined) scrubbed.type = redactIdentifiers(exception.type);
  if (exception.value !== undefined) scrubbed.value = redactIdentifiers(exception.value);
  if (exception.mechanism !== undefined) {
    const { type, handled } = exception.mechanism;
    scrubbed.mechanism = handled === undefined ? { type } : { type, handled };
  }
  const frames = exception.stacktrace?.frames;
  if (frames !== undefined) scrubbed.stacktrace = { frames: frames.map(scrubFrame) };
  return scrubbed;
}

/**
 * Builds a NEW event from an allowlist of fields, never a filtered copy of the SDK's. What the SDK
 * attaches by default changes between versions (request data, user, contexts, breadcrumbs, local
 * variables, source lines, server name), and near the upgrade path those carry the slot id, a bearer
 * secret for its rendezvous, and the client IP. An allowlist drops whatever a future version adds;
 * a denylist would forward it. This mirrors the upgrade handler's own log line, which deliberately
 * carries `error.message` and nothing else.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed: ErrorEvent = { type: undefined };
  if (event.event_id !== undefined) scrubbed.event_id = event.event_id;
  if (event.timestamp !== undefined) scrubbed.timestamp = event.timestamp;
  if (event.platform !== undefined) scrubbed.platform = event.platform;
  if (event.level !== undefined) scrubbed.level = event.level;
  if (event.release !== undefined) scrubbed.release = event.release;
  if (event.environment !== undefined) scrubbed.environment = event.environment;
  if (event.sdk?.name !== undefined && event.sdk.version !== undefined) {
    scrubbed.sdk = { name: event.sdk.name, version: event.sdk.version };
  }
  const site = event.tags?.[CAPTURE_SITE_TAG];
  if (typeof site === 'string' && CAPTURE_SITES.has(site)) scrubbed.tags = { [CAPTURE_SITE_TAG]: site };
  const values = event.exception?.values;
  if (values !== undefined) scrubbed.exception = { values: values.map(scrubException) };
  return scrubbed;
}

/** Per-site "at most once per window" gate, separate from the SDK so it is testable without one. */
export function createCaptureLimiter(
  now: () => number,
  windowMs: number = CAPTURE_WINDOW_MS,
): (site: CaptureSite) => boolean {
  const lastCapturedAtMs = new Map<CaptureSite, number>();
  return (site) => {
    const nowMs = now();
    const previousMs = lastCapturedAtMs.get(site);
    if (previousMs !== undefined && nowMs - previousMs < windowMs) return false;
    lastCapturedAtMs.set(site, nowMs);
    return true;
  };
}

/**
 * Every option here is load-bearing; `test/crashReporting.test.ts` pins each one.
 *
 * - `defaultIntegrations: false`: the defaults include HTTP and OpenTelemetry instrumentation, which
 *   would sit on the upgrade path and read `request.url` (carrying `?slot=`) and the request headers
 *   (CF-Connecting-IP, and on /admin an Access JWT), plus console capture and local-variable capture.
 * - Only `onUncaughtExceptionIntegration`, at its default options. It does not prevent the exit: with
 *   no other `uncaughtException` listener it captures, flushes for at most `shutdownTimeout`, and
 *   exits 1. Its `exitEvenIfOtherHandlersAreRegistered` defaults to false in this SDK, so it exits
 *   only while it is the sole listener, which is why nothing in src/ may add another.
 * - NO `onUnhandledRejectionIntegration`. Measured on 11.16.0: in its default `warn` mode its listener
 *   stops Node from raising the rejection, so a relay with a DSN SURVIVED an unhandled rejection that
 *   kills one without; in `strict` mode it still swallows an `AbortError` silently (a hard-coded
 *   ignore). Without it, Node's own default (`--unhandled-rejections=throw`) turns every unhandled
 *   rejection into an uncaught exception, which the handler above reports and exits on.
 * - `enableRuntimeChannelInjection: false`: otherwise the client constructor installs a module loader
 *   hook (an off-thread `module.register()` loader on Node 22) and rewrites the source of matching
 *   dependencies as they load, regardless of `defaultIntegrations`.
 * - `spotlight`, `debug`: pinned so the SDK's own SENTRY_SPOTLIGHT / SENTRY_DEBUG env vars cannot add
 *   a sidecar destination or print events to the log behind this module's back.
 */
export function buildSentryOptions(
  sentry: Pick<SentryModule, 'onUncaughtExceptionIntegration'>,
  dsn: string,
  environment: string,
  transport?: NonNullable<NodeOptions['transport']>,
): NodeOptions {
  return {
    dsn,
    environment,
    // Releases are global per Sentry organization (desktop files as `Kangentic@x.y.z`), so a bare
    // version would collide; and a release name may not contain "/", which rules out the package name.
    ...(RELAY_VERSION === undefined ? {} : { release: `relay@${RELAY_VERSION}` }),
    defaultIntegrations: false,
    integrations: [sentry.onUncaughtExceptionIntegration()],
    enableRuntimeChannelInjection: false,
    // SDK 11 removed `sendDefaultPii` (it is no longer read at all) in favour of this object, whose
    // defaults collect user info, headers, query params (the slot), bodies, local variables and
    // source lines. Every category is named and switched off, rather than trusting the defaults.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    tracesSampleRate: 0,
    includeLocalVariables: false,
    includeServerName: false,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    spotlight: false,
    debug: false,
    shutdownTimeout: FATAL_FLUSH_TIMEOUT_MS,
    // No `beforeSendTransaction`: `tracesSampleRate: 0` already samples no transaction or span, and
    // under SDK 11's default span streaming the option is ignored and prints a warning at init.
    beforeSend: (event) => scrubEvent(event),
    ...(transport === undefined ? {} : { transport }),
  };
}

/**
 * Starts crash reporting when SENTRY_DSN is set, and returns null otherwise.
 *
 * Off is structural, the way ADMIN_ENABLED and CONNECTION_TRACE are: with no DSN the SDK is never
 * imported (importing it has side effects of its own), so there is no handler, no client and no
 * network connection, rather than an initialized client told to stay quiet.
 *
 * A failure to load or initialize the SDK is logged and the relay runs on without it: the relay's
 * job is forwarding bytes, and an optional reporter must not be what stops it serving.
 */
export async function startCrashReporting(
  config: Pick<Config, 'sentryDsn' | 'sentryEnvironment'>,
  options: CrashReportingOptions,
): Promise<CrashReporter | null> {
  if (config.sentryDsn === null) return null;

  let sentry: SentryModule;
  try {
    sentry = await import('@sentry/node');
    sentry.init(buildSentryOptions(sentry, config.sentryDsn, config.sentryEnvironment, options.transport));
  } catch (error: unknown) {
    options.logger.error('crash reporting failed to start, continuing without it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const shouldCapture = createCaptureLimiter(options.now ?? Date.now);
  options.logger.info('crash reporting enabled', { environment: config.sentryEnvironment });
  return {
    capture(site, error) {
      if (!shouldCapture(site)) return;
      sentry.captureException(error, { level: 'error', tags: { [CAPTURE_SITE_TAG]: site } });
    },
    async flush(timeoutMs) {
      try {
        await sentry.flush(timeoutMs);
      } catch {
        // A flush is best effort by definition; the caller is usually on its way out.
      }
    },
  };
}
