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
    init: (options: { dsn?: string }) => {
      sdk.initCalls.push(options);
      if (options.dsn?.includes('init-fails') === true) throw new Error('sdk could not initialize');
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

describe('crash reporting with a DSN the SDK cannot honor', () => {
  it('fails startup rather than running on unreported', async () => {
    // A configured DSN that silently reports nothing is the failure this exists to remove, and
    // a relay that will not start fails the deploy's health gate, which rolls back.
    await expect(
      startCrashReporting(
        { sentryDsn: 'https://init-fails@o1.ingest.sentry.io/1', sentryEnvironment: 'production' },
        { logger },
      ),
    ).rejects.toThrow('sdk could not initialize');
  });
});
