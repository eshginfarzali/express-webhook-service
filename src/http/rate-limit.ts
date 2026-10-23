import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { sendProblem } from './errors.js';

export interface RateLimitOptions {
  readonly windowMs: number;
  readonly max: number;
}

/**
 * Fixed-window limiter keyed by `<source>:<client ip>`, so one noisy sender
 * cannot exhaust the budget of other sources. IPv6 addresses are grouped by
 * /56 subnet. Uses the in-memory store (single instance).
 */
export function createWebhookRateLimiter(options: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const source = typeof req.params.source === 'string' ? req.params.source : '-';
      return `${source}:${ipKeyGenerator(req.ip ?? 'unknown')}`;
    },
    handler: (_req, res, _next, opts) => {
      sendProblem(res, {
        title: 'Too Many Requests',
        status: opts.statusCode,
        detail: 'Rate limit exceeded for this source and client',
      });
    },
  });
}
