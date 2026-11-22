/**
 * What the crash-reporting child fixtures and test/crashReporting.process.test.ts agree on: the
 * stdout markers, the crash kinds, and the shape of the state report. Kept apart from the fixtures
 * so the parent test can import it without evaluating a fixture's top level.
 */
export const READY_MARKER = 'CRASH-FIXTURE-READY ';
export const CRASH_MARKER = 'CRASH-FIXTURE-CRASHING';

/**
 * `reject`, `reject-string` and `reject-abort` are the cases that break if
 * `onUnhandledRejectionIntegration` is ever added back: in its default `warn` mode the relay
 * survives all three, and in `strict` mode it still survives `reject-abort` without a word.
 */
export const CRASH_KINDS = ['throw', 'reject', 'reject-string', 'reject-abort'] as const;
export type CrashKind = (typeof CRASH_KINDS)[number];

export function isCrashKind(value: string | undefined): value is CrashKind {
  return (CRASH_KINDS as readonly string[]).includes(value ?? '');
}

export interface ChildProcessState {
  /** Node's default termination holds only while this is 0, or 1 with Sentry's own handler. */
  readonly uncaughtExceptionListeners: number;
  /** Must be 0 either way: any listener here stops Node raising a rejection as a crash. */
  readonly unhandledRejectionListeners: number;
  /** Whether the SDK's diagnostics-channel injection (a module loader hook) ever ran. */
  readonly channelInjection: boolean;
  /** Whether a Sentry client was ever initialized in this process. */
  readonly sentryClient: boolean;
}

export function readProcessState(): ChildProcessState {
  const orchestrion = (globalThis as { __SENTRY_ORCHESTRION__?: { runtime?: unknown; runtimeUnavailable?: unknown } })
    .__SENTRY_ORCHESTRION__;
  return {
    uncaughtExceptionListeners: process.listenerCount('uncaughtException'),
    unhandledRejectionListeners: process.listenerCount('unhandledRejection'),
    channelInjection: orchestrion?.runtime !== undefined || orchestrion?.runtimeUnavailable !== undefined,
    sentryClient: '__SENTRY__' in globalThis,
  };
}
