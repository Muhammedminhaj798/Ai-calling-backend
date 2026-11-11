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

  it('logs in with valid credentials, sets the refresh cookie and never returns the password hash', async () => {
    const user = await createUser('admin');
    const res = await client.post('/api/auth/login', { email: user.email.toUpperCase(), password: user.password });
    assert.equal(res.status, 200);
    assert.equal(res.body.tokenType, 'Bearer');
    assert.ok(res.body.accessToken);
    assert.ok(res.body.refreshToken);
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

  it('rotates refresh tokens and revokes the whole family when a used token is replayed', async () => {
    const session = await loginAs(client, 'staff');

    const first = await client.post('/api/auth/refresh', undefined, { cookie: session.cookie });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refreshToken, session.refreshToken);
    const secondCookie = refreshCookie(first.setCookies);

    // Replaying the original (already rotated) token is treated as theft.
    const replay = await client.post('/api/auth/refresh', { refreshToken: session.refreshToken });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'INVALID_REFRESH_TOKEN');

    // …so the newest token is dead too.
    const afterReplay = await client.post('/api/auth/refresh', undefined, { cookie: secondCookie });
    assert.equal(afterReplay.status, 401);

    const prisma = await db();
    assert.equal(await prisma.refreshToken.count({ where: { userId: session.user.id, revokedAt: null } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'auth.refresh_reuse_detected' } }), 1);
  });

  it('refresh without a token or with an unknown token is rejected', async () => {
    assert.equal((await client.post('/api/auth/refresh')).status, 401);
    assert.equal((await client.post('/api/auth/refresh', { refreshToken: 'x'.repeat(64) })).status, 401);
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
