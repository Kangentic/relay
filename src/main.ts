import { loadConfig } from './config.js';
import { FATAL_FLUSH_TIMEOUT_MS, startCrashReporting } from './crashReporting.js';
import { createLogger } from './logging.js';
import { createRelay } from './server.js';

/**
 * The relay process, in startup order: config, crash reporting, the relay, signal handlers, listen.
 * Separate from `index.ts` (which only calls it) so a test can run this exact sequence in a child
 * process and crash it, rather than a re-implementation of it.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<{ port: number }> {
  const config = loadConfig(env);
  const logger = createLogger(config);
  // Before the relay exists, so the fatal handler is in place before anything else can throw.
  const crashReporter = await startCrashReporting(config, { logger });
  const relay = createRelay(config, { logger, crashReporter });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    relay
      .close()
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error('error during shutdown', { error: error instanceof Error ? error.message : String(error) });
        crashReporter?.capture('shutdown', error);
        // Bounded, so an unreachable Sentry adds at most FATAL_FLUSH_TIMEOUT_MS to a failed shutdown.
        void (crashReporter?.flush(FATAL_FLUSH_TIMEOUT_MS) ?? Promise.resolve()).then(() => process.exit(1));
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return relay.listen();
}
