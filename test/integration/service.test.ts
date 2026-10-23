import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventHandler } from '../../src/delivery/handler.js';
import { startService, type RunningService } from '../../src/service.js';
import { samplePayload, signedHeaders, silentLogger, testConfig } from '../helpers.js';

let service: RunningService | undefined;
let dir: string | undefined;

afterEach(async () => {
  await service?.shutdown();
  service = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('startService', () => {
  it('serves HTTP, processes events end-to-end and shuts down gracefully', async () => {
    dir = mkdtempSync(join(tmpdir(), 'webhook-service-'));
    const config = testConfig({
      DATABASE_PATH: join(dir, 'nested', 'webhooks.db'),
      WORKER_POLL_INTERVAL_MS: '20',
    });
    const handler = vi.fn<EventHandler>(() => Promise.resolve());
    service = await startService(config, silentLogger, { handler });
    const base = `http://127.0.0.1:${service.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);

    const body = samplePayload();
    const accepted = await fetch(`${base}/webhooks/billing`, {
      method: 'POST',
      headers: { ...signedHeaders(body) },
      body,
    });
    expect(accepted.status).toBe(202);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledOnce();
    });

    const running = service;
    await Promise.all([running.shutdown('SIGTERM'), running.shutdown('SIGTERM')]);
    expect(running.server.listening).toBe(false);
    expect(running.worker.isRunning).toBe(false);
    expect(running.db.open).toBe(false);
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });

  it('uses the HTTP forwarder when DELIVERY_URL is configured', async () => {
    const config = testConfig({ DELIVERY_URL: 'http://127.0.0.1:9/unreachable' });
    service = await startService(config, silentLogger);
    expect(service.worker.isRunning).toBe(true);
  });
});
