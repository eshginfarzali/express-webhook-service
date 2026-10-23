import { z } from 'zod';

const SOURCE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MIN_SECRET_LENGTH = 16;

/**
 * Parses `WEBHOOK_SECRETS`, a comma-separated list of `source:secret` pairs,
 * e.g. `billing:whsec_abc...,crm:whsec_def...`.
 */
const webhookSecretsSchema = z.string().transform((raw, ctx): ReadonlyMap<string, string> => {
  const secrets = new Map<string, string>();
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'at least one source:secret pair is required' });
    return z.NEVER;
  }

  for (const [index, entry] of entries.entries()) {
    const separator = entry.indexOf(':');
    const source = separator === -1 ? '' : entry.slice(0, separator).trim();
    const secret = separator === -1 ? '' : entry.slice(separator + 1).trim();

    if (!SOURCE_NAME.test(source)) {
      ctx.addIssue({
        code: 'custom',
        // Never echo the entry itself: it contains the secret.
        message: `entry #${index + 1}: expected "source:secret" with a source matching ${String(SOURCE_NAME)}`,
      });
      continue;
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        message: `secret for source "${source}" must be at least ${MIN_SECRET_LENGTH} characters`,
      });
      continue;
    }
    if (secrets.has(source)) {
      ctx.addIssue({ code: 'custom', message: `duplicate source "${source}"` });
      continue;
    }
    secrets.set(source, secret);
  }

  return secrets;
});

const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: int(0, 65_535).default(3300),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: int(0, 10).default(0),

    DATABASE_PATH: z.string().min(1).default('./data/webhooks.db'),

    WEBHOOK_SECRETS: webhookSecretsSchema,
    SIGNATURE_TOLERANCE_SECONDS: int(1, 3600).default(300),
    BODY_LIMIT_BYTES: int(1_024, 10 * 1024 * 1024).default(512 * 1024),

    ADMIN_API_TOKEN: z.string().min(24, 'ADMIN_API_TOKEN must be at least 24 characters'),

    RATE_LIMIT_WINDOW_MS: int(1_000).default(60_000),
    RATE_LIMIT_MAX: int(1).default(120),

    RETRY_MAX_ATTEMPTS: int(1, 50).default(6),
    RETRY_BASE_DELAY_MS: int(1).default(1_000),
    RETRY_MAX_DELAY_MS: int(1).default(5 * 60_000),

    WORKER_POLL_INTERVAL_MS: int(10).default(1_000),
    WORKER_BATCH_SIZE: int(1, 500).default(10),
    WORKER_LEASE_MS: int(1_000).default(60_000),

    DELIVERY_URL: z.url({ protocol: /^https?$/ }).optional(),
    DELIVERY_TIMEOUT_MS: int(100, 120_000).default(10_000),

    SHUTDOWN_TIMEOUT_MS: int(100).default(10_000),
  })
  .refine((env) => env.RETRY_MAX_DELAY_MS >= env.RETRY_BASE_DELAY_MS, {
    message: 'RETRY_MAX_DELAY_MS must be greater than or equal to RETRY_BASE_DELAY_MS',
    path: ['RETRY_MAX_DELAY_MS'],
  })
  .refine((env) => env.WORKER_LEASE_MS > env.DELIVERY_TIMEOUT_MS, {
    message: 'WORKER_LEASE_MS must be greater than DELIVERY_TIMEOUT_MS',
    path: ['WORKER_LEASE_MS'],
  });

export type Env = z.infer<typeof envSchema>;

export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly host: string;
  readonly port: number;
  readonly logLevel: Env['LOG_LEVEL'];
  readonly trustProxy: number;
  readonly databasePath: string;
  readonly webhooks: {
    readonly secrets: ReadonlyMap<string, string>;
    readonly toleranceSeconds: number;
    readonly bodyLimitBytes: number;
  };
  readonly adminApiToken: string;
  readonly rateLimit: { readonly windowMs: number; readonly max: number };
  readonly retry: {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
  };
  readonly worker: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
  };
  readonly delivery: { readonly url: string | undefined; readonly timeoutMs: number };
  readonly shutdownTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as "unset" so `FOO=` in an .env file falls back to the default.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    databasePath: env.DATABASE_PATH,
    webhooks: {
      secrets: env.WEBHOOK_SECRETS,
      toleranceSeconds: env.SIGNATURE_TOLERANCE_SECONDS,
      bodyLimitBytes: env.BODY_LIMIT_BYTES,
    },
    adminApiToken: env.ADMIN_API_TOKEN,
    rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
    retry: {
      maxAttempts: env.RETRY_MAX_ATTEMPTS,
      baseDelayMs: env.RETRY_BASE_DELAY_MS,
      maxDelayMs: env.RETRY_MAX_DELAY_MS,
    },
    worker: {
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      batchSize: env.WORKER_BATCH_SIZE,
      leaseMs: env.WORKER_LEASE_MS,
    },
    delivery: { url: env.DELIVERY_URL, timeoutMs: env.DELIVERY_TIMEOUT_MS },
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  };
}
