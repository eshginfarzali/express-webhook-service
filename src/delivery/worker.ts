import type { EventRepository } from '../events/repository.js';
import type { WebhookEvent } from '../events/types.js';
import type { Logger } from '../logger.js';
import { decideAfterFailure, type RandomSource, type RetryPolicy } from '../retry/backoff.js';
import { DeliveryError, type EventHandler } from './handler.js';

export interface DeliveryWorkerOptions {
  readonly repository: EventRepository;
  readonly handler: EventHandler;
  readonly policy: RetryPolicy;
  readonly logger: Logger;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly now?: () => number;
  readonly random?: RandomSource;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Polls the event store for due events and runs the handler for each,
 * applying the retry policy on failure. Events are leased while processing,
 * so an event abandoned by a crashed process is picked up again once its
 * lease expires.
 */
export class DeliveryWorker {
  private readonly now: () => number;
  private readonly random: RandomSource | undefined;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private inFlight: Promise<number> | undefined;

  constructor(private readonly options: DeliveryWorkerOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random;
  }

  get isRunning(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  /** Requests an immediate poll, e.g. right after a new event was accepted. */
  kick(): void {
    if (!this.started || this.inFlight !== undefined) return;
    this.schedule(0);
  }

  /** Stops polling and waits for the in-flight batch to finish. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  /**
   * Claims and processes one batch of due events. Concurrent calls share the
   * same in-flight batch. Resolves with the number of events processed.
   */
  runOnce(): Promise<number> {
    this.inFlight ??= this.processBatch().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const processed = await this.runOnce();
      if (this.started && processed >= this.options.batchSize) {
        // A full batch suggests more work is waiting: poll again immediately.
        this.schedule(0);
        return;
      }
    } catch (error) {
      this.options.logger.error({ err: error }, 'delivery worker poll failed');
    }
    if (this.started) this.schedule(this.options.pollIntervalMs);
  }

  private async processBatch(): Promise<number> {
    const { repository, leaseMs, batchSize } = this.options;
    const events = repository.claimDue(this.now(), leaseMs, batchSize);
    await Promise.all(events.map((event) => this.processEvent(event)));
    return events.length;
  }

  private async processEvent(event: WebhookEvent): Promise<void> {
    const { repository, handler, policy, logger } = this.options;
    const attempt = event.attempts;
    const log = logger.child({ eventId: event.id, source: event.source, attempt });

    // A lease that expired mid-delivery (e.g. the process crashed) still consumed an attempt.
    if (attempt > policy.maxAttempts) {
      repository.markDeadLettered(event.id, 'max attempts exhausted (lease expired)', this.now());
      log.warn('event dead-lettered after lease expiry');
      return;
    }

    const startedAt = this.now();
    try {
      await handler(event, { attempt });
    } catch (error) {
      const finishedAt = this.now();
      const message = describe(error);
      const retryable = error instanceof DeliveryError ? error.retryable : true;
      const statusCode = error instanceof DeliveryError ? error.statusCode : undefined;

      repository.recordAttempt({
        eventId: event.id,
        attemptNumber: attempt,
        outcome: 'failure',
        error: message,
        statusCode,
        startedAt,
        finishedAt,
      });

      const decision = decideAfterFailure(attempt, policy, finishedAt, {
        retryable,
        ...(this.random ? { random: this.random } : {}),
      });

      if (decision.kind === 'retry') {
        repository.markRetrying(event.id, decision.nextAttemptAt, message, finishedAt);
        log.warn({ err: error, retryInMs: decision.delayMs }, 'delivery failed, retry scheduled');
      } else {
        repository.markDeadLettered(event.id, message, finishedAt);
        log.error({ err: error, reason: decision.reason }, 'delivery failed, event dead-lettered');
      }
      return;
    }

    const finishedAt = this.now();
    repository.recordAttempt({
      eventId: event.id,
      attemptNumber: attempt,
      outcome: 'success',
      startedAt,
      finishedAt,
    });
    repository.markSucceeded(event.id, finishedAt);
    log.info({ durationMs: finishedAt - startedAt }, 'event delivered');
  }
}
