/**
 * src/main.ts's shutdown path. A failed `relay.close()` is reported under its own capture site,
 * flushed within the fatal bound, and still ends the process with 1, with crash reporting on or off.
 * The relay and the reporter are stubbed, so no port is bound and no SDK is loaded, and the signal
 * handler `main()` installs is called directly rather than by signalling the Vitest worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrashReporter } from '../src/crashReporting.js';

const harness = vi.hoisted(() => ({
  closeRelay: (): Promise<void> => Promise.resolve(),
  crashReporter: null as CrashReporter | null,
}));

vi.mock('../src/server.js', () => ({
  createRelay: () => ({
    close: () => harness.closeRelay(),
    listen: () => Promise.resolve({ port: 0 }),
  }),
}));

// Partial: main.ts also imports FATAL_FLUSH_TIMEOUT_MS from this module, and the bound it passes
// to flush is part of what this file pins.
vi.mock('../src/crashReporting.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/crashReporting.js')>()),
  startCrashReporting: () => Promise.resolve(harness.crashReporter),
}));

import { main } from '../src/main.js';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

let events: string[] = [];
let listenersBeforeMain = new Map<string, Set<unknown>>();

function eventRecordingReporter(): CrashReporter {
  return {
    capture: (site, error) => {
      events.push(`capture ${site}: ${error instanceof Error ? error.message : String(error)}`);
    },
    flush: (timeoutMs) => {
      events.push(`flush ${timeoutMs}`);
      return Promise.resolve();
    },
  };
}

/** Starts main() and returns the SIGTERM handler it installed. */
async function startMainAndTakeSigtermHandler(): Promise<() => void> {
  listenersBeforeMain = new Map(SHUTDOWN_SIGNALS.map((signal) => [signal, new Set<unknown>(process.listeners(signal))]));
  await main({});
  const added = process.listeners('SIGTERM').filter((listener) => !listenersBeforeMain.get('SIGTERM')?.has(listener));
  expect(added).toHaveLength(1);
  const handler = added[0];
  if (handler === undefined) throw new Error('main() installed no SIGTERM handler');
  return () => handler('SIGTERM');
}

beforeEach(() => {
  events = [];
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    events.push(`exit ${String(code)}`);
    return undefined as never;
  });
  // The real logger writes one line per shutdown step; keep the test output to the assertions.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  // Nothing main() installed may outlive the test: a live SIGTERM handler wired to a stub relay
  // would turn a real signal to this worker into a call on a stub.
  for (const signal of SHUTDOWN_SIGNALS) {
    const before = listenersBeforeMain.get(signal) ?? new Set<unknown>();
    for (const listener of process.listeners(signal)) {
      if (!before.has(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
});

describe('main() shutting down', () => {
  it('reports a failed close, flushes within the 2 s bound, then exits 1', async () => {
    harness.crashReporter = eventRecordingReporter();
    harness.closeRelay = () => Promise.reject(new Error('close exploded'));

    const sendSigterm = await startMainAndTakeSigtermHandler();
    sendSigterm();
    await vi.waitFor(() => expect(events).toContain('exit 1'));

    // In this order: the report is queued before the flush, and the exit waits for the flush.
    expect(events).toEqual(['capture shutdown: close exploded', 'flush 2000', 'exit 1']);
  });

  it('still exits 1 after a failed close when crash reporting is off', async () => {
    harness.crashReporter = null;
    harness.closeRelay = () => Promise.reject(new Error('close exploded'));

    const sendSigterm = await startMainAndTakeSigtermHandler();
    sendSigterm();
    await vi.waitFor(() => expect(events).toContain('exit 1'));

    expect(events).toEqual(['exit 1']);
  });

  it('exits 0 after a clean close, reporting nothing', async () => {
    harness.crashReporter = eventRecordingReporter();
    harness.closeRelay = () => Promise.resolve();

    const sendSigterm = await startMainAndTakeSigtermHandler();
    sendSigterm();
    await vi.waitFor(() => expect(events).toContain('exit 0'));

    expect(events).toEqual(['exit 0']);
  });
});
