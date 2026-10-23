import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../http/errors.js';
import type { EventRepository } from './repository.js';
import { EVENT_STATUSES, type DeliveryAttempt, type WebhookEvent } from './types.js';

const listQuerySchema = z.object({
  status: z.enum(EVENT_STATUSES).optional(),
  source: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function serializeEvent(event: WebhookEvent) {
  return {
    id: event.id,
    source: event.source,
    externalId: event.externalId,
    type: event.type,
    status: event.status,
    attempts: event.attempts,
    nextAttemptAt: iso(event.nextAttemptAt),
    lastError: event.lastError,
    receivedAt: iso(event.receivedAt),
    updatedAt: iso(event.updatedAt),
    completedAt: iso(event.completedAt),
  };
}

function serializeAttempt(attempt: DeliveryAttempt) {
  return {
    attemptNumber: attempt.attemptNumber,
    outcome: attempt.outcome,
    error: attempt.error,
    statusCode: attempt.statusCode,
    startedAt: iso(attempt.startedAt),
    finishedAt: iso(attempt.finishedAt),
    durationMs: attempt.finishedAt - attempt.startedAt,
  };
}

export interface EventsRouterOptions {
  readonly repository: EventRepository;
  /** Called after an event was moved back to the queue. */
  readonly onReplayed: (eventId: string) => void;
  readonly now?: () => number;
}

export function createEventsRouter(options: EventsRouterOptions): Router {
  const { repository } = options;
  const now = options.now ?? Date.now;
  const router = Router();

  router.get('/', (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new HttpError(400, 'Bad Request', 'Invalid query parameters', {
        errors: query.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const events = repository.list(query.data);
    res.json({
      data: events.map(serializeEvent),
      pagination: { limit: query.data.limit, offset: query.data.offset, count: events.length },
    });
  });

  router.get('/:id', (req, res) => {
    const event = repository.findById(req.params.id);
    if (event === undefined) {
      throw new HttpError(404, 'Not Found', `Event "${req.params.id}" does not exist`);
    }
    res.json({
      ...serializeEvent(event),
      payload: JSON.parse(event.payload) as unknown,
      deliveryAttempts: repository.listAttempts(event.id).map(serializeAttempt),
    });
  });

  router.post('/:id/replay', (req, res) => {
    const result = repository.replay(req.params.id, now());
    switch (result.kind) {
      case 'not_found':
        throw new HttpError(404, 'Not Found', `Event "${req.params.id}" does not exist`);
      case 'not_dead_lettered':
        throw new HttpError(
          409,
          'Conflict',
          `Only dead-lettered events can be replayed (current status: ${result.status})`,
        );
      case 'replayed':
        req.log.info({ eventId: result.event.id }, 'dead-lettered event queued for replay');
        options.onReplayed(result.event.id);
        res.status(202).json(serializeEvent(result.event));
    }
  });

  return router;
}
