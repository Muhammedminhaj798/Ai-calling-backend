import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, createUser, dbAvailable, disconnectDb, loginAs, resetDb, skipReason, startTestServer, type ApiClient, type TestServer } from './setup.ts';

describe('dashboard support routes: settings and staff', { skip: dbAvailable ? false : skipReason }, () => {
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

  it('reports provider modes and credential presence as booleans only', async () => {
    const { accessToken } = await loginAs(client, 'staff');
    const res = await client.get('/api/settings', { token: accessToken });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.providers.ai.provider, 'mock');
    assert.equal(typeof res.body.providers.ai.configured, 'boolean');
    assert.equal(res.body.providers.inventory.provider, 'mock');
    assert.equal(res.body.reservation.maxOrderItems, 15);
    assert.ok(!JSON.stringify(res.body).includes(process.env['JWT_SECRET'] ?? '\u0000'), 'no secret value leaks');
    assert.equal((await client.get('/api/settings')).status, 401);
  });

  it('lists active staff without password hashes', async () => {
    const inactive = await createUser('staff', { isActive: false });
    const { accessToken, user } = await loginAs(client, 'approver');
    const res = await client.get('/api/staff', { token: accessToken });
    assert.equal(res.status, 200, res.text);
    const ids = (res.body.staff as Array<{ id: string; passwordHash?: string }>).map((s) => s.id);
    assert.ok(ids.includes(user.id));
    assert.ok(!ids.includes(inactive.id));
    assert.equal(res.body.staff[0].passwordHash, undefined);
  });
});
