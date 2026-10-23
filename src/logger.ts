import { pino, type Logger } from 'pino';
import type { Config } from './config/index.js';

export type { Logger } from 'pino';

export function createLogger(config: Pick<Config, 'env' | 'logLevel'>): Logger {
  const pretty = config.env === 'development' && process.stdout.isTTY;

  return pino({
    level: config.logLevel,
    base: { service: 'express-webhook-service' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-webhook-signature"]',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
