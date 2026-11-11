// Centralised error handling. Response shape (ARCHITECTURE.md §B.1):
//   { "error": { "code": "...", "message": "...", "details": ..., "requestId": "..." } }
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.ts';
import { Prisma } from '../generated/prisma/client.ts';
import { logger } from '../utils/logger.ts';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  const requestId = res.locals['requestId'] as string | undefined;

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        requestId,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error('request.error', { requestId, code: err.code, message: err.message });
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'A record with the same unique value already exists',
          details: { fields: err.meta?.['target'] },
          requestId,
        },
      });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found', requestId } });
      return;
    }
  }

  // Body-parser and other library errors carry an HTTP status; everything else is a 500.
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
  const original = err instanceof Error ? err : new Error(String(err));
  logger.error('request.error', {
    requestId,
    status,
    message: original.message,
    stack: env.NODE_ENV === 'production' ? undefined : original.stack,
  });
  res.status(status).json({
    error: {
      code: status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
      message: status < 500 ? original.message : 'Internal server error',
      requestId,
    },
  });
};
