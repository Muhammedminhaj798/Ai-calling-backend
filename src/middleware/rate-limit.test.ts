import '../../tests/env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from './error-handler.ts';
import { rateLimit } from './rate-limit.ts';

function fakeRes(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as Response & { headers: Record<string, string> };
}

describe('rateLimit', () => {
  it('allows `max` hits per window, then throws 429 with Retry-After, then recovers', () => {
    let now = 1_000_000;
    const limiter = rateLimit({ windowMs: 60_000, max: 2, key: (req) => req.ip, now: () => now });
    const req = { ip: '10.0.0.1' } as Request;
    let nextCalls = 0;
    const next: NextFunction = () => nextCalls++;

    limiter(req, fakeRes(), next);
    limiter(req, fakeRes(), next);
    assert.equal(nextCalls, 2);

    const res = fakeRes();
    assert.throws(
      () => limiter(req, res, next),
      (err: unknown) => err instanceof AppError && err.status === 429 && err.code === 'RATE_LIMITED',
    );
    assert.equal(res.headers['Retry-After'], '60');

    now += 60_001;
    limiter(req, fakeRes(), next);
    assert.equal(nextCalls, 3);
  });

  it('tracks keys independently and skips requests without a key', () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1, key: (req) => req.ip });
    let nextCalls = 0;
    const next: NextFunction = () => nextCalls++;
    limiter({ ip: 'a' } as Request, fakeRes(), next);
    limiter({ ip: 'b' } as Request, fakeRes(), next);
    limiter({ ip: undefined } as unknown as Request, fakeRes(), next);
    limiter({ ip: undefined } as unknown as Request, fakeRes(), next);
    assert.equal(nextCalls, 4);
    assert.throws(() => limiter({ ip: 'a' } as Request, fakeRes(), next));
  });
});
