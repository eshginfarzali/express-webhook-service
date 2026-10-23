import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';

describe('createLogger', () => {
  it('uses the configured level and service name', () => {
    const logger = createLogger({ env: 'test', logLevel: 'warn' });
    expect(logger.level).toBe('warn');
    expect(logger.bindings()).toMatchObject({ service: 'express-webhook-service' });
  });
});
