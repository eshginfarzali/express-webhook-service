import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventHandler } from '../../src/delivery/handler.js';
import {
  ADMIN_TOKEN,
  CRM_SECRET,
  createTestContext,
  samplePayload,
  signedHeaders,
  type TestContext,
} from '../helpers.js';

let ctx: TestContext;
let failing: boolean;
const handler = vi.fn<EventHandler>(() =>
  failing ? Promise.reject(new Error('downstream unavailable')) : Promise.resolve(),
);

const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

async function receive(id: string, source = 'billing'): Promise<string> {
  const body = samplePayload();
  const secret = source === 'crm' ? CRM_SECRET : undefined;
  const res = await request(ctx.app)
    .post(`/webhooks/${source}`)
    .set(signedHeaders(body, { id, ...(secret ? { secret } : {}) }))
    .send(body);
  expect(res.status).toBe(202);
  return (res.body as { eventId: string }).eventId;
}

/** Runs the worker until the event reaches a terminal state, skipping backoff delays. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    vi.setSystemTime(Date.now() + 60_000);
    if ((await ctx.worker.runOnce()) === 0) return;
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  failing = false;
  handler.mockClear();
  ctx = createTestContext({ handler });
});

afterEach(() => {
  vi.useRealTimers();
  ctx.db.close();
});

describe('admin events API', () => {
  it.each([
    ['no header', {}],
    ['wrong token', { authorization: 'Bearer nope' }],
    ['wrong scheme', { authorization: `Basic ${ADMIN_TOKEN}` }],
  ])('rejects requests with %s', async (_name, headers) => {
    const res = await request(ctx.app).get('/events').set(headers);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('lists events newest first with filters and pagination', async () => {
    await receive('a');
    vi.setSystemTime(Date.now() + 1_000);
    await receive('b', 'crm');
    vi.setSystemTime(Date.now() + 1_000);
    await receive('c');

    const all = await request(ctx.app).get('/events').set(auth);
    expect(all.status).toBe(200);
    expect((all.body as { data: { externalId: string }[] }).data.map((e) => e.externalId)).toEqual([
      'c',
      'b',
      'a',
    ]);

    const billing = await request(ctx.app).get('/events?source=billing&limit=1&offset=1').set(auth);
    expect(billing.body).toMatchObject({
      data: [{ externalId: 'a', source: 'billing', status: 'pending' }],
      pagination: { limit: 1, offset: 1, count: 1 },
    });

    const succeeded = await request(ctx.app).get('/events?status=succeeded').set(auth);
    expect((succeeded.body as { data: unknown[] }).data).toHaveLength(0);
  });

  it('validates list query parameters', async () => {
    const res = await request(ctx.app).get('/events?status=bogus&limit=1000').set(auth);
    expect(res.status).toBe(400);
    expect((res.body as { errors: { path: string }[] }).errors.map((e) => e.path).sort()).toEqual([
      'limit',
      'status',
    ]);
  });

  it('returns a single event with payload and delivery attempts', async () => {
    const id = await receive('evt_detail');
    await ctx.worker.runOnce();

    const res = await request(ctx.app).get(`/events/${id}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      status: 'succeeded',
      attempts: 1,
      payload: { type: 'invoice.paid', data: { invoiceId: 'inv_42' } },
      deliveryAttempts: [{ attemptNumber: 1, outcome: 'success', error: null }],
    });
  });

  it('returns 404 for an unknown event', async () => {
    const res = await request(ctx.app).get('/events/does-not-exist').set(auth);
    expect(res.status).toBe(404);
  });

  describe('POST /events/:id/replay', () => {
    it('re-queues a dead-lettered event, which is then delivered', async () => {
      failing = true;
      const id = await receive('evt_dlq');
      await drain();
      const dead = await request(ctx.app).get(`/events/${id}`).set(auth);
      expect(dead.body).toMatchObject({ status: 'dead_lettered', attempts: 4 });

      failing = false;
      const replay = await request(ctx.app).post(`/events/${id}/replay`).set(auth);
      expect(replay.status).toBe(202);
      expect(replay.body).toMatchObject({ id, status: 'pending', attempts: 0 });
      expect(ctx.queued).toEqual([id, id]);

      await drain();
      const delivered = await request(ctx.app).get(`/events/${id}`).set(auth);
      expect(delivered.body).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect((delivered.body as { deliveryAttempts: unknown[] }).deliveryAttempts).toHaveLength(5);
    });

    it('returns 409 for an event that is not dead-lettered', async () => {
      const id = await receive('evt_pending');
      const res = await request(ctx.app).post(`/events/${id}/replay`).set(auth);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        detail: 'Only dead-lettered events can be replayed (current status: pending)',
      });
    });

    it('returns 404 for an unknown event', async () => {
      const res = await request(ctx.app).post('/events/missing/replay').set(auth);
      expect(res.status).toBe(404);
    });
  });
});
