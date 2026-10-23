import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './config/index.js';
import type { EventRepository } from './events/repository.js';
import { createEventsRouter } from './events/router.js';
import { requireBearerToken } from './http/auth.js';
import { createErrorHandler, notFoundHandler } from './http/errors.js';
import { createWebhookRateLimiter } from './http/rate-limit.js';
import type { Logger } from './logger.js';
import { createWebhookRouter } from './webhooks/router.js';

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface AppDependencies {
  readonly config: Config;
  readonly logger: Logger;
  readonly repository: EventRepository;
  /** Notified whenever new work is queued (new event or replay). */
  readonly onWorkQueued?: (eventId: string) => void;
  readonly now?: () => number;
}

export function createApp(deps: AppDependencies): Express {
  const { config, logger, repository } = deps;
  const onWorkQueued = deps.onWorkQueued ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy > 0) {
    app.set('trust proxy', config.trustProxy);
  }

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers[REQUEST_ID_HEADER];
        const id =
          typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
      customLogLevel: (_req, res, error) => {
        if (error !== undefined || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
      // Keep access logs compact: no response headers, no request headers beyond the essentials.
      serializers: {
        req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());

  app.get('/health', (_req, res) => {
    let database: 'ok' | 'error' = 'ok';
    try {
      if (!repository.ping()) database = 'error';
    } catch {
      database = 'error';
    }
    const healthy = database === 'ok';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      checks: { database },
    });
  });

  app.use(
    '/webhooks',
    createWebhookRouter({
      repository,
      secrets: config.webhooks.secrets,
      toleranceSeconds: config.webhooks.toleranceSeconds,
      bodyLimitBytes: config.webhooks.bodyLimitBytes,
      rateLimiter: createWebhookRateLimiter(config.rateLimit),
      onAccepted: onWorkQueued,
      now,
    }),
  );

  app.use(
    '/events',
    requireBearerToken(config.adminApiToken),
    createEventsRouter({ repository, onReplayed: onWorkQueued, now }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
