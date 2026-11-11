import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, db, dbAvailable, disconnectDb, loginAs, resetDb, skipReason, startTestServer, type ApiClient, type Session, type TestServer } from './setup.ts';

const sample = {
  externalCode: 'C-100',
  name: 'Sample Medicals',
  phonePrimary: '98470 12345',
  phoneAlternates: ['0484 2345678'],
  email: 'Shop@Example.com',
  preferredLanguage: 'ml',
  addresses: [
    { label: 'Shop', line1: '1 Market Road', city: 'Kochi', state: 'Kerala', pincode: '682001' },
    { label: 'Godown', line1: '9 Harbour Road', city: 'Kochi', state: 'Kerala', pincode: '682002' },
  ],
};

describe('customers API', { skip: dbAvailable ? false : skipReason }, () => {
  let server: TestServer;
  let client: ApiClient;
  let admin: Session;

  before(async () => {
    server = await startTestServer();
    client = api(server.baseUrl);
  });
  after(async () => {
    await server.close();
    await disconnectDb();
  });
  beforeEach(async () => {
    await resetDb();
    admin = await loginAs(client, 'admin');
  });

  const create = (body: unknown = sample) => client.post('/api/customers', body, { token: admin.accessToken });

  it('creates a customer with normalised phones and exactly one default address', async () => {
    const res = await create();
    assert.equal(res.status, 201);
    const c = res.body.customer;
    assert.equal(c.phonePrimary, '+919847012345');
    assert.deepEqual(c.phoneAlternates, ['+914842345678']);
    assert.equal(c.email, 'shop@example.com');
    assert.equal(c.status, 'active');
    assert.equal(c.addresses.length, 2);
    assert.deepEqual(c.addresses.map((a: { isDefault: boolean }) => a.isDefault), [true, false]);

    const prisma = await db();
    assert.equal(await prisma.auditLog.count({ where: { action: 'customer.create', entityId: c.id } }), 1);
  });

  it('rejects duplicate codes and phones with 409 and the conflicting id', async () => {
    const first = await create();
    const sameCode = await create({ ...sample, phonePrimary: '9000000001', phoneAlternates: [] });
    assert.equal(sameCode.status, 409);
    assert.equal(sameCode.body.error.code, 'DUPLICATE_EXTERNAL_CODE');
    assert.equal(sameCode.body.error.details.conflictingCustomerId, first.body.customer.id);

    const samePhone = await create({ ...sample, externalCode: 'C-101', phonePrimary: '+91 484 2345678', phoneAlternates: [] });
    assert.equal(samePhone.status, 409);
    assert.equal(samePhone.body.error.code, 'DUPLICATE_PHONE');
  });

  it('validates input', async () => {
    const res = await create({ ...sample, phonePrimary: '12', addresses: [{ ...sample.addresses[0], pincode: '12' }] });
    assert.equal(res.status, 400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    assert.ok(paths.includes('phonePrimary'));
    assert.ok(paths.includes('addresses.0.pincode'));
  });

  it('gets by id and returns 404 for unknown ids', async () => {
    const { body } = await create();
    const ok = await client.get(`/api/customers/${body.customer.id}`, { token: admin.accessToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.customer.externalCode, 'C-100');
    assert.equal((await client.get('/api/customers/00000000-0000-4000-8000-000000000000', { token: admin.accessToken })).status, 404);
    assert.equal((await client.get('/api/customers/not-a-uuid', { token: admin.accessToken })).status, 400);
  });

  it('finds customers by any registered phone spelling and reports ordering eligibility', async () => {
    const { body } = await create();
    for (const spelling of ['09847012345', '+919847012345', '0484-2345678']) {
      const res = await client.get(`/api/customers/phone/${encodeURIComponent(spelling)}`, { token: admin.accessToken });
      assert.equal(res.status, 200, spelling);
      assert.equal(res.body.customer.id, body.customer.id);
      assert.equal(res.body.eligibleForAutomatedOrdering, true);
    }
    assert.equal((await client.get('/api/customers/phone/9111111111', { token: admin.accessToken })).status, 404);

    const blocked = await client.patch(`/api/customers/${body.customer.id}`, { status: 'blocked' }, { token: admin.accessToken });
    assert.equal(blocked.status, 200);
    const after = await client.get('/api/customers/phone/9847012345', { token: admin.accessToken });
    assert.equal(after.body.eligibleForAutomatedOrdering, false);

    const prisma = await db();
    assert.equal(await prisma.auditLog.count({ where: { action: 'customer.status_change' } }), 1);
  });

  it('updates fields, re-checking phone conflicts against other customers only', async () => {
    const a = (await create()).body.customer;
    const b = (await create({ ...sample, externalCode: 'C-200', phonePrimary: '9000000002', phoneAlternates: [] })).body.customer;

    const ok = await client.patch(`/api/customers/${a.id}`, { name: 'Renamed', phoneAlternates: ['9000000003'] }, { token: admin.accessToken });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.customer.name, 'Renamed');
    assert.equal(ok.body.customer.preferredLanguage, 'ml', 'a partial update must not reset fields that were not sent');
    assert.equal(ok.body.customer.email, 'shop@example.com');

    // Regression: PATCH { name } on a blocked customer must leave it blocked (update schemas carry no defaults).
    const blocked = (await create({ ...sample, externalCode: 'C-300', phonePrimary: '9000000004', phoneAlternates: ['9000000005'], status: 'blocked', addresses: [] })).body.customer;
    const renamed = await client.patch(`/api/customers/${blocked.id}`, { name: 'Still Blocked' }, { token: admin.accessToken });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.customer.status, 'blocked');
    assert.deepEqual(renamed.body.customer.phoneAlternates, ['+919000000005']);

    const conflict = await client.patch(`/api/customers/${a.id}`, { phoneAlternates: ['9000000002'] }, { token: admin.accessToken });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.details.conflictingCustomerId, b.id);

    assert.equal((await client.patch(`/api/customers/${a.id}`, {}, { token: admin.accessToken })).status, 400);
  });

  it('lists with pagination, status filter and text/phone search', async () => {
    await create();
    await create({ ...sample, externalCode: 'C-200', name: 'Beta Pharma', phonePrimary: '9000000002', phoneAlternates: [], status: 'inactive', addresses: [] });
    await create({ ...sample, externalCode: 'C-300', name: 'Gamma Drugs', phonePrimary: '9000000003', phoneAlternates: [], addresses: [] });

    const page = await client.get('/api/customers?pageSize=2&sort=name', { token: admin.accessToken });
    assert.equal(page.status, 200);
    assert.equal(page.body.total, 3);
    assert.equal(page.body.data.length, 2);
    assert.equal(page.body.data[0].name, 'Beta Pharma');

    const inactive = await client.get('/api/customers?status=inactive', { token: admin.accessToken });
    assert.equal(inactive.body.total, 1);

    const byPhone = await client.get('/api/customers?q=09000000003', { token: admin.accessToken });
    assert.equal(byPhone.body.total, 1);
    assert.equal(byPhone.body.data[0].externalCode, 'C-300');

    const byName = await client.get('/api/customers?q=gamma', { token: admin.accessToken });
    assert.equal(byName.body.total, 1);
  });

  it('manages multiple delivery addresses with a single default', async () => {
    const c = (await create({ ...sample, addresses: [] })).body.customer;
    const base = `/api/customers/${c.id}/addresses`;

    const first = await client.post(base, { line1: 'A', city: 'Kochi', state: 'Kerala', pincode: '682001' }, { token: admin.accessToken });
    assert.equal(first.status, 201);
    assert.equal(first.body.address.isDefault, true, 'first address becomes default automatically');

    const second = await client.post(base, { label: 'Godown', line1: 'B', city: 'Kochi', state: 'Kerala', pincode: '682002', isDefault: true }, { token: admin.accessToken });
    assert.equal(second.body.address.isDefault, true);
    let detail = (await client.get(`/api/customers/${c.id}`, { token: admin.accessToken })).body.customer;
    assert.deepEqual(detail.addresses.map((a: { line1: string; isDefault: boolean }) => [a.line1, a.isDefault]), [['B', true], ['A', false]]);

    const unset = await client.patch(`${base}/${second.body.address.id}`, { isDefault: false }, { token: admin.accessToken });
    assert.equal(unset.status, 400);
    assert.equal(unset.body.error.code, 'DEFAULT_ADDRESS_REQUIRED');

    const relabel = await client.patch(`${base}/${first.body.address.id}`, { label: 'Shop', isDefault: true }, { token: admin.accessToken });
    assert.equal(relabel.status, 200);
    detail = (await client.get(`/api/customers/${c.id}`, { token: admin.accessToken })).body.customer;
    assert.deepEqual(detail.addresses.map((a: { line1: string; isDefault: boolean }) => [a.line1, a.isDefault]), [['A', true], ['B', false]]);

    assert.equal((await client.delete(`${base}/${first.body.address.id}`, { token: admin.accessToken })).status, 204);
    detail = (await client.get(`/api/customers/${c.id}`, { token: admin.accessToken })).body.customer;
    assert.deepEqual(detail.addresses.map((a: { line1: string; isDefault: boolean }) => [a.line1, a.isDefault]), [['B', true]], 'remaining address promoted to default');

    assert.equal((await client.delete(`${base}/${first.body.address.id}`, { token: admin.accessToken })).status, 404);
  });

  it('previews a CSV import without writing, then imports valid rows and reports errors', async () => {
    await create({ ...sample, externalCode: 'C-001', phonePrimary: '9111111111', phoneAlternates: [], addresses: [] });
    const csv = [
      'external_code,name,phone_primary,phone_alternates,email,preferred_language,address_line1,city,state,pincode',
      'C-001,Updated Name,9111111111,,,ta,,,,',
      'C-002,New Pharmacy,9222222222,9222222223,new@example.com,hi,2 Beach Road,Kozhikode,Kerala,673001',
      'C-003,Bad Phone,12,,,,,,,',
      'C-004,Phone Clash,9111111111,,,,,,,',
    ].join('\n');

    const preview = await client.post('/api/customers/import/preview', csv, { token: admin.accessToken, contentType: 'text/csv' });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.summary, { total: 4, create: 1, update: 1, error: 2 });
    assert.equal(preview.body.rows[0].action, 'update');
    assert.equal(preview.body.rows[2].errors[0].field, 'phonePrimary');
    // Row 4 reuses row 2's phone, which also belongs to an existing customer: both problems are reported.
    const clashMessages = preview.body.rows[3].errors.map((e: { message: string }) => e.message);
    assert.ok(clashMessages.some((m: string) => /another customer/.test(m)), clashMessages.join(' | '));
    assert.ok(clashMessages.some((m: string) => /also appears on row 2/.test(m)), clashMessages.join(' | '));
    const prisma = await db();
    assert.equal(await prisma.customer.count(), 1, 'preview must not write');

    const strict = await client.post('/api/customers/import?strict=true', csv, { token: admin.accessToken, contentType: 'text/csv' });
    assert.equal(strict.status, 400);
    assert.equal(strict.body.error.code, 'IMPORT_HAS_ERRORS');
    assert.equal(await prisma.customer.count(), 1);

    const imported = await client.post('/api/customers/import', csv, { token: admin.accessToken, contentType: 'text/csv' });
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.body.applied, { created: 1, updated: 1 });
    assert.equal(imported.body.rows.length, 2, 'only error rows are echoed back');
    assert.equal(await prisma.customer.count(), 2);

    const updated = await prisma.customer.findUnique({ where: { externalCode: 'C-001' } });
    assert.equal(updated?.name, 'Updated Name');
    assert.equal(updated?.preferredLanguage, 'ta');
    const created = await prisma.customer.findUnique({ where: { externalCode: 'C-002' }, include: { addresses: true } });
    assert.deepEqual(created?.phoneAlternates, ['+919222222223']);
    assert.equal(created?.addresses[0]?.pincode, '673001');
    assert.equal(await prisma.auditLog.count({ where: { action: 'customer.import' } }), 1);
  });

  it('rejects imports that are not text/csv or lack required columns', async () => {
    const json = await client.post('/api/customers/import/preview', { csv: 'x' }, { token: admin.accessToken });
    assert.equal(json.status, 415);
    const missing = await client.post('/api/customers/import/preview', 'name,phone_primary\nA,9847012345', { token: admin.accessToken, contentType: 'text/csv' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'CSV_MISSING_COLUMNS');
  });
});
