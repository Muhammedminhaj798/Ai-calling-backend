import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  api,
  createUser,
  db,
  dbAvailable,
  disconnectDb,
  loginAs,
  refreshCookie,
  resetDb,
  skipReason,
  startTestServer,
  type ApiClient,
  type TestServer,
} from './setup.ts';

describe('auth API', { skip: dbAvailable ? false : skipReason }, () => {
  let server: TestServer;
  let client: ApiClient;

  before(async () => {
    server = await startTestServer();
    client = api(server.baseUrl);
  });
  after(async () => {
    await server.close();
    await disconnectDb();
  });
  beforeEach(resetDb);

  it('logs in with valid credentials, sets the refresh cookie and never returns the password hash or refresh token', async () => {
    const user = await createUser('admin');
    const res = await client.post('/api/auth/login', { email: user.email.toUpperCase(), password: user.password });
    assert.equal(res.status, 200);
    assert.equal(res.body.tokenType, 'Bearer');
    assert.ok(res.body.accessToken);
    assert.equal(res.body.refreshToken, undefined);
    assert.equal(res.body.refreshTokenExpiresAt, undefined);
    assert.equal(res.body.user.email, user.email);
    assert.equal(res.body.user.passwordHash, undefined);
    assert.match(refreshCookie(res.setCookies), /^refresh_token=/);
    assert.match(res.setCookies[0] ?? '', /HttpOnly/i);

    const prisma = await db();
    const events = await prisma.auditLog.findMany({ where: { action: 'auth.login' } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.actorId, user.id);
  });

  it('rejects a wrong password and an unknown email identically, and audits the failure', async () => {
    const user = await createUser('staff');
    const wrong = await client.post('/api/auth/login', { email: user.email, password: 'definitely-wrong-password' });
    const unknown = await client.post('/api/auth/login', { email: 'nobody@test.local', password: 'definitely-wrong-password' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(wrong.body.error.message, unknown.body.error.message);

    const prisma = await db();
    assert.equal(await prisma.auditLog.count({ where: { action: 'auth.login_failed' } }), 2);
  });

  it('rejects inactive users', async () => {
    const user = await createUser('staff', { isActive: false });
    const res = await client.post('/api/auth/login', { email: user.email, password: user.password });
    assert.equal(res.status, 401);
  });

  it('validates the login body', async () => {
    const res = await client.post('/api/auth/login', { email: 'not-an-email', password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.details.some((d: { path: string }) => d.path === 'email'));
  });

  it('rate limits repeated attempts against one email', async () => {
    const email = `limited-${Date.now()}@test.local`;
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await client.post('/api/auth/login', { email, password: 'wrong-password-123' })).status;
    }
    assert.equal(last, 429);
  });

  it('GET /me returns the current user and rejects missing, invalid and expired tokens', async () => {
    const session = await loginAs(client, 'approver');
    const ok = await client.get('/api/auth/me', { token: session.accessToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.id, session.user.id);
    assert.equal(ok.body.user.role, 'approver');

    assert.equal((await client.get('/api/auth/me')).status, 401);
    assert.equal((await client.get('/api/auth/me', { token: 'garbage' })).status, 401);

    const { signAccessToken } = await import('../../src/modules/auth/auth.tokens.ts');
    const expired = await signAccessToken({ id: session.user.id, role: 'approver' }, -10);
    const res = await client.get('/api/auth/me', { token: expired });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'TOKEN_EXPIRED');
  });

  it('rotates refresh tokens; within 30 s the previous one is refused without revoking, after that reuse revokes the family', async () => {
    const session = await loginAs(client, 'staff');
    const prisma = await db();
    const active = () => prisma.refreshToken.count({ where: { userId: session.user.id, revokedAt: null } });

    const first = await client.post('/api/auth/refresh', undefined, { cookie: session.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.body.refreshToken, undefined);
    const secondCookie = refreshCookie(first.setCookies);
    assert.notEqual(secondCookie, session.cookie);

    // Presented again within the grace window (lost response, concurrent refresh): refused, nothing revoked or issued.
    const repeat = await client.post('/api/auth/refresh', undefined, { cookie: session.cookie });
    assert.equal(repeat.status, 401);
    assert.equal(repeat.body.error.code, 'REFRESH_TOKEN_SUPERSEDED');
    assert.deepEqual(repeat.setCookies, []);
    assert.equal(await active(), 1);

    // Outside the window, replaying the rotated token is treated as theft…
    await prisma.refreshToken.updateMany({ where: { userId: session.user.id, replacedById: { not: null } }, data: { revokedAt: new Date(Date.now() - 31_000) } });
    const replay = await client.post('/api/auth/refresh', undefined, { cookie: session.cookie });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'INVALID_REFRESH_TOKEN');

    // …so the newest token is dead too.
    const afterReplay = await client.post('/api/auth/refresh', undefined, { cookie: secondCookie });
    assert.equal(afterReplay.status, 401);

    assert.equal(await active(), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'auth.refresh_reuse_detected' } }), 1);
  });

  it('concurrent refreshes with one cookie create exactly one successor (conditional UPDATE under row locking)', async () => {
    const session = await loginAs(client, 'staff');
    const results = await Promise.all(Array.from({ length: 8 }, () => client.post('/api/auth/refresh', undefined, { cookie: session.cookie })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    for (const r of results.filter((x) => x.status !== 200)) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, 'REFRESH_TOKEN_SUPERSEDED');
    }
    const prisma = await db();
    const rows = await prisma.refreshToken.findMany({ where: { userId: session.user.id } });
    assert.equal(rows.length, 2, 'the original token and one successor: no second chain');
    assert.equal(rows.filter((r) => !r.revokedAt).length, 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'auth.refresh_reuse_detected' } }), 0);
  });

  it('the grace window covers only the immediately previous token', async () => {
    const session = await loginAs(client, 'staff');
    const second = refreshCookie((await client.post('/api/auth/refresh', undefined, { cookie: session.cookie })).setCookies);
    assert.equal((await client.post('/api/auth/refresh', undefined, { cookie: second })).status, 200);

    const stale = await client.post('/api/auth/refresh', undefined, { cookie: session.cookie });
    assert.equal(stale.body.error.code, 'INVALID_REFRESH_TOKEN');
    const prisma = await db();
    assert.equal(await prisma.refreshToken.count({ where: { userId: session.user.id, revokedAt: null } }), 0);
  });

  it('aborted refresh: logging out with the previous cookie also ends the successor that never arrived', async () => {
    const session = await loginAs(client, 'staff');
    const other = await loginAs(client, 'staff');
    const undelivered = refreshCookie((await client.post('/api/auth/refresh', undefined, { cookie: session.cookie })).setCookies);

    assert.equal((await client.post('/api/auth/logout', undefined, { cookie: session.cookie })).status, 204);
    assert.equal((await client.post('/api/auth/refresh', undefined, { cookie: undelivered })).status, 401);
    assert.equal((await client.post('/api/auth/refresh', undefined, { cookie: other.cookie })).status, 200, 'other sessions are untouched');
  });

  it('refresh without a token, with an unknown token, or with a token in the body is rejected', async () => {
    assert.equal((await client.post('/api/auth/refresh')).status, 401);
    assert.equal((await client.post('/api/auth/refresh', undefined, { cookie: `refresh_token=${'x'.repeat(64)}` })).status, 401);
    // The HTTP-only cookie is the only refresh credential: a valid token in the body is ignored and not consumed.
    const session = await loginAs(client, 'staff');
    const viaBody = await client.post('/api/auth/refresh', { refreshToken: session.cookie.slice('refresh_token='.length) });
    assert.equal(viaBody.status, 401);
    assert.equal((await client.post('/api/auth/refresh', undefined, { cookie: session.cookie })).status, 200);
  });

  it('logout revokes the refresh token and clears the cookie', async () => {
    const session = await loginAs(client, 'staff');
    const out = await client.post('/api/auth/logout', undefined, { cookie: session.cookie });
    assert.equal(out.status, 204);
    assert.ok(out.setCookies.some((c) => c.startsWith('refresh_token=;') || /Expires=Thu, 01 Jan 1970/.test(c)));

    const again = await client.post('/api/auth/refresh', undefined, { cookie: session.cookie });
    assert.equal(again.status, 401);
  });

  it('enforces role-based access on protected routes', async () => {
    const staff = await loginAs(client, 'staff');
    const approver = await loginAs(client, 'approver');
    const admin = await loginAs(client, 'admin');
    const payload = { externalCode: 'C-1', name: 'Pharmacy One', phonePrimary: '9847012345' };

    assert.equal((await client.get('/api/customers', { token: staff.accessToken })).status, 200);
    const forbidden = await client.post('/api/customers', payload, { token: staff.accessToken });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'FORBIDDEN');

    assert.equal((await client.post('/api/customers', payload, { token: approver.accessToken })).status, 201);
    assert.equal((await client.post('/api/customers/import/preview', 'x', { token: approver.accessToken, contentType: 'text/csv' })).status, 403);
    assert.equal((await client.get('/api/customers', { token: admin.accessToken })).status, 200);
    assert.equal((await client.get('/api/customers')).status, 401);
  });
});
