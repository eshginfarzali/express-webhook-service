import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/index.js';

const base = {
  WEBHOOK_SECRETS: 'billing:0123456789abcdef0123',
  ADMIN_API_TOKEN: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3300);
    expect(config.webhooks.toleranceSeconds).toBe(300);
    expect(config.retry).toEqual({ maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 300_000 });
    expect(config.delivery.url).toBeUndefined();
    expect(config.webhooks.secrets.get('billing')).toBe('0123456789abcdef0123');
  });

  it('parses multiple sources and coerces numbers', () => {
    const config = loadConfig({
      ...base,
      WEBHOOK_SECRETS: ' billing:0123456789abcdef0123 , crm-v2:abcdefghijklmnopqrst ,',
      PORT: '8080',
      RATE_LIMIT_MAX: '5',
      DELIVERY_URL: 'https://example.com/hooks',
    });
    expect([...config.webhooks.secrets.keys()]).toEqual(['billing', 'crm-v2']);
    expect(config.port).toBe(8080);
    expect(config.rateLimit.max).toBe(5);
    expect(config.delivery.url).toBe('https://example.com/hooks');
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...base, PORT: '', DELIVERY_URL: '' }).port).toBe(3300);
  });

  it.each([
    ['missing secrets', { WEBHOOK_SECRETS: undefined }, 'WEBHOOK_SECRETS'],
    ['empty secret list', { WEBHOOK_SECRETS: ' , ' }, 'at least one'],
    ['entry without colon', { WEBHOOK_SECRETS: 'billing' }, 'expected "source:secret"'],
    ['invalid source name', { WEBHOOK_SECRETS: 'Bad Name:0123456789abcdef0123' }, 'source:secret'],
    ['short secret', { WEBHOOK_SECRETS: 'billing:short' }, 'at least 16'],
    [
      'duplicate source',
      { WEBHOOK_SECRETS: 'a:0123456789abcdef0123,a:0123456789abcdef0124' },
      'duplicate',
    ],
    ['short admin token', { ADMIN_API_TOKEN: 'short' }, 'ADMIN_API_TOKEN'],
    ['invalid port', { PORT: '70000' }, 'PORT'],
    ['non-http delivery url', { DELIVERY_URL: 'ftp://example.com' }, 'DELIVERY_URL'],
    [
      'max delay below base',
      { RETRY_BASE_DELAY_MS: '5000', RETRY_MAX_DELAY_MS: '1000' },
      'RETRY_MAX_DELAY_MS',
    ],
    ['lease shorter than timeout', { WORKER_LEASE_MS: '5000' }, 'WORKER_LEASE_MS'],
  ])('rejects %s', (_name, overrides, message) => {
    expect(() => loadConfig({ ...base, ...overrides })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ...overrides })).toThrow(message);
  });

  it.each([
    ['invalid source name', 'Bad Name:leaky-secret-value-123'],
    ['short secret', 'billing:leaky-secret'],
  ])('never echoes secret values in errors (%s)', (_name, secrets) => {
    expect(() => loadConfig({ ...base, WEBHOOK_SECRETS: secrets })).toThrow(ConfigError);
    try {
      loadConfig({ ...base, WEBHOOK_SECRETS: secrets });
    } catch (error) {
      expect((error as Error).message).not.toContain('leaky');
    }
  });
});
