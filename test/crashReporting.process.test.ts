/**
 * Crash reporting, observed from outside a real process. Two things are proven here, and both are
 * as much the point of crash reporting as the reports themselves:
 *
 * 1. A relay with SENTRY_DSN set dies exactly the way one without it does: same exit code, the same
 *    error on stderr, no hang. Docker's `restart: unless-stopped` and the monitor's uptime check
 *    both depend on the process actually dying, so a reporter that kept a crashed relay alive, or
 *    held it up on an unreachable Sentry, would break the very recovery it exists to make visible.
 * 2. No byte that reaches the ingest endpoint carries the slot id or the client IP, through the real
 *    SDK, its real options and its real transport.
 *
 * Both run in child processes: a Sentry `uncaughtException` handler inside the Vitest worker would
 * turn any stray error into a worker that never reports, which this repo already fights.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FATAL_FLUSH_TIMEOUT_MS } from '../src/crashReporting.js';
import {
  CRASH_KINDS,
  CRASH_MARKER,
  READY_MARKER,
  type ChildProcessState,
  type CrashKind,
} from './fixtures/crashReportingProtocol.js';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const CRASH_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'crashReportingChild.ts');
const SCRUB_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'crashReportingScrubChild.ts');
/** Generous: the black-hole case alone takes FATAL_FLUSH_TIMEOUT_MS, plus tsx and SDK startup. */
const CHILD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

interface ChildRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly state: ChildProcessState | null;
  /** From the fixture announcing its crash to the process closing, as the parent saw it. */
  readonly crashToExitMs: number | null;
  readonly timedOut: boolean;
}

function listen(server: Server | NetServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

function closeServer(server: Server | NetServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A port nothing is listening on, for the child relay to bind. Released before the child starts. */
async function freePort(): Promise<number> {
  const server = createNetServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

/**
 * The child's environment: everything this process has, minus any SENTRY_* a developer's shell
 * might carry and minus NODE_OPTIONS, so the relay and SDK configuration come from the test alone.
 */
async function childEnvironment(overrides: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('SENTRY_') || key === 'NODE_OPTIONS') continue;
    environment[key] = value;
  }
  return {
    ...environment,
    PORT: String(await freePort()),
    BIND_ADDRESS: '127.0.0.1',
    // Error level only: a relay error line on stderr would surface in the comparison, as it should.
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

async function runChild(fixture: string, fixtureArguments: readonly string[], overrides: Record<string, string>): Promise<ChildRun> {
  const environment = await childEnvironment(overrides);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, ...fixtureArguments], {
      cwd: REPO_ROOT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let crashedAtMs: number | null = null;
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CHILD_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (crashedAtMs === null && stdout.includes(CRASH_MARKER)) crashedAtMs = performance.now();
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (exitCode) => {
      clearTimeout(killTimer);
      const readyLine = stdout.split('\n').find((line) => line.startsWith(READY_MARKER));
      resolve({
        exitCode,
        stdout,
        stderr,
        state: readyLine === undefined ? null : (JSON.parse(readyLine.slice(READY_MARKER.length)) as ChildProcessState),
        crashToExitMs: crashedAtMs === null ? null : performance.now() - crashedAtMs,
        timedOut,
      });
    });
  });
}

interface IngestStub {
  readonly dsn: string;
  /** Every request body received, decompressed, exactly as it crossed the wire. */
  readonly bodies: string[];
  close(): Promise<void>;
}

