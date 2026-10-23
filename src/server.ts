import { ConfigError, loadConfig } from './config/index.js';
import { createLogger } from './logger.js';
import { startService } from './service.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config);
  const service = await startService(config, logger);

  const onSignal = (signal: NodeJS.Signals): void => {
    const forceExit = setTimeout(() => {
      logger.error(
        { timeoutMs: config.shutdownTimeoutMs },
        'graceful shutdown timed out, forcing exit',
      );
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    service.shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'error during shutdown');
        process.exit(1);
      },
    );
  };

  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `fatal: failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
