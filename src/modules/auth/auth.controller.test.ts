// HTTP contract of /api/auth through the real app, routes and controller, with the auth service backed by the
// in-memory repository (no database): the refresh token is a cookie only, never in a body, and never logged.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

// Log everything, so the check below covers every line the app writes. Application modules are imported
// dynamically below, after this, because env.ts reads LOG_LEVEL once when it is first loaded.
process.env['LOG_LEVEL'] = 'debug';
// Every logger line starts with {"time": — keep them for inspection instead of printing them.
const logLines: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (String(chunk).startsWith('{"time":')) return logLines.push(String(chunk)) > 0;
    return write(chunk, ...rest);
  }) as typeof stream.write;
}

const { createFakeAuthRepository } = await import('../../../tests/fakes/auth-repository.ts');
const { createApp } = await import('../../app.ts');
const { authService, createAuthService } = await import('./auth.service.ts');
const repo = createFakeAuthRepository();
Object.assign(authService, createAuthService({ repo, audit: async () => {} }));

const cookieValue = (res: Response) => /^refresh_token=([^;]*)/.exec(res.headers.getSetCookie().find((c) => c.startsWith('refresh_token=')) ?? '')?.[1];

describe('auth HTTP contract', () => {
  let server: http.Server;
  let base = '';
  const seen: string[] = []; // every refresh token handed out, for the log check
  const post = (path: string, opts: { cookie?: string; body?: unknown } = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.cookie ? { cookie: `refresh_token=${opts.cookie}` } : {}) },
      body: JSON.stringify(opts.body ?? {}),
    });
  let user: Awaited<ReturnType<typeof repo.addUser>>;

  before(async () => {
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    user = await repo.addUser();
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  async function login() {
    const res = await post('/api/auth/login', { body: { email: user.email, password: user.password } });
    assert.equal(res.status, 200);
    const token = cookieValue(res)!;
    seen.push(token);
    return { res, token, text: await res.text() };
  }

  it('login and refresh return the refresh token only as an HttpOnly cookie, never in the JSON body', async () => {
    const { res, token, text } = await login();
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['accessToken', 'expiresIn', 'tokenType', 'user']);
    assert.ok(!text.includes(token));
    const cookie = res.headers.getSetCookie()[0]!;
    assert.match(cookie, /; Path=\/api\/auth/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Strict/);

    const refreshed = await post('/api/auth/refresh', { cookie: token });
    assert.equal(refreshed.status, 200);
    const next = cookieValue(refreshed)!;
    seen.push(next);
    assert.notEqual(next, token);
    const body = await refreshed.text();
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['accessToken', 'expiresIn', 'tokenType', 'user']);
    assert.ok(!body.includes(next));
  });

  it('a refresh token in the request body is ignored: the cookie is the only credential', async () => {
    const { token } = await login();
    const res = await post('/api/auth/refresh', { body: { refreshToken: token } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.message, 'No refresh token provided');
    assert.ok(await post('/api/auth/refresh', { cookie: token }).then((r) => r.status === 200), 'the token was not consumed');
  });

  it('the previous cookie within the grace window gets 401 REFRESH_TOKEN_SUPERSEDED and no Set-Cookie', async () => {
    const { token } = await login();
    const rotated = await post('/api/auth/refresh', { cookie: token });
    seen.push(cookieValue(rotated)!);

    const again = await post('/api/auth/refresh', { cookie: token });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error.code, 'REFRESH_TOKEN_SUPERSEDED');
    assert.deepEqual(again.headers.getSetCookie(), [], 'a refused refresh never touches the cookie the browser may already have updated');
  });

  it('concurrent refreshes with one cookie: one 200, the rest REFRESH_TOKEN_SUPERSEDED', async () => {
    const { token } = await login();
    const responses = await Promise.all(Array.from({ length: 4 }, () => post('/api/auth/refresh', { cookie: token })));
    const statuses = responses.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 401, 401, 401]);
    for (const r of responses) if (r.status === 401) assert.equal((await r.json()).error.code, 'REFRESH_TOKEN_SUPERSEDED');
    seen.push(...responses.map(cookieValue).filter((v): v is string => !!v));
  });

  it('logout clears the cookie', async () => {
    const { token } = await login();
    const res = await post('/api/auth/logout', { cookie: token });
    assert.equal(res.status, 204);
    assert.match(res.headers.getSetCookie()[0] ?? '', /^refresh_token=; Path=\/api\/auth; Expires=Thu, 01 Jan 1970/);
  });

  it('no log line contains a refresh token or its hash', async () => {
    const { hashRefreshToken } = await import('./auth.tokens.ts');
    assert.ok(logLines.length > 0, 'the requests were logged');
    const logs = logLines.join('');
    for (const token of seen) {
      assert.ok(!logs.includes(token));
      assert.ok(!logs.includes(hashRefreshToken(token)));
    }
  });
});
