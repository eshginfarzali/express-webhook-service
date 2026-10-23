import type { Logger } from '../logger.js';
import type { WebhookEvent } from '../events/types.js';

export interface DeliveryContext {
  /** 1-based attempt number for this delivery. */
  readonly attempt: number;
}

/**
 * Processes a single event. Resolve on success, throw on failure.
 * Throw a {@link DeliveryError} with `retryable: false` to skip remaining retries.
 */
export type EventHandler = (event: WebhookEvent, context: DeliveryContext) => Promise<void>;

export class DeliveryError extends Error {
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    options: { retryable: boolean; statusCode?: number | undefined; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'DeliveryError';
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}

/** HTTP statuses worth retrying: timeouts, throttling and server-side errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** undici reports connection failures as "fetch failed" with the useful part in `cause`. */
function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string'
  ) {
    return `${error.message} (${cause.code})`;
  }
  return error.message;
}

export interface HttpForwarderOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Forwards each event as JSON to a downstream URL. The event id is sent as
 * `Idempotency-Key` so the receiver can de-duplicate at-least-once deliveries.
 */
export function createHttpForwarder(options: HttpForwarderOptions): EventHandler {
  const doFetch = options.fetch ?? globalThis.fetch;

  return async (event, { attempt }) => {
    let response: Response;
    try {
      response = await doFetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': event.id,
          'x-webhook-source': event.source,
          'x-delivery-attempt': String(attempt),
        },
        body: JSON.stringify({
          id: event.id,
          source: event.source,
          externalId: event.externalId,
          type: event.type,
          receivedAt: new Date(event.receivedAt).toISOString(),
          payload: JSON.parse(event.payload) as unknown,
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `timed out after ${options.timeoutMs}ms`
          : describeNetworkError(error);
      throw new DeliveryError(`delivery request failed: ${reason}`, {
        retryable: true,
        cause: error,
      });
    }

    // Drain the body so the underlying connection can be reused.
    await response.arrayBuffer().catch(() => undefined);

    if (!response.ok) {
      throw new DeliveryError(`downstream responded with HTTP ${response.status}`, {
        retryable: isRetryableStatus(response.status),
        statusCode: response.status,
      });
    }
  };
}

/** Default handler when no DELIVERY_URL is configured: records the event in the log. */
export function createLogHandler(logger: Logger): EventHandler {
  return (event, { attempt }) => {
    logger.info(
      { eventId: event.id, source: event.source, type: event.type, attempt },
      'event processed (log handler)',
    );
    return Promise.resolve();
  };
}
