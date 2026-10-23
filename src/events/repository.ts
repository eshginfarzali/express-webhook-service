import type { Db } from '../db/database.js';
import type { DeliveryAttempt, EventStatus, WebhookEvent } from './types.js';

interface EventRow {
  id: string;
  source: string;
  external_id: string;
  type: string;
  payload: string;
  payload_hash: string;
  status: EventStatus;
  attempts: number;
  next_attempt_at: number | null;
  lease_expires_at: number | null;
  last_error: string | null;
  response_status: number;
  response_body: string;
  received_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface AttemptRow {
  id: number;
  event_id: string;
  attempt_number: number;
  outcome: 'success' | 'failure';
  error: string | null;
  status_code: number | null;
  started_at: number;
  finished_at: number;
}

function toEvent(row: EventRow): WebhookEvent {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    type: row.type,
    payload: row.payload,
    payloadHash: row.payload_hash,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function toAttempt(row: AttemptRow): DeliveryAttempt {
  return {
    id: row.id,
    eventId: row.event_id,
    attemptNumber: row.attempt_number,
    outcome: row.outcome,
    error: row.error,
    statusCode: row.status_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface NewEvent {
  readonly id: string;
  readonly source: string;
  readonly externalId: string;
  readonly type: string;
  readonly payload: string;
  readonly payloadHash: string;
  readonly responseStatus: number;
  readonly responseBody: string;
  readonly receivedAt: number;
}

export interface NewAttempt {
  readonly eventId: string;
  readonly attemptNumber: number;
  readonly outcome: 'success' | 'failure';
  readonly error?: string | undefined;
  readonly statusCode?: number | undefined;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface ListEventsQuery {
  readonly status?: EventStatus | undefined;
  readonly source?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export type ReplayResult =
  | { readonly kind: 'replayed'; readonly event: WebhookEvent }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_dead_lettered'; readonly status: EventStatus };

const MAX_ERROR_LENGTH = 2_000;
const truncate = (value: string | undefined): string | null =>
  value === undefined ? null : value.slice(0, MAX_ERROR_LENGTH);

/**
 * Synchronous SQLite-backed persistence for events and delivery attempts.
 * better-sqlite3 is synchronous, so each method is atomic with respect to the
 * Node.js event loop; multi-statement operations additionally use transactions.
 */
export class EventRepository {
  private readonly statements;

  constructor(private readonly db: Db) {
    this.statements = {
      insert: db.prepare<NewEvent>(`
        INSERT INTO events (
          id, source, external_id, type, payload, payload_hash, status, attempts,
          next_attempt_at, response_status, response_body, received_at, updated_at
        ) VALUES (
          @id, @source, @externalId, @type, @payload, @payloadHash, 'pending', 0,
          @receivedAt, @responseStatus, @responseBody, @receivedAt, @receivedAt
        )
        ON CONFLICT (source, external_id) DO NOTHING
      `),
      findById: db.prepare<[string], EventRow>('SELECT * FROM events WHERE id = ?'),
      findByExternalId: db.prepare<[string, string], EventRow>(
        'SELECT * FROM events WHERE source = ? AND external_id = ?',
      ),
      claimDue: db.prepare<{ now: number; leaseExpiresAt: number; limit: number }, EventRow>(`
        UPDATE events
           SET status = 'processing',
               attempts = attempts + 1,
               lease_expires_at = @leaseExpiresAt,
               updated_at = @now
         WHERE id IN (
           SELECT id FROM events
            WHERE (status IN ('pending', 'retrying') AND next_attempt_at <= @now)
               OR (status = 'processing' AND lease_expires_at <= @now)
            ORDER BY next_attempt_at, received_at
            LIMIT @limit
         )
        RETURNING *
      `),
      markSucceeded: db.prepare<{ id: string; now: number }>(`
        UPDATE events
           SET status = 'succeeded', next_attempt_at = NULL, lease_expires_at = NULL,
               last_error = NULL, completed_at = @now, updated_at = @now
         WHERE id = @id
      `),
      markRetrying: db.prepare<{
        id: string;
        now: number;
        nextAttemptAt: number;
        error: string | null;
      }>(`
        UPDATE events
           SET status = 'retrying', next_attempt_at = @nextAttemptAt, lease_expires_at = NULL,
               last_error = @error, updated_at = @now
         WHERE id = @id
      `),
      markDeadLettered: db.prepare<{ id: string; now: number; error: string | null }>(`
        UPDATE events
           SET status = 'dead_lettered', next_attempt_at = NULL, lease_expires_at = NULL,
               last_error = @error, completed_at = @now, updated_at = @now
         WHERE id = @id
      `),
      replay: db.prepare<{ id: string; now: number }>(`
        UPDATE events
           SET status = 'pending', attempts = 0, next_attempt_at = @now, lease_expires_at = NULL,
               completed_at = NULL, updated_at = @now
         WHERE id = @id AND status = 'dead_lettered'
      `),
      insertAttempt: db.prepare<{
        eventId: string;
        attemptNumber: number;
        outcome: 'success' | 'failure';
        error: string | null;
        statusCode: number | null;
        startedAt: number;
        finishedAt: number;
      }>(`
        INSERT INTO delivery_attempts (
          event_id, attempt_number, outcome, error, status_code, started_at, finished_at
        ) VALUES (
          @eventId, @attemptNumber, @outcome, @error, @statusCode, @startedAt, @finishedAt
        )
      `),
      listAttempts: db.prepare<[string], AttemptRow>(
        'SELECT * FROM delivery_attempts WHERE event_id = ? ORDER BY id',
      ),
      ping: db.prepare<[], { ok: number }>('SELECT 1 AS ok'),
    };
  }

  /**
   * Inserts a new event unless one with the same (source, externalId) already
   * exists. Returns the stored event and whether it was created by this call.
   */
  insertIfAbsent(input: NewEvent): { event: WebhookEvent; created: boolean } {
    return this.db.transaction(() => {
      const { changes } = this.statements.insert.run(input);
      const row = this.statements.findByExternalId.get(input.source, input.externalId);
      if (row === undefined) {
        throw new Error('event vanished after insert');
      }
      return { event: toEvent(row), created: changes === 1 };
    })();
  }

  findById(id: string): WebhookEvent | undefined {
    const row = this.statements.findById.get(id);
    return row === undefined ? undefined : toEvent(row);
  }

  list(query: ListEventsQuery): WebhookEvent[] {
    const conditions: string[] = [];
    const params: Record<string, string | number> = { limit: query.limit, offset: query.offset };
    if (query.status !== undefined) {
      conditions.push('status = @status');
      params.status = query.status;
    }
    if (query.source !== undefined) {
      conditions.push('source = @source');
      params.source = query.source;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare<Record<string, string | number>, EventRow>(
        `SELECT * FROM events ${where} ORDER BY received_at DESC, id LIMIT @limit OFFSET @offset`,
      )
      .all(params);
    return rows.map(toEvent);
  }

  /**
   * Atomically leases up to `limit` due events (pending/retrying whose
   * `next_attempt_at` has passed, or processing events whose lease expired after
   * a crash) and increments their attempt counter.
   */
  claimDue(now: number, leaseMs: number, limit: number): WebhookEvent[] {
    return this.statements.claimDue.all({ now, leaseExpiresAt: now + leaseMs, limit }).map(toEvent);
  }

  markSucceeded(id: string, now: number): void {
    this.statements.markSucceeded.run({ id, now });
  }

  markRetrying(id: string, nextAttemptAt: number, error: string | undefined, now: number): void {
    this.statements.markRetrying.run({ id, now, nextAttemptAt, error: truncate(error) });
  }

  markDeadLettered(id: string, error: string | undefined, now: number): void {
    this.statements.markDeadLettered.run({ id, now, error: truncate(error) });
  }

  /** Moves a dead-lettered event back to `pending` with a fresh attempt budget. */
  replay(id: string, now: number): ReplayResult {
    return this.db.transaction((): ReplayResult => {
      const existing = this.statements.findById.get(id);
      if (existing === undefined) return { kind: 'not_found' };
      if (existing.status !== 'dead_lettered') {
        return { kind: 'not_dead_lettered', status: existing.status };
      }
      this.statements.replay.run({ id, now });
      const row = this.statements.findById.get(id);
      if (row === undefined) throw new Error('event vanished during replay');
      return { kind: 'replayed', event: toEvent(row) };
    })();
  }

  recordAttempt(attempt: NewAttempt): void {
    this.statements.insertAttempt.run({
      eventId: attempt.eventId,
      attemptNumber: attempt.attemptNumber,
      outcome: attempt.outcome,
      error: truncate(attempt.error),
      statusCode: attempt.statusCode ?? null,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
    });
  }

  listAttempts(eventId: string): DeliveryAttempt[] {
    return this.statements.listAttempts.all(eventId).map(toAttempt);
  }

  ping(): boolean {
    return this.statements.ping.get()?.ok === 1;
  }
}
