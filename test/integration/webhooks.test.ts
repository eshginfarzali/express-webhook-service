import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CRM_SECRET,
  createTestContext,
  samplePayload,
  signedHeaders,
  type TestContext,
} from '../helpers.js';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.db.close();
});

const post = (body: string, headers: Record<string, string>, source = 'billing') =>
  request(ctx.app).post(`/webhooks/${source}`).set(headers).send(body);

describe('POST /webhooks/:source', () => {
  describe('signature verification', () => {
    it('accepts a correctly signed webhook and persists it', async () => {
      const body = samplePayload();
      const res = await post(body, signedHeaders(body));

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: 'accepted', eventId: expect.any(String) as string });
      expect(res.headers['idempotent-replayed']).toBeUndefined();

      const event = ctx.repository.findById((res.body as { eventId: string }).eventId);
      expect(event).toMatchObject({
        source: 'billing',
        externalId: 'evt_123',
        type: 'invoice.paid',
        status: 'pending',
        attempts: 0,
        payload: body,
      });
      expect(ctx.queued).toEqual([event?.id]);
    });

    it('uses the per-source secret', async () => {
      const body = samplePayload();
      const ok = await post(body, signedHeaders(body, { secret: CRM_SECRET }), 'crm');
      expect(ok.status).toBe(202);

      const wrongSource = await post(body, signedHeaders(body, { secret: CRM_SECRET, id: 'x2' }));
      expect(wrongSource.status).toBe(401);
    });

    it('rejects an invalid signature with 401 problem+json', async () => {
      const body = samplePayload();
      const headers = signedHeaders(body);
      const res = await post(samplePayload({ type: 'invoice.refunded' }), headers);

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        title: 'Invalid Signature',
        status: 401,
        reason: 'signature_mismatch',
      });
      expect(ctx.repository.list({ limit: 10, offset: 0 })).toHaveLength(0);
    });

    it('rejects an expired timestamp (replay protection)', async () => {
      const body = samplePayload();
      const sixMinutesAgo = Math.floor(Date.now() / 1000) - 360;
      const res = await post(body, signedHeaders(body, { timestamp: sixMinutesAgo }));

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ reason: 'timestamp_out_of_tolerance' });
    });

    it('rejects requests without signature headers', async () => {
      const res = await post(samplePayload(), { 'content-type': 'application/json' });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ reason: 'missing_headers' });
    });

    it('rejects a malformed signature header', async () => {
      const body = samplePayload();
      const res = await post(body, { ...signedHeaders(body), 'x-webhook-signature': 'sha256=abc' });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ reason: 'malformed_signature' });
    });
  });

  describe('request validation', () => {
    it('returns 404 for an unknown source', async () => {
      const body = samplePayload();
      const res = await post(body, signedHeaders(body), 'unknown');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ detail: 'Unknown webhook source "unknown"' });
    });

    it('returns 415 for non-JSON content types', async () => {
      const res = await request(ctx.app)
        .post('/webhooks/billing')
        .set('content-type', 'text/plain')
        .send('hello');
      expect(res.status).toBe(415);
    });

    it('returns 413 when the body exceeds the limit', async () => {
      ctx.db.close();
      ctx = createTestContext({ env: { BODY_LIMIT_BYTES: '1024' } });
      const body = samplePayload({ data: { blob: 'x'.repeat(2_000) } });
      const res = await post(body, signedHeaders(body));
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ title: 'Payload Too Large' });
    });

    it('returns 400 for a signed body that is not valid JSON', async () => {
      const body = '{"type": "invoice.paid",';
      const res = await post(body, signedHeaders(body));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ detail: 'Body is not valid JSON' });
    });

    it('returns 400 for an invalid webhook id', async () => {
      const body = samplePayload();
      const res = await post(body, signedHeaders(body, { id: 'has spaces' }));
      expect(res.status).toBe(400);
    });

    it('returns 422 with Zod issues for a payload that fails the schema', async () => {
      const body = JSON.stringify({ type: 'bad type!', occurred_at: 'yesterday', data: [] });
      const res = await post(body, signedHeaders(body));

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ title: 'Validation Failed', status: 422 });
      const paths = (res.body as { errors: { path: string }[] }).errors.map((e) => e.path).sort();
      expect(paths).toEqual(['data', 'occurred_at', 'type']);
      expect(ctx.repository.list({ limit: 10, offset: 0 })).toHaveLength(0);
    });

    it('reports missing required fields', async () => {
      const body = JSON.stringify({ data: {} });
      const res = await post(body, signedHeaders(body));
      expect(res.status).toBe(422);
      expect((res.body as { errors: { path: string; code: string }[] }).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'type', code: 'invalid_type' }),
          expect.objectContaining({ path: 'occurred_at', code: 'invalid_type' }),
        ]),
      );
    });
  });

  describe('idempotency', () => {
    it('returns the stored response for a duplicate delivery without reprocessing', async () => {
      const body = samplePayload();
      const first = await post(body, signedHeaders(body));
      // Re-signed with a newer timestamp, as a sender's retry would be.
      const second = await post(
        body,
        signedHeaders(body, { timestamp: Math.floor(Date.now() / 1000) + 5 }),
      );

      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(ctx.repository.list({ limit: 10, offset: 0 })).toHaveLength(1);
      expect(ctx.queued).toHaveLength(1);
    });

    it('returns the stored response even after the event was processed', async () => {
      const body = samplePayload();
      const first = await post(body, signedHeaders(body));
      await ctx.worker.runOnce();
      const second = await post(body, signedHeaders(body));

      expect(second.body).toEqual(first.body);
      expect(ctx.repository.listAttempts((first.body as { eventId: string }).eventId)).toHaveLength(
        1,
      );
    });

    it('scopes idempotency keys per source', async () => {
      const body = samplePayload();
      await post(body, signedHeaders(body));
      const res = await post(body, signedHeaders(body, { secret: CRM_SECRET }), 'crm');
      expect(res.status).toBe(202);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(ctx.repository.list({ limit: 10, offset: 0 })).toHaveLength(2);
    });

    it('returns 409 when an id is reused with a different payload', async () => {
      const body = samplePayload();
      await post(body, signedHeaders(body));
      const other = samplePayload({ type: 'invoice.voided' });
      const res = await post(other, signedHeaders(other));

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ title: 'Idempotency Conflict' });
    });
  });

  describe('rate limiting', () => {
    it('returns 429 once a source/IP exceeds its budget, independently per source', async () => {
      ctx.db.close();
      ctx = createTestContext({ env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' } });

      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const body = samplePayload();
        const res = await post(body, signedHeaders(body, { id: `evt_rl_${i}` }));
        statuses.push(res.status);
      }
      expect(statuses).toEqual([202, 202, 429]);

      const body = samplePayload();
      const limited = await post(body, signedHeaders(body, { id: 'evt_rl_x' }));
      expect(limited.body).toMatchObject({ title: 'Too Many Requests', status: 429 });
      expect(limited.headers.ratelimit).toBeDefined();

      const otherSource = await post(body, signedHeaders(body, { secret: CRM_SECRET }), 'crm');
      expect(otherSource.status).toBe(202);
    });
  });
});
