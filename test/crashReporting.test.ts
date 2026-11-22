import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { describe, expect, it } from 'vitest';
import {
  buildSentryOptions,
  CAPTURE_WINDOW_MS,
  createCaptureLimiter,
  FATAL_FLUSH_TIMEOUT_MS,
  redactIdentifiers,
  scrubEvent,
} from '../src/crashReporting.js';
import { SRC_ROOT, everySourceFile } from './helpers/sourceFiles.js';

const DSN = 'https://publickey@o123456.ingest.us.sentry.io/4510000000000000';
const SLOT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CLIENT_IP = '203.0.113.77';

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

describe('the Sentry options, pinned', () => {
  // Importing the SDK here is safe: an import alone registers no process listener and creates
  // no client. Nothing in this file calls Sentry.init.
  const options = buildSentryOptions(Sentry, DSN, 'test-environment');

  it('installs no default integration, and exactly one of its own', () => {
    // The defaults put HTTP and OpenTelemetry instrumentation on the upgrade path, where the
    // request URL carries the slot and the headers carry the client IP and an Access JWT.
    expect(options.defaultIntegrations).toBe(false);
    if (!Array.isArray(options.integrations)) throw new Error('integrations must be a plain list');
    // OnUnhandledRejection is deliberately absent: in its default mode it keeps a crashed relay
    // alive, and in strict mode it swallows AbortError. test/crashReporting.process.test.ts proves both.
    expect(options.integrations.map((integration) => integration.name)).toEqual(['OnUncaughtException']);
  });

  it('turns off every other way the SDK can attach data, load hooks, or send elsewhere', () => {
    expect(options.enableRuntimeChannelInjection).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.includeLocalVariables).toBe(false);
    expect(options.includeServerName).toBe(false);
    expect(options.maxBreadcrumbs).toBe(0);
    expect(options.sendClientReports).toBe(false);
    expect(options.spotlight).toBe(false);
    expect(options.debug).toBe(false);
    expect(options.dataCollection).toEqual({
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
    });
  });

  it('bounds the dying flush, and names the release so it cannot collide inside the organization', () => {
    expect(options.shutdownTimeout).toBe(FATAL_FLUSH_TIMEOUT_MS);
    expect(FATAL_FLUSH_TIMEOUT_MS).toBe(2_000);
    // Sentry release names are global per organization and may not contain "/".
    expect(options.release).toBe(`relay@${packageVersion()}`);
    expect(options.release).not.toContain('/');
    expect(options.dsn).toBe(DSN);
    expect(options.environment).toBe('test-environment');
  });

  it('routes every event through the allowlist', () => {
    expect(options.beforeSend).toBeTypeOf('function');
  });
});

describe('scrubEvent builds a new event from an allowlist', () => {
  const hostileEvent: ErrorEvent = {
    type: undefined,
    event_id: '0123456789abcdef0123456789abcdef',
    timestamp: 1_763_700_000,
    platform: 'node',
    level: 'error',
    release: 'relay@0.4.2',
    environment: 'production',
    server_name: 'container-hostname',
    message: `dial ${SLOT_ID}`,
    request: {
      url: `https://relay.example/?slot=${SLOT_ID}`,
      query_string: `slot=${SLOT_ID}`,
      headers: { 'cf-connecting-ip': CLIENT_IP, 'cf-access-jwt-assertion': 'jwt' },
    },
    user: { id: SLOT_ID, ip_address: CLIENT_IP },
    contexts: { request: { slot: SLOT_ID }, runtime: { name: 'node' } },
    extra: { slotId: SLOT_ID, ip: CLIENT_IP },
    breadcrumbs: [{ message: `upgrade from ${CLIENT_IP}` }],
    tags: { capture_site: 'upgrade_handler', slot: SLOT_ID, 'client.ip': CLIENT_IP },
    fingerprint: [SLOT_ID],
    modules: { ws: '8.18.0' },
    sdk: {
      name: 'sentry.javascript.node',
      version: '11.16.0',
      integrations: ['OnUncaughtException'],
      packages: [{ name: 'npm:@sentry/node', version: '11.16.0' }],
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: `admission exploded for ${SLOT_ID} from ${CLIENT_IP}`,
          mechanism: { type: 'generic', handled: true, data: { slot: SLOT_ID } },
          stacktrace: {
            frames: [
              {
                filename: '/app/dist/server.js',
                module: 'server',
                function: 'handleUpgrade',
                lineno: 10,
                colno: 5,
                in_app: true,
                abs_path: '/app/dist/server.js',
                context_line: `const slotId = '${SLOT_ID}';`,
                pre_context: [`// ${CLIENT_IP}`],
                post_context: [],
                vars: { slotId: SLOT_ID, ip: CLIENT_IP },
              },
            ],
          },
        },
      ],
    },
  };

  it('keeps only the allowlisted fields, whatever else the SDK attached', () => {
    expect(scrubEvent(hostileEvent)).toStrictEqual({
      type: undefined,
      event_id: '0123456789abcdef0123456789abcdef',
      timestamp: 1_763_700_000,
      platform: 'node',
      level: 'error',
      release: 'relay@0.4.2',
      environment: 'production',
      sdk: { name: 'sentry.javascript.node', version: '11.16.0' },
      tags: { capture_site: 'upgrade_handler' },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'admission exploded for [redacted-hex] from [redacted-ip]',
            mechanism: { type: 'generic', handled: true },
            stacktrace: {
              frames: [
                { filename: '/app/dist/server.js', module: 'server', function: 'handleUpgrade', lineno: 10, colno: 5, in_app: true },
              ],
            },
          },
        ],
      },
    });
  });

  it('leaves neither the slot id nor the client IP anywhere in the result', () => {
    const serialized = JSON.stringify(scrubEvent(hostileEvent));
    expect(serialized).not.toContain(SLOT_ID);
    expect(serialized).not.toContain(CLIENT_IP);
  });

  it('drops a capture_site tag whose value is not one of the fixed sites', () => {
    expect(scrubEvent({ type: undefined, tags: { capture_site: SLOT_ID } }).tags).toBeUndefined();
  });
});

