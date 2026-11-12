// App-level transport behaviour: which X-Forwarded-For entry becomes req.ip for each TRUST_PROXY_HOPS value
// (observed through the per-IP login limiter) and Cache-Control on API responses. No database is touched:
// every login here fails validation before the service runs.
import '../tests/env.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

process.env['LOGIN_RATE_LIMIT_PER_IP'] = '2';
const { createApp } = await import('./app.ts');

async function withApp<T>(trustProxyHops: number, fn: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer(createApp({ trustProxyHops }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** An invalid login: passes the per-IP limiter, then fails validation (400) without reaching the database. */
const badLogin = (base: string, forwardedFor?: string) =>
  fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) }, body: '{}' });

describe('trust proxy', () => {
  it('0 hops (default): X-Forwarded-For is ignored, so a client cannot dodge the per-IP limit', async () => {
    await withApp(0, async (base) => {
      assert.equal((await badLogin(base, '198.51.100.1')).status, 400);
      assert.equal((await badLogin(base, '198.51.100.2')).status, 400);
      const third = await badLogin(base, '198.51.100.3');
      assert.equal(third.status, 429, 'all three count against the connecting address');
      assert.ok(third.headers.get('retry-after'));
    });
  });

  it('1 hop (directly behind Render): the rightmost entry, the one the proxy appended, is the client', async () => {
    await withApp(1, async (base) => {
      assert.equal((await badLogin(base, '203.0.113.5')).status, 400);
      assert.equal((await badLogin(base, 'spoofed-by-client, 203.0.113.5')).status, 400, 'a client-supplied left entry is ignored');
      assert.equal((await badLogin(base, '203.0.113.5')).status, 429);
      assert.equal((await badLogin(base, '203.0.113.6')).status, 400, 'another client has its own window');
    });
  });

  it('2 hops (Vercel proxy, then Render): the visitor entry Vercel set is the client', async () => {
    await withApp(2, async (base) => {
      const viaVercel = (visitor: string) => badLogin(base, `${visitor}, 192.0.2.50`);
      assert.equal((await viaVercel('198.51.100.20')).status, 400);
      assert.equal((await viaVercel('198.51.100.20')).status, 400);
      assert.equal((await viaVercel('198.51.100.20')).status, 429);
      assert.equal((await viaVercel('198.51.100.21')).status, 400, 'visitors behind the same Vercel egress IP are not lumped together');
    });
  });
});

describe('API caching headers', () => {
  it('every /api response is Cache-Control: no-store, so a CDN in front never stores it', async () => {
    await withApp(0, async (base) => {
      const unauthorized = await fetch(`${base}/api/settings`);
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
      const notFound = await fetch(`${base}/api/does-not-exist`);
      assert.equal(notFound.headers.get('cache-control'), 'no-store');
      // Responses that end before the API router runs: body-parse error and CORS preflight.
      const badJson = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
      assert.equal(badJson.status, 400);
      assert.equal(badJson.headers.get('cache-control'), 'no-store');
      const preflight = await fetch(`${base}/api/auth/login`, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('cache-control'), 'no-store');
    });
  });
});
