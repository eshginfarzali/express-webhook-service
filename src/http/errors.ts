import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import type { Logger } from '../logger.js';

export interface ProblemDetails {
  readonly title: string;
  readonly status: number;
  readonly detail?: string | undefined;
  readonly [extension: string]: unknown;
}

/**
 * An error that maps to an RFC 9457 `application/problem+json` response.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = 'HttpError';
  }
}

export function sendProblem(res: Response, problem: ProblemDetails): void {
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({
      type: 'about:blank',
      ...problem,
      instance: res.req.originalUrl,
      requestId: res.req.id,
    });
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'Not Found', `No route for ${req.method} ${req.path}`));
};

interface BodyParserError {
  status: number;
  type: string;
  expose?: boolean;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof error.type === 'string' &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof HttpError) {
      sendProblem(res, {
        title: error.title,
        status: error.status,
        detail: error.detail,
        ...error.extensions,
      });
      return;
    }

    if (isBodyParserError(error) && error.status >= 400 && error.status < 500) {
      sendProblem(res, {
        title: error.status === 413 ? 'Payload Too Large' : 'Bad Request',
        status: error.status,
        detail: error.type,
      });
      return;
    }

    ((req.log as Logger | undefined) ?? logger).error({ err: error }, 'unhandled error');
    sendProblem(res, { title: 'Internal Server Error', status: 500 });
  };
}
