import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { createRelay } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const relay = createRelay(config, { logger });

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
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await relay.listen();
}

main().catch((error: unknown) => {
  console.error('fatal error starting relay', error);
  process.exit(1);
});
