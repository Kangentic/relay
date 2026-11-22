/**
 * With no SENTRY_DSN the SDK module is never imported, not merely never initialized: importing
 * @sentry/node has side effects of its own. Its own file because vi.mock replaces the module for
 * every import in the file, and this mock exists only to count whether the module was loaded.
 */
import { describe, expect, it, vi } from 'vitest';
// The whole startup graph, imported statically: none of it may load the SDK on import either.
import '../src/main.js';
import { startCrashReporting } from '../src/crashReporting.js';
import { createLogger } from '../src/logging.js';

const sdk = vi.hoisted(() => ({ loadCount: 0, initCalls: [] as unknown[] }));

vi.mock('@sentry/node', () => {
  // A factory runs when the module is first imported, and only then.
  sdk.loadCount += 1;
  return {
    init: (options: unknown) => {
      sdk.initCalls.push(options);
    },
    onUncaughtExceptionIntegration: () => ({ name: 'OnUncaughtException' }),
    captureException: () => 'event-id',
    flush: async () => true,
  };
});

const logger = createLogger({ logLevel: 'error', logSlotHashing: true, slotLogSalt: 'x' });

describe('crash reporting with no DSN', () => {
  it('never imports the SDK, so no handler, client or connection can exist', async () => {
    const listenersBefore = process.listenerCount('uncaughtException');

    const reporter = await startCrashReporting({ sentryDsn: null, sentryEnvironment: 'production' }, { logger });

    expect(reporter).toBeNull();
    expect(sdk.loadCount).toBe(0);
    expect(sdk.initCalls).toEqual([]);
    expect(process.listenerCount('uncaughtException')).toBe(listenersBefore);
  });

  it('does import it once a DSN is set, which is what makes the probe above able to see an import', async () => {
    const reporter = await startCrashReporting(
      { sentryDsn: 'https://publickey@o1.ingest.sentry.io/1', sentryEnvironment: 'production' },
      { logger },
    );

    expect(reporter).not.toBeNull();
    expect(sdk.loadCount).toBe(1);
    expect(sdk.initCalls).toHaveLength(1);
  });
});