/** Stands in for Sentry's ingest: accepts every envelope, keeps its raw bytes, answers 200. */
async function startIngestStub(): Promise<IngestStub> {
  const bodies: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      bodies.push((request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8'));
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  const port = await listen(server);
  return { dsn: `http://publickey@127.0.0.1:${port}/1`, bodies, close: () => closeServer(server) };
}

interface BlackHole {
  readonly dsn: string;
  connectionCount(): number;
  close(): Promise<void>;
}

/** Accepts the connection and never answers, so only the SDK's flush bound can end the wait. */
async function startBlackHole(): Promise<BlackHole> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createNetServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  const port = await listen(server);
  return {
    dsn: `http://publickey@127.0.0.1:${port}/1`,
    connectionCount: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

interface ReceivedEvent {
  readonly level?: string;
  readonly tags?: Record<string, string>;
  readonly exception?: {
    readonly values?: readonly { readonly value?: string; readonly stacktrace?: { readonly frames?: readonly unknown[] } }[];
  };
}

/** The event items of every envelope received. An envelope is a header line, then item header and payload lines. */
function eventsIn(bodies: readonly string[]): ReceivedEvent[] {
  const events: ReceivedEvent[] = [];
  for (const body of bodies) {
    const lines = body.split('\n').filter((line) => line.trim() !== '');
    for (let index = 1; index + 1 < lines.length; index += 2) {
      const itemHeader = JSON.parse(lines[index] ?? '{}') as { type?: string };
      if (itemHeader.type === 'event') events.push(JSON.parse(lines[index + 1] ?? '{}') as ReceivedEvent);
    }
  }
  return events;
}

/**
 * What "the same stderr" means, measured on SDK 11.16.0. The error itself, its header line, stack
 * frames and inspected properties, is byte-identical with and without a DSN. What differs is only
 * Node's own decoration around it: without a DSN Node's fatal handler prints a source excerpt
 * before the error (`file:line`, the source line, a caret, a blank line) and `Node.js vX.Y.Z` after
 * it. With a DSN the SDK prints the error with `console.error` and exits itself, so neither
 * appears. This strips exactly those two decorations and nothing else, so any other difference
 * (an extra SDK warning, a swallowed error, a different message) still fails the comparison.
 *
 * The excerpt is matched by its shape rather than a fixed line count, because Node lays it out
 * differently across versions: measured on Node 20.20.2, it can open with a blank line and can run
 * straight from the caret into the error with no blank line between them.
 */
function errorOnStderr(stderr: string): string {
  const lines = stderr.replace(/\r\n/g, '\n').split('\n');
  const isBlank = (index: number): boolean => index < lines.length && (lines[index] ?? '').trim() === '';

  let start = 0;
  while (isBlank(start)) start += 1;
  if (/:\d+$/.test(lines[start] ?? '') && /^\s*\^+\s*$/.test(lines[start + 2] ?? '')) {
    start += 3;
    while (isBlank(start)) start += 1;
  }

  let end = lines.length;
  while (end > start && isBlank(end - 1)) end -= 1;
  if (end > start && /^Node\.js v\d+\.\d+\.\d+$/.test(lines[end - 1] ?? '')) end -= 1;
  while (end > start && isBlank(end - 1)) end -= 1;
  return lines.slice(start, end).join('\n');
}

function runCrash(kind: CrashKind, overrides: Record<string, string>): Promise<ChildRun> {
  return runChild(CRASH_FIXTURE, [kind], overrides);
}

describe('crash semantics are identical with and without a DSN', () => {
  it.each(CRASH_KINDS)(
    '%s: same exit code, same error on stderr, no hang',
    async (kind) => {
      const ingest = await startIngestStub();
      try {
        const [withoutDsn, withDsn] = await Promise.all([runCrash(kind, {}), runCrash(kind, { SENTRY_DSN: ingest.dsn })]);

        expect(withoutDsn.timedOut).toBe(false);
        expect(withDsn.timedOut).toBe(false);
        expect(withoutDsn.exitCode).toBe(1);
        expect(withDsn.exitCode).toBe(withoutDsn.exitCode);

        const expectedError = errorOnStderr(withoutDsn.stderr);
        expect(expectedError).toContain('crash fixture');
        expect(errorOnStderr(withDsn.stderr)).toBe(expectedError);
        // Nothing stripped from the DSN side: the SDK prints the error and only the error.
        expect(withDsn.stderr.replace(/\r\n/g, '\n').trim()).toBe(expectedError);

        // Off is structural: no handler, no client, no loader hook.
        expect(withoutDsn.state).toEqual({
          uncaughtExceptionListeners: 0,
          unhandledRejectionListeners: 0,
          channelInjection: false,
          sentryClient: false,
        });
        // On: exactly Sentry's one handler, so it is the sole listener and exits; nothing on
        // unhandledRejection, so Node still raises every rejection as an uncaught exception.
        expect(withDsn.state).toEqual({
          uncaughtExceptionListeners: 1,
          unhandledRejectionListeners: 0,
          channelInjection: false,
          sentryClient: true,
        });

        // And the death was reported, once, as fatal.
        expect(eventsIn(ingest.bodies).map((event) => event.level)).toEqual(['fatal']);
      } finally {
        await ingest.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a Sentry that accepts and never answers holds a dying relay for at most the flush bound',
    async () => {
      const blackHole = await startBlackHole();
      try {
        const [withoutDsn, withDsn] = await Promise.all([
          runCrash('throw', {}),
          runCrash('throw', { SENTRY_DSN: blackHole.dsn }),
        ]);

        expect(withDsn.timedOut).toBe(false);
        expect(withDsn.exitCode).toBe(1);
        expect(errorOnStderr(withDsn.stderr)).toBe(errorOnStderr(withoutDsn.stderr));
        // It really did try to send, so what ended the wait was the bound, not a refused connection.
        expect(blackHole.connectionCount()).toBeGreaterThan(0);
        expect(withDsn.crashToExitMs).not.toBeNull();
        // The clock starts when this process handles the crash marker, so any delay on this side
        // shortens the measured wait. Half the bound still proves it waited rather than exiting
        // at once; the upper bound is the one that matters, and it has no such skew.
        expect(withDsn.crashToExitMs ?? 0).toBeGreaterThanOrEqual(FATAL_FLUSH_TIMEOUT_MS / 2);
        expect(withDsn.crashToExitMs ?? Infinity).toBeLessThan(FATAL_FLUSH_TIMEOUT_MS + 2_000);
      } finally {
        await blackHole.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('what reaches Sentry carries no slot id and no client IP', () => {
  const SLOT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const CLIENT_IP = '203.0.113.77';

  it(
    'holds over the wire for a captured error and a fatal one, through the real SDK and transport',
    async () => {
      const ingest = await startIngestStub();
      try {
        const run = await runChild(SCRUB_FIXTURE, [SLOT_ID, CLIENT_IP], {
          SENTRY_DSN: ingest.dsn,
          TRUST_PROXY: 'true',
          TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
        });
        expect(run.timedOut).toBe(false);
        expect(run.exitCode).toBe(1);
        // Positive control: the secrets really were in play. Node printed the fatal message whole.
        expect(run.stderr).toContain(SLOT_ID);
        expect(run.stderr).toContain(CLIENT_IP);

        const events = eventsIn(ingest.bodies);
        const captured = events.filter((event) => event.tags?.['capture_site'] === 'upgrade_handler');
        const fatal = events.filter((event) => event.level === 'fatal');
        // Two dials, one report: the per-site cap, end to end.
        expect(captured).toHaveLength(1);
        expect(fatal).toHaveLength(1);
        // Not vacuous: the events carry the error and its stack, just not the secrets.
        expect(captured[0]?.exception?.values?.[0]?.value).toBe('admission exploded for [redacted-hex] from [redacted-ip]');
        expect(fatal[0]?.exception?.values?.[0]?.value).toBe('fatal with [redacted-hex] from [redacted-ip]');
        expect(captured[0]?.exception?.values?.[0]?.stacktrace?.frames?.length ?? 0).toBeGreaterThan(0);

        expect(ingest.bodies.length).toBeGreaterThan(0);
        for (const body of ingest.bodies) {
          expect(body).not.toContain(SLOT_ID);
          expect(body).not.toContain(CLIENT_IP);
        }
      } finally {
        await ingest.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