describe('redactIdentifiers', () => {
  it.each([
    [`slot ${SLOT_ID} here`, 'slot [redacted-hex] here'],
    [`slot ${'f'.repeat(64)}`, 'slot [redacted-hex]'],
    [`from ${CLIENT_IP}`, 'from [redacted-ip]'],
    [`from ${CLIENT_IP}:443`, 'from [redacted-ip]:443'],
    ['from 2001:db8:85a3::8a2e:370:7334', 'from [redacted-ip]'],
    ['from ::1', 'from [redacted-ip]'],
    ['from [2001:db8::1]:443', 'from [[redacted-ip]]:443'],
    ['from ::ffff:203.0.113.7', 'from ::ffff:[redacted-ip]'],
  ])('masks %j', (input, expected) => {
    expect(redactIdentifiers(input)).toBe(expected);
  });

  it.each(['Invalid URL', 'read ECONNRESET', 'at 12:34:56', 'deadbeef is short', 'EACCES: permission denied'])(
    'leaves %j alone',
    (input) => {
      expect(redactIdentifiers(input)).toBe(input);
    },
  );
});

describe('the per-site capture cap', () => {
  it('lets each site through at most once per window, independently', () => {
    let nowMs = 0;
    const shouldCapture = createCaptureLimiter(() => nowMs, 1_000);

    expect(shouldCapture('upgrade_handler')).toBe(true);
    expect(shouldCapture('upgrade_handler')).toBe(false);
    expect(shouldCapture('shutdown')).toBe(true);

    nowMs = 999;
    expect(shouldCapture('upgrade_handler')).toBe(false);
    nowMs = 1_000;
    expect(shouldCapture('upgrade_handler')).toBe(true);
  });

  it('defaults to one report per site per hour', () => {
    expect(CAPTURE_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

describe('the SDK stays behind the DSN check, mechanically', () => {
  const SDK_SPECIFIER = /['"`]@sentry\//;

  it.each(everySourceFile().filter((file) => file !== 'crashReporting.ts'))(
    'src/%s does not reference the Sentry SDK in any form',
    (relativePath) => {
      expect(readFileSync(path.join(SRC_ROOT, relativePath), 'utf8')).not.toMatch(SDK_SPECIFIER);
    },
  );

  it('src/crashReporting.ts loads it in exactly one place, a dynamic import', () => {
    const lines = readFileSync(path.join(SRC_ROOT, 'crashReporting.ts'), 'utf8')
      .split('\n')
      .filter((line) => SDK_SPECIFIER.test(line));
    const allowed = [
      // Erased at compile time under verbatimModuleSyntax: loads nothing.
      /^import type \{[^}]*\} from '@sentry\/node';$/,
      /^type SentryModule = typeof import\('@sentry\/node'\);$/,
      // The one runtime load, inside startCrashReporting after the DSN check.
      /^\s+const sentry: SentryModule = await import\('@sentry\/node'\);$/,
    ];
    for (const line of lines) {
      expect(allowed.some((pattern) => pattern.test(line)), `unexpected SDK reference: ${line}`).toBe(true);
    }
    expect(lines.filter((line) => line.includes("await import('@sentry/node')"))).toHaveLength(1);
  });

  it('keeps @sentry/node a runtime dependency, so the image ships what the dynamic import loads', () => {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toContain('@sentry/node');
  });
});

describe('nothing in src/ competes with the fatal handler', () => {
  // Node's own termination is the recovery mechanism: Docker restarts a dead process and the
  // monitor reads its uptime. A process-level listener of our own would suppress that, and
  // Sentry's handler only exits while it is the sole uncaughtException listener.
  const PROCESS_CRASH_LISTENER =
    /process\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*['"`](?:uncaughtException|unhandledRejection|uncaughtExceptionMonitor)['"`]|setUncaughtExceptionCaptureCallback/;

  it.each(everySourceFile())('src/%s registers no process-level crash listener', (relativePath) => {
    expect(readFileSync(path.join(SRC_ROOT, relativePath), 'utf8')).not.toMatch(PROCESS_CRASH_LISTENER);
  });
});
