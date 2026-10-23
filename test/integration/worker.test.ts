import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../../src/db/database.js';
import { DeliveryError, type EventHandler } from '../../src/delivery/handler.js';
import { DeliveryWorker } from '../../src/delivery/worker.js';
import { EventRepository } from '../../src/events/repository.js';
import type { RetryPolicy } from '../../src/retry/backoff.js';
import { silentLogger } from '../helpers.js';

const policy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 'none',
};
const START = Date.UTC(2026, 9, 24, 12, 0, 0);

let db: Db;
let repository: EventRepository;

function insertEvent(externalId = 'evt_1') {
  return repository.insertIfAbsent({
    id: `id-${externalId}`,
    source: 'billing',
    externalId,
    type: 'invoice.paid',
    payload: '{}',
    payloadHash: 'hash',
    responseStatus: 202,
    responseBody: '{}',
    receivedAt: Date.now(),
  }).event;
}

function createWorker(handler: EventHandler, overrides: Partial<RetryPolicy> = {}) {
  return new DeliveryWorker({
    repository,
    handler,
    policy: { ...policy, ...overrides },
    logger: silentLogger,
    pollIntervalMs: 250,
    batchSize: 10,
    leaseMs: 30_000,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  db = openDatabase(':memory:');
  repository = new EventRepository(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('DeliveryWorker', () => {
  it('delivers a pending event on the first attempt', async () => {
    const handler = vi.fn<EventHandler>(() => Promise.resolve());
    const event = insertEvent();
    const worker = createWorker(handler);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await worker.stop();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }), { attempt: 1 });
    expect(repository.findById(event.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(repository.listAttempts(event.id)).toEqual([
      expect.objectContaining({ attemptNumber: 1, outcome: 'success' }),
    ]);
  });

  it('retries with exponential backoff and then succeeds', async () => {
    const handler = vi
      .fn<EventHandler>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new DeliveryError('HTTP 503', { retryable: true, statusCode: 503 }))
      .mockResolvedValue(undefined);
    const event = insertEvent();
    const worker = createWorker(handler);
    worker.start();

    // Attempt 1 fails immediately -> retry scheduled 1s later.
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.findById(event.id)).toMatchObject({
      status: 'retrying',
      attempts: 1,
      nextAttemptAt: START + 1_000,
      lastError: 'connection reset',
    });

    // Not due yet: polling before the backoff elapses must not trigger a delivery.
    await vi.advanceTimersByTimeAsync(900);
    expect(handler).toHaveBeenCalledTimes(1);

    // Attempt 2 at +1s fails -> retry scheduled 2s after that.
    await vi.advanceTimersByTimeAsync(100);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(repository.findById(event.id)).toMatchObject({
      status: 'retrying',
      attempts: 2,
      nextAttemptAt: START + 1_000 + 2_000,
    });

    // Attempt 3 at +3s succeeds.
    await vi.advanceTimersByTimeAsync(2_000);
    await worker.stop();

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls.map(([, context]) => context.attempt)).toEqual([1, 2, 3]);
    expect(repository.findById(event.id)).toMatchObject({
      status: 'succeeded',
      attempts: 3,
      lastError: null,
      completedAt: START + 3_000,
    });
    expect(repository.listAttempts(event.id)).toEqual([
      expect.objectContaining({ attemptNumber: 1, outcome: 'failure', error: 'connection reset' }),
      expect.objectContaining({ attemptNumber: 2, outcome: 'failure', statusCode: 503 }),
      expect.objectContaining({ attemptNumber: 3, outcome: 'success', error: null }),
    ]);
  });

  it('dead-letters an event after maxAttempts failures', async () => {
    const handler = vi.fn<EventHandler>(() => Promise.reject(new Error('downstream unavailable')));
    const event = insertEvent();
    const worker = createWorker(handler);
    worker.start();

    // Delays: 1s, 2s, 4s -> 4 attempts within 7s.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(handler).toHaveBeenCalledTimes(4);
    expect(repository.findById(event.id)).toMatchObject({
      status: 'dead_lettered',
      attempts: 4,
      nextAttemptAt: null,
      lastError: 'downstream unavailable',
      completedAt: START + 7_000,
    });

    // Nothing else happens afterwards.
    await vi.advanceTimersByTimeAsync(60_000);
    await worker.stop();
    expect(handler).toHaveBeenCalledTimes(4);
    expect(repository.listAttempts(event.id).map((a) => a.outcome)).toEqual([
      'failure',
      'failure',
      'failure',
      'failure',
    ]);
  });

  it('dead-letters immediately on a non-retryable error', async () => {
    const handler = vi.fn<EventHandler>(() =>
      Promise.reject(new DeliveryError('HTTP 400', { retryable: false, statusCode: 400 })),
    );
    const event = insertEvent();
    const worker = createWorker(handler);
    worker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await worker.stop();

    expect(handler).toHaveBeenCalledOnce();
    expect(repository.findById(event.id)).toMatchObject({ status: 'dead_lettered', attempts: 1 });
  });

  it('re-processes a replayed event with a fresh attempt budget', async () => {
    let healthy = false;
    const handler = vi.fn<EventHandler>(() =>
      healthy ? Promise.resolve() : Promise.reject(new Error('still down')),
    );
    const event = insertEvent();
    const worker = createWorker(handler, { maxAttempts: 2 });
    worker.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(repository.findById(event.id)?.status).toBe('dead_lettered');

    healthy = true;
    expect(repository.replay(event.id, Date.now()).kind).toBe('replayed');
    worker.kick();
    await vi.advanceTimersByTimeAsync(0);
    await worker.stop();

    expect(repository.findById(event.id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(repository.listAttempts(event.id).map((a) => a.outcome)).toEqual([
      'failure',
      'failure',
      'success',
    ]);
  });

  it('picks up events whose lease expired (crash recovery)', async () => {
    const event = insertEvent();
    // Simulate a process that claimed the event and died mid-delivery.
    expect(repository.claimDue(Date.now(), 5_000, 10)).toHaveLength(1);
    expect(repository.claimDue(Date.now(), 5_000, 10)).toHaveLength(0);

    const handler = vi.fn<EventHandler>(() => Promise.resolve());
    const worker = createWorker(handler);
    worker.start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await worker.stop();
    expect(handler).toHaveBeenCalledWith(expect.anything(), { attempt: 2 });
    expect(repository.findById(event.id)?.status).toBe('succeeded');
  });

  it('dead-letters a reclaimed event that already exhausted its attempts', async () => {
    const event = insertEvent();
    repository.claimDue(Date.now(), 1_000, 10);
    vi.setSystemTime(START + 2_000);
    const handler = vi.fn<EventHandler>(() => Promise.resolve());
    const worker = createWorker(handler, { maxAttempts: 1 });
    await worker.runOnce();

    expect(handler).not.toHaveBeenCalled();
    expect(repository.findById(event.id)).toMatchObject({
      status: 'dead_lettered',
      lastError: 'max attempts exhausted (lease expired)',
    });
  });

  it('shares one in-flight batch between concurrent runOnce calls', async () => {
    let release: () => void = () => undefined;
    const handler = vi.fn<EventHandler>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    insertEvent();
    const worker = createWorker(handler);
    const first = worker.runOnce();
    const second = worker.runOnce();
    expect(second).toBe(first);
    release();
    await expect(first).resolves.toBe(1);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('stop() waits for in-flight deliveries to finish', async () => {
    let release: () => void = () => undefined;
    const handler = vi.fn<EventHandler>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const event = insertEvent();
    const worker = createWorker(handler);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.isRunning).toBe(true);

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(worker.isRunning).toBe(false);
    expect(repository.findById(event.id)?.status).toBe('succeeded');
  });

  it('keeps polling after a storage error', async () => {
    const error = new Error('disk I/O error');
    const claim = vi.spyOn(repository, 'claimDue').mockImplementationOnce(() => {
      throw error;
    });
    const logError = vi.spyOn(silentLogger, 'error');
    const handler = vi.fn<EventHandler>(() => Promise.resolve());
    insertEvent();
    const worker = createWorker(handler);
    worker.start();
    await vi.advanceTimersByTimeAsync(250);
    await worker.stop();

    expect(logError).toHaveBeenCalledWith({ err: error }, 'delivery worker poll failed');
    expect(claim).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('drains a backlog larger than one batch without waiting for the poll interval', async () => {
    for (let i = 0; i < 25; i += 1) insertEvent(`evt_${i}`);
    const handler = vi.fn<EventHandler>(() => Promise.resolve());
    const worker = createWorker(handler);
    worker.start();
    // Well below the 250ms poll interval: only the immediate re-polls can drain 3 batches.
    await vi.advanceTimersByTimeAsync(10);
    await worker.stop();
    expect(handler).toHaveBeenCalledTimes(25);
  });
});
