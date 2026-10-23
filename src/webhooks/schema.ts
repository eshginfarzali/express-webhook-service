import { z } from 'zod';

/**
 * Envelope every inbound webhook must follow. `data` is source-specific and
 * kept as an opaque object; the raw body is stored verbatim for auditing.
 */
export const webhookPayloadSchema = z.object({
  type: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/, 'must contain only letters, digits, "_", ".", ":" or "-"'),
  occurred_at: z.iso.datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

/** `x-webhook-id`: printable, bounded, so it is safe to store and log. */
export const webhookIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.:-]+$/);
