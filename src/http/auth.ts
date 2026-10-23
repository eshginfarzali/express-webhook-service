import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Bearer-token guard for the admin API. Both sides are hashed first so the
 * comparison is constant-time regardless of the supplied token's length.
 */
export function requireBearerToken(expectedToken: string): RequestHandler {
  const expected = digest(expectedToken);

  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token || !timingSafeEqual(digest(token), expected)) {
      res.set('WWW-Authenticate', 'Bearer');
      next(new HttpError(401, 'Unauthorized', 'A valid bearer token is required'));
      return;
    }
    next();
  };
}
