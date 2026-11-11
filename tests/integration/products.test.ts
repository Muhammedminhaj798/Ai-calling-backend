import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, db, dbAvailable, disconnectDb, loginAs, resetDb, skipReason, startTestServer, type ApiClient, type Session, type TestServer } from './setup.ts';

const dolo650 = {
  externalCode: 'DOLO-650',
  name: 'Dolo 650',
  brand: 'Dolo',
  genericName: 'Paracetamol',
  strength: '650 mg',
  form: 'tablet',
  packSize: '15x10',
  unit: 'strip',
  manufacturer: 'Micro Labs',
  mrpPaise: 3250,
  ptrPaise: 2600,
  gstRate: 12,
};

describe('products and inventory API', { skip: dbAvailable ? false : skipReason }, () => {
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

  const create = (body: unknown = dolo650) => client.post('/api/products', body, { token: admin.accessToken });

  it('creates, reads and updates a product with audit events', async () => {
    const created = await create();
    assert.equal(created.status, 201);
    assert.equal(created.body.product.status, 'active');
    assert.equal(created.body.product.gstRate, '12');

    const got = await client.get(`/api/products/${created.body.product.id}`, { token: admin.accessToken });
    assert.equal(got.status, 200);
    assert.equal(got.body.product.externalCode, 'DOLO-650');

    const updated = await client.patch(`/api/products/${created.body.product.id}`, { status: 'discontinued', ptrPaise: 2500 }, { token: admin.accessToken });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.product.status, 'discontinued');

    // Regression: a partial update of another field must not reset status to the create default.
    const priceOnly = await client.patch(`/api/products/${created.body.product.id}`, { ptrPaise: 2400 }, { token: admin.accessToken });
    assert.equal(priceOnly.status, 200, priceOnly.text);
    assert.equal(priceOnly.body.product.status, 'discontinued');
    assert.equal(priceOnly.body.product.ptrPaise, 2400);

    const prisma = await db();
    assert.equal(await prisma.auditLog.count({ where: { action: 'product.create' } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { action: 'product.status_change' } }), 1);
  });

  it('detects duplicates by SKU and by product identity', async () => {
    const first = await create();
    const sameSku = await create({ ...dolo650, name: 'Something Else' });
    assert.equal(sameSku.status, 409);
    assert.equal(sameSku.body.error.code, 'DUPLICATE_EXTERNAL_CODE');

    const sameIdentity = await create({ ...dolo650, externalCode: 'DOLO-650-ALT', name: 'dolo 650', manufacturer: 'micro labs' });
    assert.equal(sameIdentity.status, 409);
    assert.equal(sameIdentity.body.error.code, 'DUPLICATE_PRODUCT');
    assert.equal(sameIdentity.body.error.details.conflictingProductId, first.body.product.id);

    const differentPack = await create({ ...dolo650, externalCode: 'DOLO-650-10', packSize: '10x10' });
    assert.equal(differentPack.status, 201);

    const patchIntoDuplicate = await client.patch(`/api/products/${differentPack.body.product.id}`, { packSize: '15x10' }, { token: admin.accessToken });
    assert.equal(patchIntoDuplicate.status, 409);
  });

  it('lists with filters and pagination', async () => {
    await create();
    await create({ ...dolo650, externalCode: 'DOLO-500', name: 'Dolo 500', strength: '500 mg' });
    await create({ ...dolo650, externalCode: 'CAL-650', name: 'Calpol 650', brand: 'Calpol', manufacturer: 'GSK', form: 'syrup', status: 'inactive' });

    const byBrand = await client.get('/api/products?brand=dolo&sort=name', { token: admin.accessToken });
    assert.equal(byBrand.body.total, 2);
    assert.equal(byBrand.body.data[0].name, 'Dolo 500');

    assert.equal((await client.get('/api/products?strength=650%20mg', { token: admin.accessToken })).body.total, 2);
    assert.equal((await client.get('/api/products?form=syrup', { token: admin.accessToken })).body.total, 1);
    assert.equal((await client.get('/api/products?status=inactive', { token: admin.accessToken })).body.total, 1);
    assert.equal((await client.get('/api/products?q=paracet', { token: admin.accessToken })).body.total, 3);
    const page = await client.get('/api/products?pageSize=1&page=3&sort=name', { token: admin.accessToken });
    assert.equal(page.body.data.length, 1);
    assert.equal(page.body.total, 3);
  });

  it('search returns ranked candidates and flags exact matches without auto-selecting', async () => {
    await create();
    await create({ ...dolo650, externalCode: 'DOLO-500', name: 'Dolo 500', strength: '500 mg' });
    await create({ ...dolo650, externalCode: 'CAL-650', name: 'Calpol 650', brand: 'Calpol', manufacturer: 'GSK' });
    await create({ ...dolo650, externalCode: 'OLD-650', name: 'Dolo 650 Old Pack', packSize: '10x15', status: 'inactive' });

    const fuzzy = await client.get('/api/products/search?q=dolo', { token: admin.accessToken });
    assert.equal(fuzzy.status, 200);
    const names = fuzzy.body.candidates.map((c: { name: string }) => c.name);
    assert.ok(names.includes('Dolo 650') && names.includes('Dolo 500'));
    assert.ok(!names.includes('Dolo 650 Old Pack'), 'inactive products are excluded by default');
    assert.equal(fuzzy.body.exactMatch, null, 'a brand-only query is never an exact match');
    assert.ok(fuzzy.body.candidates.every((c: { exact: boolean }) => c.exact === false));

    const exact = await client.get('/api/products/search?q=Dolo%20650', { token: admin.accessToken });
    assert.equal(exact.body.exactMatch?.externalCode, 'DOLO-650');
    assert.equal(exact.body.candidates[0].exact, true);
    assert.ok(exact.body.candidates.length >= 2, 'near matches are still listed for the caller to confirm');

    const bySku = await client.get('/api/products/search?q=dolo-500', { token: admin.accessToken });
    assert.equal(bySku.body.exactMatch?.name, 'Dolo 500');

    const withInactive = await client.get('/api/products/search?q=dolo&includeInactive=true', { token: admin.accessToken });
    assert.ok(withInactive.body.candidates.some((c: { name: string }) => c.name === 'Dolo 650 Old Pack'));

    assert.equal((await client.get('/api/products/search?q=d', { token: admin.accessToken })).status, 400);
  });

  it('previews and imports a CSV catalogue with duplicate and validation reporting', async () => {
    await create();
    const csv = [
      'sku,name,brand,generic_name,strength,form,pack_size,unit,manufacturer,mrp,ptr,gst_rate,status',
      'DOLO-650,Dolo 650,Dolo,Paracetamol,650 mg,Tablet,15x10,strip,Micro Labs,35.00,28.00,12,active',
      'CAL-650,Calpol 650,Calpol,Paracetamol,650 mg,Tablet,15x10,strip,GSK,₹30,24,12,',
      'DUP-1,dolo 650,Dolo,Paracetamol,650 mg,tablet,15x10,strip,micro labs,35,28,12,',
      'BAD-1,No Pack,,,,,,,,free,,,',
    ].join('\n');

    const preview = await client.post('/api/products/import/preview', csv, { token: admin.accessToken, contentType: 'text/csv' });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.summary, { total: 4, create: 1, update: 1, error: 2 });
    // DUP-1 duplicates both the file's row 2 and the existing catalogue row; both problems are reported.
    const dupMessages = preview.body.rows[2].errors.map((e: { message: string }) => e.message);
    assert.ok(dupMessages.some((m: string) => /Same product as existing SKU DOLO-650/.test(m)), dupMessages.join(' | '));
    assert.ok(dupMessages.some((m: string) => /as row 2/.test(m)), dupMessages.join(' | '));

    const imported = await client.post('/api/products/import', csv, { token: admin.accessToken, contentType: 'text/csv' });
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.body.applied, { created: 1, updated: 1 });

    const prisma = await db();
    assert.equal(await prisma.product.count(), 2);
    const dolo = await prisma.product.findUnique({ where: { externalCode: 'DOLO-650' } });
    assert.equal(dolo?.mrpPaise, 3500);
    const cal = await prisma.product.findUnique({ where: { externalCode: 'CAL-650' } });
    assert.equal(cal?.mrpPaise, 3000);
    assert.equal(cal?.status, 'active');
  });

  it('answers stock questions through the mock adapter, labelled as mock, with simulated failures', async () => {
    const prisma = await db();
    const make = async (externalCode: string, stock: { available: number; reserved?: number } | null) => {
      const p = (await create({ ...dolo650, externalCode, name: `Mock ${externalCode}` })).body.product;
      if (stock) {
        await prisma.inventory.create({
          data: { productId: p.id, quantityAvailable: stock.available, quantityReserved: stock.reserved ?? 0, source: 'mock', syncedAt: new Date() },
        });
      }
      return p.id as string;
    };
    const normal = await make('MOCK-A', { available: 100, reserved: 20 });
    const oos = await make('MOCK-B-OOS', { available: 10 });
    const err = await make('MOCK-C-ERR', { available: 10 });
    const na = await make('MOCK-D-NA', { available: 10 });
    const noRow = await make('MOCK-E', null);

    const ok = await client.get(`/api/inventory/${normal}?quantity=50`, { token: admin.accessToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.availableToSell, 80);
    assert.equal(ok.body.status, 'in_stock');
    assert.equal(ok.body.sufficient, true);
    assert.equal(ok.body.isMock, true);
    assert.equal(ok.body.source, 'mock');
    assert.match(ok.body.warning, /not real inventory/);

    const insufficient = await client.get(`/api/inventory/${normal}?quantity=81`, { token: admin.accessToken });
    assert.equal(insufficient.body.sufficient, false);

    const out = await client.get(`/api/inventory/${oos}`, { token: admin.accessToken });
    assert.equal(out.body.availableToSell, 0);
    assert.equal(out.body.status, 'out_of_stock');
    assert.equal(out.body.sufficient, null);

    const failed = await client.get(`/api/inventory/${err}`, { token: admin.accessToken });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, 'INVENTORY_UNAVAILABLE');

    for (const id of [na, noRow]) {
      const unknown = await client.get(`/api/inventory/${id}?quantity=1`, { token: admin.accessToken });
      assert.equal(unknown.status, 200);
      assert.equal(unknown.body.availableToSell, null);
      assert.equal(unknown.body.status, 'unknown');
      assert.equal(unknown.body.sufficient, null);
    }

    assert.equal((await client.get('/api/inventory/00000000-0000-4000-8000-000000000000', { token: admin.accessToken })).status, 404);
    assert.equal((await client.get(`/api/inventory/${normal}`)).status, 401);
  });
});
