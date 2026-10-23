import { createHash, randomUUID } from 'node:crypto';
import express, { Router, type RequestHandler } from 'express';
import type { EventRepository } from '../events/repository.js';
import { HttpError } from '../http/errors.js';
import { webhookIdSchema, webhookPayloadSchema } from './schema.js';
import {
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  verifySignature,
} from './signature.js';

export const IDEMPOTENT_REPLAY_HEADER = 'Idempotent-Replayed';

export interface WebhookRouterOptions {
  readonly repository: EventRepository;
  readonly secrets: ReadonlyMap<string, string>;
  readonly toleranceSeconds: number;
  readonly bodyLimitBytes: number;
  readonly rateLimiter: RequestHandler;
  /** Called after a new event has been persisted. */
  readonly onAccepted: (eventId: string) => void;
  readonly now?: () => number;
}

const SIGNATURE_ERRORS = {
  missing_headers: `Missing ${WEBHOOK_ID_HEADER}, ${WEBHOOK_TIMESTAMP_HEADER} or ${WEBHOOK_SIGNATURE_HEADER} header`,
  malformed_timestamp: `${WEBHOOK_TIMESTAMP_HEADER} must be a Unix timestamp in seconds`,
  timestamp_out_of_tolerance: `${WEBHOOK_TIMESTAMP_HEADER} is outside the allowed tolerance window`,
  malformed_signature: `${WEBHOOK_SIGNATURE_HEADER} must have the form v1=<64 hex chars>`,
  signature_mismatch: 'Signature does not match the payload',
} as const;

export function createWebhookRouter(options: WebhookRouterOptions): Router {
  const now = options.now ?? Date.now;
  const router = Router();

  const resolveSource: RequestHandler<{ source: string }> = (req, res, next) => {
    const secret = options.secrets.get(req.params.source);
    if (secret === undefined) {
      throw new HttpError(404, 'Not Found', `Unknown webhook source "${req.params.source}"`);
    }
    res.locals.secret = secret;
    next();
  };

  const requireJson: RequestHandler = (req, _res, next) => {
    if (!req.is('application/json')) {
      throw new HttpError(415, 'Unsupported Media Type', 'Content-Type must be application/json');
    }
    next();
  };

  // Keep the body as raw bytes: the signature is computed over the exact payload received.
  const rawBody = express.raw({ type: 'application/json', limit: options.bodyLimitBytes });

  const handleWebhook: RequestHandler<{ source: string }> = (req, res) => {
    const { source } = req.params;
    const body: unknown = req.body;
    const raw = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    const id = req.get(WEBHOOK_ID_HEADER);

    const verification = verifySignature({
      secret: res.locals.secret as string,
      id,
      timestamp: req.get(WEBHOOK_TIMESTAMP_HEADER),
      signatureHeader: req.get(WEBHOOK_SIGNATURE_HEADER),
      rawBody: raw,
      toleranceSeconds: options.toleranceSeconds,
      nowSeconds: Math.floor(now() / 1000),
    });
    if (!verification.ok) {
      req.log.warn({ source, reason: verification.reason }, 'webhook signature rejected');
      throw new HttpError(401, 'Invalid Signature', SIGNATURE_ERRORS[verification.reason], {
        reason: verification.reason,
      });
    }

    // Only reached with an authenticated request, so validation details are safe to return.
    const externalId = webhookIdSchema.safeParse(id);
    if (!externalId.success) {
      throw new HttpError(
        400,
        'Bad Request',
        `${WEBHOOK_ID_HEADER} must match [A-Za-z0-9_.:-]{1,255}`,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Bad Request', 'Body is not valid JSON');
    }

    const payload = webhookPayloadSchema.safeParse(json);
    if (!payload.success) {
      throw new HttpError(422, 'Validation Failed', 'Payload does not match the webhook schema', {
        errors: payload.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      });
    }

    const payloadHash = createHash('sha256').update(raw).digest('hex');
    const eventId = randomUUID();
    const receivedAt = now();
    const responseStatus = 202;
    const responseBody = JSON.stringify({
      eventId,
      status: 'accepted',
      receivedAt: new Date(receivedAt).toISOString(),
    });

    const { event, created } = options.repository.insertIfAbsent({
      id: eventId,
      source,
      externalId: externalId.data,
      type: payload.data.type,
      payload: raw.toString('utf8'),
      payloadHash,
      responseStatus,
      responseBody,
      receivedAt,
    });

    if (!created) {
      if (event.payloadHash !== payloadHash) {
        throw new HttpError(
          409,
          'Idempotency Conflict',
          `${WEBHOOK_ID_HEADER} "${externalId.data}" was already used with a different payload`,
          { eventId: event.id },
        );
      }
      req.log.info(
        { source, eventId: event.id },
        'duplicate webhook delivery, returning stored response',
      );
      res
        .status(event.responseStatus)
        .set(IDEMPOTENT_REPLAY_HEADER, 'true')
        .type('application/json')
        .send(event.responseBody);
      return;
    }

    req.log.info({ source, eventId, type: event.type }, 'webhook accepted');
    options.onAccepted(eventId);
    res.status(responseStatus).type('application/json').send(responseBody);
  };

  router.post('/:source', options.rateLimiter, resolveSource, requireJson, rawBody, handleWebhook);
  return router;
}
