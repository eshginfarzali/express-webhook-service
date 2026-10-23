export const EVENT_STATUSES = [
  'pending',
  'processing',
  'retrying',
  'succeeded',
  'dead_lettered',
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface WebhookEvent {
  readonly id: string;
  readonly source: string;
  /** Sender-provided id (the `x-webhook-id` header); unique per source. */
  readonly externalId: string;
  readonly type: string;
  /** The raw JSON body exactly as received. */
  readonly payload: string;
  readonly payloadHash: string;
  readonly status: EventStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly leaseExpiresAt: number | null;
  readonly lastError: string | null;
  readonly responseStatus: number;
  readonly responseBody: string;
  readonly receivedAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export interface DeliveryAttempt {
  readonly id: number;
  readonly eventId: string;
  readonly attemptNumber: number;
  readonly outcome: 'success' | 'failure';
  readonly error: string | null;
  readonly statusCode: number | null;
  readonly startedAt: number;
  readonly finishedAt: number;
}
