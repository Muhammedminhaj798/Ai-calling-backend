// Express app: middleware, routes, error handling. No listen() here so tests can import it.
import cors from 'cors';
import express from 'express';
import { env } from './config/env.ts';
import { healthRouter } from './health.ts';
import { errorHandler, notFoundHandler } from './middleware/error-handler.ts';
import { requestLogger } from './middleware/request-logger.ts';
import { telephonyWebhooksRouter } from './modules/telephony/telephony.routes.ts';
import { apiRouter } from './routes.ts';

export function createApp(opts: { trustProxyHops?: number } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // A hop count, never `true`: with `true` any client could set its own X-Forwarded-For (see env.ts).
  app.set('trust proxy', opts.trustProxyHops ?? env.TRUST_PROXY_HOPS);

  app.use(requestLogger);
  // API responses are per-user and may carry Set-Cookie; a CDN in front (the Vercel proxy honours upstream
  // cache headers) must never store them. Set before CORS and body parsing so preflights and parse errors
  // (400/413) are covered too.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  // Telephony providers post webhooks as form data.
  app.use(express.urlencoded({ extended: false }));
  // CSV imports are posted as text/csv bodies.
  app.use(express.text({ type: 'text/csv', limit: '5mb' }));

  app.use('/health', healthRouter);
  app.use('/api', apiRouter);
  // Provider webhooks: verified by the telephony adapter, not by JWT (ARCHITECTURE.md §B.3).
  app.use('/webhooks/telephony', telephonyWebhooksRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
