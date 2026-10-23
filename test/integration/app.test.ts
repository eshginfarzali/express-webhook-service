import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from '../helpers.js';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  if (ctx.db.open) ctx.db.close();
});

describe('GET /health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
  });

  it('reports 503 when the database is unavailable', async () => {
    ctx.db.close();
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', checks: { database: 'error' } });
  });
});

describe('cross-cutting middleware', () => {
  it('generates a request id when none is supplied', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates a well-formed incoming request id', async () => {
    const res = await request(ctx.app).get('/nope').set('x-request-id', 'req-abc_123');
    expect(res.headers['x-request-id']).toBe('req-abc_123');
    expect(res.body).toMatchObject({ requestId: 'req-abc_123' });
  });

  it('replaces a malformed incoming request id', async () => {
    const res = await request(ctx.app).get('/health').set('x-request-id', 'bad id <script>');
    expect(res.headers['x-request-id']).not.toBe('bad id <script>');
  });

  it('sets security headers via helmet', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns problem+json for unknown routes', async () => {
    const res = await request(ctx.app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      instance: '/nope',
    });
  });

  it('hides internal error details behind a generic 500', async () => {
    vi.spyOn(ctx.repository, 'list').mockImplementation(() => {
      throw new Error('SQLITE_CORRUPT: secret internals');
    });
    const res = await request(ctx.app)
      .get('/events')
      .set('authorization', `Bearer ${ctx.config.adminApiToken}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ title: 'Internal Server Error', status: 500 });
    expect(JSON.stringify(res.body)).not.toContain('secret internals');
  });

  it('honours TRUST_PROXY when keying the rate limiter', async () => {
    ctx.db.close();
    ctx = createTestContext({ env: { TRUST_PROXY: '1', RATE_LIMIT_MAX: '1' } });
    const send = (ip: string) =>
      request(ctx.app)
        .post('/webhooks/billing')
        .set('x-forwarded-for', ip)
        .set('content-type', 'application/json')
        .send('{}');

    expect((await send('203.0.113.1')).status).toBe(401);
    expect((await send('203.0.113.1')).status).toBe(429);
    expect((await send('203.0.113.2')).status).toBe(401);
  });
});
