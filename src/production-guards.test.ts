// Production refuses the development call paths even if mock telephony reached it: mock telephony webhooks and the
// fixed "mock" media secret, TELEPHONY_PROVIDER=none, and the text simulator. Development keeps them. Every request
// here is refused (or rejected for authentication) before any service runs, so no database is touched.
import '../tests/env.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from './app.ts';
import { env } from './config/env.ts';
import { mockTelephony } from './integrations/telephony/mock.adapter.ts';
import { attachTelephonyWebSocket } from './media-server.ts';
import { getTelephonyAdapter } from './modules/telephony/telephony.service.ts';

const original = { NODE_ENV: env.NODE_ENV, TELEPHONY_PROVIDER: env.TELEPHONY_PROVIDER };
afterEach(() => Object.assign(env, original));

async function withServer<T>(fn: (base: string, port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(createApp());
  const wss = attachTelephonyWebSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Opens the media WebSocket; resolves with the HTTP status of a refused upgrade, or 101 when it was accepted. */
function mediaUpgrade(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', (err) => (err.message.includes('Unexpected server response') ? undefined : reject(err)));
  });
}

const post = (base: string, path: string, body: unknown = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('mock telephony in production', () => {
  it('getTelephonyAdapter refuses mock in production and returns it in development', () => {
    Object.assign(env, { NODE_ENV: 'production', TELEPHONY_PROVIDER: 'mock' });
    assert.throws(() => getTelephonyAdapter(), (err: { status?: number }) => err.status === 404);
    Object.assign(env, { NODE_ENV: 'development' });
    assert.equal(getTelephonyAdapter(), mockTelephony);
  });

  it('rejects mock webhooks (no verification would run) with 404', async () => {
    Object.assign(env, { NODE_ENV: 'production', TELEPHONY_PROVIDER: 'mock' });
    await withServer(async (base) => {
      for (const kind of ['incoming', 'status']) {
        const res = await post(base, `/webhooks/telephony/mock/anything/${kind}`, { callSid: 'x', from: '+919847012345' });
        assert.equal(res.status, 404, kind);
      }
    });
  });

  it('rejects the fixed "mock" media secret with 404, which development accepts', async () => {
    await withServer(async (_base, port) => {
      Object.assign(env, { NODE_ENV: 'production', TELEPHONY_PROVIDER: 'mock' });
      assert.equal(await mediaUpgrade(port, '/ws/telephony/mock/mock'), 404);
      Object.assign(env, { NODE_ENV: 'test' });
      assert.equal(await mediaUpgrade(port, '/ws/telephony/mock/mock'), 101);
      assert.equal(await mediaUpgrade(port, '/ws/telephony/mock/wrong'), 404);
    });
  });
});

describe('TELEPHONY_PROVIDER=none', () => {
  it('answers every telephony webhook and media stream with 404', async () => {
    Object.assign(env, { TELEPHONY_PROVIDER: 'none' });
    assert.throws(() => getTelephonyAdapter(), (err: { status?: number }) => err.status === 404);
    await withServer(async (base, port) => {
      assert.equal((await post(base, '/webhooks/telephony/none/x/incoming')).status, 404);
      assert.equal((await post(base, '/webhooks/telephony/mock/mock/incoming')).status, 404);
      assert.equal(await mediaUpgrade(port, '/ws/telephony/mock/mock'), 404);
    });
  });
});

describe('text simulator', () => {
  it('is disabled in production before authentication', async () => {
    Object.assign(env, { NODE_ENV: 'production' });
    await withServer(async (base) => {
      for (const path of ['/api/conversations', '/api/conversations/00000000-0000-4000-8000-000000000000/turns', '/api/conversations/00000000-0000-4000-8000-000000000000/end']) {
        const res = await post(base, path, { fromNumber: '+919847012345', text: 'hi' });
        assert.equal(res.status, 404, path);
        assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
      }
    });
  });

  it('stays available in development (it asks for authentication)', async () => {
    await withServer(async (base) => {
      assert.equal((await post(base, '/api/conversations', { fromNumber: '+919847012345' })).status, 401);
    });
  });
});
