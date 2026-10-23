import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import type { Config } from './config/index.js';
import { openDatabase, type Db } from './db/database.js';
import { createHttpForwarder, createLogHandler, type EventHandler } from './delivery/handler.js';
import { DeliveryWorker } from './delivery/worker.js';
import { EventRepository } from './events/repository.js';
import type { Logger } from './logger.js';

export interface RunningService {
  readonly server: Server;
  readonly db: Db;
  readonly worker: DeliveryWorker;
  readonly port: number;
  /** Stops accepting requests, drains the worker and closes the database. Idempotent. */
  shutdown(signal?: string): Promise<void>;
}

export interface StartOptions {
  /** Overrides the handler derived from DELIVERY_URL (useful in tests). */
  readonly handler?: EventHandler;
}

/**
 * Wires the database, worker and HTTP server together and starts listening.
 */
export async function startService(
  config: Config,
  logger: Logger,
  options: StartOptions = {},
): Promise<RunningService> {
  const db = openDatabase(config.databasePath);
  const repository = new EventRepository(db);

  const handler =
    options.handler ??
    (config.delivery.url === undefined
      ? createLogHandler(logger)
      : createHttpForwarder({ url: config.delivery.url, timeoutMs: config.delivery.timeoutMs }));

  const worker = new DeliveryWorker({
    repository,
    handler,
    logger: logger.child({ component: 'worker' }),
    policy: { ...config.retry, jitter: 'full' },
    pollIntervalMs: config.worker.pollIntervalMs,
    batchSize: config.worker.batchSize,
    leaseMs: config.worker.leaseMs,
  });

  const app = createApp({
    config,
    logger,
    repository,
    onWorkQueued: () => {
      worker.kick();
    },
  });
  const server = app.listen(config.port, config.host);
  await once(server, 'listening');
  worker.start();

  const port = (server.address() as AddressInfo).port;
  logger.info(
    { host: config.host, port, delivery: config.delivery.url === undefined ? 'log' : 'http' },
    'webhook service listening',
  );

  let shuttingDown: Promise<void> | undefined;

  const shutdown = (signal = 'shutdown'): Promise<void> => {
    shuttingDown ??= (async () => {
      logger.info({ signal }, 'shutting down gracefully');
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      // Stop keep-alive sockets that have no request in flight so close() can complete.
      server.closeIdleConnections();
      await Promise.all([serverClosed, worker.stop()]);
      db.close();
      logger.info('shutdown complete');
    })();
    return shuttingDown;
  };

  return { server, db, worker, port, shutdown };
}
