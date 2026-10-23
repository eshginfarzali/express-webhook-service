import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeSignature,
  formatSignatureHeader,
  verifySignature,
  type VerifyInput,
} from '../../src/webhooks/signature.js';

const secret = 'whsec_unit_test_secret_value';
const body = Buffer.from('{"type":"ping","occurred_at":"2026-10-24T10:00:00Z","data":{}}');
const nowSeconds = 1_761_300_000;

function input(overrides: Partial<VerifyInput> = {}): VerifyInput {
  const timestamp = String(nowSeconds);
  return {
    secret,
    id: 'evt_1',
    timestamp,
    signatureHeader: formatSignatureHeader(computeSignature(secret, 'evt_1', timestamp, body)),
    rawBody: body,
    toleranceSeconds: 300,
    nowSeconds,
    ...overrides,
  };
}

describe('computeSignature', () => {
  it('is HMAC-SHA256 over "<id>.<timestamp>.<body>" in hex', () => {
    const expected = createHmac('sha256', secret)
      .update(`evt_1.${nowSeconds}.${body.toString()}`)
      .digest('hex');
    expect(computeSignature(secret, 'evt_1', String(nowSeconds), body)).toBe(expected);
    expect(computeSignature(secret, 'evt_1', String(nowSeconds), body.toString())).toBe(expected);
  });
});

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    expect(verifySignature(input())).toEqual({ ok: true });
  });

  it('accepts uppercase hex and surrounding whitespace', () => {
    const valid = input();
    expect(
      verifySignature({
        ...valid,
        signatureHeader: ` ${valid.signatureHeader?.toUpperCase().replace('V1', 'v1') ?? ''} `,
      }),
    ).toEqual({ ok: true });
  });

  it.each([
    ['id', { id: undefined }],
    ['timestamp', { timestamp: undefined }],
    ['signature', { signatureHeader: undefined }],
    ['empty signature', { signatureHeader: '' }],
  ])('rejects a missing %s header', (_name, overrides) => {
    expect(verifySignature(input(overrides))).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects a tampered body', () => {
    expect(verifySignature(input({ rawBody: Buffer.from(`${body.toString()} `) }))).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a signature produced with another secret', () => {
    const signatureHeader = formatSignatureHeader(
      computeSignature('another_secret_value_123', 'evt_1', String(nowSeconds), body),
    );
    expect(verifySignature(input({ signatureHeader }))).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a valid signature presented under a different event id', () => {
    expect(verifySignature(input({ id: 'evt_2' }))).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a timestamp older than the tolerance window (replay)', () => {
    const timestamp = String(nowSeconds - 301);
    const signatureHeader = formatSignatureHeader(
      computeSignature(secret, 'evt_1', timestamp, body),
    );
    expect(verifySignature(input({ timestamp, signatureHeader }))).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('rejects a timestamp too far in the future', () => {
    const timestamp = String(nowSeconds + 301);
    const signatureHeader = formatSignatureHeader(
      computeSignature(secret, 'evt_1', timestamp, body),
    );
    expect(verifySignature(input({ timestamp, signatureHeader }))).toEqual({
      ok: false,
      reason: 'timestamp_out_of_tolerance',
    });
  });

  it('accepts a timestamp exactly at the edge of the window', () => {
    const timestamp = String(nowSeconds - 300);
    const signatureHeader = formatSignatureHeader(
      computeSignature(secret, 'evt_1', timestamp, body),
    );
    expect(verifySignature(input({ timestamp, signatureHeader }))).toEqual({ ok: true });
  });

  it.each(['abc', '-5', '1.5', '1e9', ''.padEnd(13, '9')])(
    'rejects malformed timestamp %s',
    (timestamp) => {
      expect(verifySignature(input({ timestamp }))).toEqual({
        ok: false,
        reason: 'malformed_timestamp',
      });
    },
  );

  it.each(['sha256=abc', 'v1=xyz', `v2=${'a'.repeat(64)}`, `v1=${'a'.repeat(63)}`, 'deadbeef'])(
    'rejects malformed signature header %s',
    (signatureHeader) => {
      expect(verifySignature(input({ signatureHeader }))).toEqual({
        ok: false,
        reason: 'malformed_signature',
      });
    },
  );
});
