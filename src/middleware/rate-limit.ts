// Sliding-window rate limiter keyed by whatever `key` returns (IP, email, …). Returns 429 + Retry-After.
// ponytail: in-memory, per process; move the window store to Redis if more than one backend instance runs.
import type { Request, RequestHandler } from 'express';
import { AppError } from './error-handler.ts';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  key: (req: Request) => string | undefined;
  now?: () => number;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const hits = new Map<string, number[]>();
  const now = opts.now ?? Date.now;

  return (req, res, next) => {
    const key = opts.key(req);
    if (!key) return next();

    const t = now();
    const recent = (hits.get(key) ?? []).filter((ts) => t - ts < opts.windowMs);
    if (recent.length >= opts.max) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0]! + opts.windowMs - t) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      throw new AppError(429, 'RATE_LIMITED', 'Too many attempts, try again later', { retryAfterSec });
    }
    recent.push(t);
    hits.set(key, recent);

    if (hits.size > 5_000) {
      for (const [k, arr] of hits) if (arr.every((ts) => t - ts >= opts.windowMs)) hits.delete(k);
    }
    next();
  };
}
