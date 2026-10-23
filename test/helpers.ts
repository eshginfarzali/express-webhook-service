import { pino } from 'pino';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config/index.js';
import { openDatabase, type Db } from '../src/db/database.js';
import type { EventHandler } from '../src/delivery/handler.js';
import { DeliveryWorker } from '../src/delivery/worker.js';
import { EventRepository } from '../src/events/repository.js';
import type { RetryPolicy } from '../src/retry/backoff.js';
import {
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  computeSignature,
  formatSignatureHeader,
} from '../src/webhooks/signature.js';

export const BILLING_SECRET = 'whsec_billing_test_secret_0123456789';
export const CRM_SECRET = 'whsec_crm_test_secret_abcdefghijklmn';
export const ADMIN_TOKEN = 'admin-test-token-0123456789abcdef';

export const silentLogger = pino({ level: 'silent' });

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: '0',
    HOST: '127.0.0.1',
    DATABASE_PATH: ':memory:',
    WEBHOOK_SECRETS: `billing:${BILLING_SECRET},crm:${CRM_SECRET}`,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    RATE_LIMIT_MAX: '1000',
    ...overrides,
  });
}

export const testPolicy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 'none',
};

export interface TestContext {
  readonly config: Config;
  readonly db: Db;
  readonly repository: EventRepository;
  readonly worker: DeliveryWorker;
  readonly app: ReturnType<typeof createApp>;
  readonly queued: string[];
}

export function createTestContext(
  options: {
    env?: Record<string, string>;
    handler?: EventHandler;
    policy?: RetryPolicy;
    now?: () => number;
  } = {},
): TestContext {
  const config = testConfig(options.env);
  const db = openDatabase(':memory:');
  const repository = new EventRepository(db);
  const queued: string[] = [];
  const worker = new DeliveryWorker({
    repository,
    handler: options.handler ?? (() => Promise.resolve()),
    policy: options.policy ?? testPolicy,
    logger: silentLogger,
    pollIntervalMs: 1_000,
    batchSize: 10,
    leaseMs: 30_000,
    ...(options.now ? { now: options.now } : {}),
  });
  const app = createApp({
    config,
    logger: silentLogger,
    repository,
    onWorkQueued: (id) => queued.push(id),
    ...(options.now ? { now: options.now } : {}),
  });
  return { config, db, repository, worker, app, queued };
}

export type SignedHeaders = Record<string, string>;

export function signedHeaders(
  body: string,
  options: { id?: string; secret?: string; timestamp?: number } = {},
): SignedHeaders {
  const id = options.id ?? 'evt_123';
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = computeSignature(options.secret ?? BILLING_SECRET, id, timestamp, body);
  return {
    'content-type': 'application/json',
    [WEBHOOK_ID_HEADER]: id,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_SIGNATURE_HEADER]: formatSignatureHeader(signature),
  };
}

export function samplePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'invoice.paid',
    occurred_at: '2026-10-24T10:00:00Z',
    data: { invoiceId: 'inv_42', amount: 1999, currency: 'EUR' },
    ...overrides,
  });
}
