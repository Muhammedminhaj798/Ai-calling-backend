// Assigns a request id (honouring a well-formed incoming X-Request-Id) and logs one line per request.
// Logs the path only, never the query string or body, so credentials in URLs never reach the logs.
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../utils/logger.ts';

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export const requestLogger: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.locals['requestId'] = requestId;
  res.setHeader('X-Request-Id', requestId);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    logger.info('http.request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100,
    });
  });
  next();
};
