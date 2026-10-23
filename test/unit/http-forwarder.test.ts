import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryError,
  createHttpForwarder,
  createLogHandler,
  isRetryableStatus,
} from '../../src/delivery/handler.js';
import type { WebhookEvent } from '../../src/events/types.js';
import { pino } from 'pino';

const silentLogger = pino({ level: 'silent' });

const event: WebhookEvent = {
  id: '6f1c1b9e-0000-4000-8000-000000000001',
  source: 'billing',
  externalId: 'evt_1',
  type: 'invoice.paid',
  payload: '{"type":"invoice.paid","occurred_at":"2026-10-24T10:00:00Z","data":{"a":1}}',
  payloadHash: 'hash',
  status: 'processing',
  attempts: 1,
  nextAttemptAt: null,
  leaseExpiresAt: null,
  lastError: null,
  responseStatus: 202,
  responseBody: '{}',
  receivedAt: Date.UTC(2026, 9, 24, 10),
  updatedAt: Date.UTC(2026, 9, 24, 10),
  completedAt: null,
};

function forwarderWith(response: Response | Error) {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  return {
    fetch,
    forward: createHttpForwarder({ url: 'https://downstream.test/hook', timeoutMs: 1_000, fetch }),
  };
}

async function captureError(promise: Promise<unknown>): Promise<DeliveryError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DeliveryError);
  return error as DeliveryError;
}

describe('isRetryableStatus', () => {
  it.each([
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
    [422, false],
  ])('HTTP %i -> %s', (status, retryable) => {
    expect(isRetryableStatus(status)).toBe(retryable);
  });
});

describe('createHttpForwarder', () => {
  it('POSTs the event with an idempotency key and resolves on 2xx', async () => {
    const { fetch, forward } = forwarderWith(new Response(null, { status: 204 }));
    await expect(forward(event, { attempt: 2 })).resolves.toBeUndefined();

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://downstream.test/hook');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'idempotency-key': event.id,
      'x-webhook-source': 'billing',
      'x-delivery-attempt': '2',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      id: event.id,
      source: 'billing',
      externalId: 'evt_1',
      type: 'invoice.paid',
      receivedAt: '2026-10-24T10:00:00.000Z',
      payload: { type: 'invoice.paid', occurred_at: '2026-10-24T10:00:00Z', data: { a: 1 } },
    });
  });

  it('treats 5xx as retryable', async () => {
    const { forward } = forwarderWith(new Response('boom', { status: 503 }));
    const error = await captureError(forward(event, { attempt: 1 }));
    expect(error.retryable).toBe(true);
    expect(error.statusCode).toBe(503);
  });

  it('treats 4xx (other than 408/425/429) as non-retryable', async () => {
    const { forward } = forwarderWith(new Response('nope', { status: 400 }));
    const error = await captureError(forward(event, { attempt: 1 }));
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('downstream responded with HTTP 400');
  });

  it('treats network errors as retryable', async () => {
    const { forward } = forwarderWith(new TypeError('fetch failed'));
    const error = await captureError(forward(event, { attempt: 1 }));
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('fetch failed');
  });

  it('includes the low-level error code when available', async () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const { forward } = forwarderWith(refused);
    const error = await captureError(forward(event, { attempt: 1 }));
    expect(error.message).toBe('delivery request failed: fetch failed (ECONNREFUSED)');
  });

  it('handles non-Error rejections', async () => {
    const forward = createHttpForwarder({
      url: 'https://downstream.test/hook',
      timeoutMs: 1_000,
      // Deliberately a non-Error rejection: the forwarder must still produce a readable message.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      fetch: () => Promise.reject('socket hang up'),
    });
    const error = await captureError(forward(event, { attempt: 1 }));
    expect(error.message).toBe('delivery request failed: socket hang up');
  });

  it('reports timeouts', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { forward } = forwarderWith(timeout);
    const error = await captureError(forward(event, { attempt: 1 }));
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('timed out after 1000ms');
  });

  it('aborts a slow downstream after the timeout', async () => {
    const forward = createHttpForwarder({
      url: 'https://downstream.test/hook',
      timeoutMs: 100,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        }),
    });
    const error = await captureError(forward(event, { attempt: 1 }));
    expect(error.message).toContain('timed out after 100ms');
  });
});

describe('createLogHandler', () => {
  it('logs and resolves', async () => {
    const info = vi.spyOn(silentLogger, 'info');
    await createLogHandler(silentLogger)(event, { attempt: 1 });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: event.id, attempt: 1 }),
      'event processed (log handler)',
    );
  });
});
