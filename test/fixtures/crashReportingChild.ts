/**
 * Child process for test/crashReporting.process.test.ts. Runs the relay's real startup
 * (src/main.ts: config, crash reporting, relay, signal handlers, listen) under whatever environment
 * the parent hands it, prints the process-level state that crash semantics depend on, then crashes
 * the way argv[2] names. The parent runs it with and without SENTRY_DSN and compares the deaths.
 */
import { main } from '../../src/main.js';
import { CRASH_MARKER, isCrashKind, readProcessState, READY_MARKER, type CrashKind } from './crashReportingProtocol.js';

const CRASHES: Record<CrashKind, () => void> = {
  throw: () => {
    throw new Error('crash fixture: thrown from a timer');
  },
  reject: () => {
    void Promise.reject(new Error('crash fixture: rejected'));
  },
  // Not an Error: Node wraps it in ERR_UNHANDLED_REJECTION, a path of its own.
  'reject-string': () => {
    void Promise.reject('crash fixture: a bare string');
  },
  // Sentry's rejection integration silently ignores this name, even in strict mode.
  'reject-abort': () => {
    void Promise.reject(new DOMException('crash fixture: aborted', 'AbortError'));
  },
};

const crashKind = process.argv[2];
if (!isCrashKind(crashKind)) throw new Error(`crash fixture: unknown crash kind "${crashKind ?? ''}"`);

await main(process.env);
process.stdout.write(`${READY_MARKER}${JSON.stringify(readProcessState())}\n`);

setTimeout(() => {
  process.stdout.write(`${CRASH_MARKER}\n`);
  CRASHES[crashKind]();
}, 0);
