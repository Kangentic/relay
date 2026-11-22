import type { CaptureSite, CrashReporter } from '../../src/crashReporting.js';

export interface RecordedCapture {
  readonly site: CaptureSite;
  readonly error: unknown;
}

/**
 * A CrashReporter that records what each capture site handed it, with no SDK behind it, so a test
 * can assert that a site reports without initializing Sentry inside the Vitest worker.
 */
export function recordingCrashReporter(captures: RecordedCapture[]): CrashReporter {
  return {
    capture: (site, error) => {
      captures.push({ site, error });
    },
    flush: async () => undefined,
  };
}
