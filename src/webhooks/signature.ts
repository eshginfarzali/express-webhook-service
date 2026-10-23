import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_ID_HEADER = 'x-webhook-id';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';

const SIGNATURE_VERSION = 'v1';
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/i;
const TIMESTAMP_PATTERN = /^\d{1,12}$/;

/**
 * HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`, hex encoded.
 *
 * Binding the event id and timestamp into the signed content means neither can
 * be altered without invalidating the signature: an attacker cannot replay an
 * old body with a fresh timestamp, nor reuse a signature under a new event id
 * to get past idempotency checks.
 */
export function computeSignature(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: Buffer | string,
): string {
  return createHmac('sha256', secret).update(`${id}.${timestamp}.`).update(rawBody).digest('hex');
}

/** Value for the `x-webhook-signature` header, e.g. `v1=5257a869...`. */
export function formatSignatureHeader(signature: string): string {
  return `${SIGNATURE_VERSION}=${signature}`;
}

export type SignatureFailure =
  | 'missing_headers'
  | 'malformed_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'malformed_signature'
  | 'signature_mismatch';

export type VerificationResult = { ok: true } | { ok: false; reason: SignatureFailure };

export interface VerifyInput {
  readonly secret: string;
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signatureHeader: string | undefined;
  readonly rawBody: Buffer;
  readonly toleranceSeconds: number;
  readonly nowSeconds: number;
}

export function verifySignature(input: VerifyInput): VerificationResult {
  const { id, timestamp, signatureHeader } = input;
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: 'missing_headers' };
  }

  if (!TIMESTAMP_PATTERN.test(timestamp)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  // Reject both stale and far-future timestamps to bound the replay window.
  if (Math.abs(input.nowSeconds - Number(timestamp)) > input.toleranceSeconds) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const match = SIGNATURE_PATTERN.exec(signatureHeader.trim());
  const provided = match?.[1];
  if (provided === undefined) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const expected = Buffer.from(computeSignature(input.secret, id, timestamp, input.rawBody), 'hex');
  const received = Buffer.from(provided, 'hex');
  // Both are 32 bytes (enforced by the pattern), so timingSafeEqual cannot throw.
  if (!timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}
