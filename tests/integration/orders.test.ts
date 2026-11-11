import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  api,
  createCustomer,
  createProduct,
  db,
  dbAvailable,
  disconnectDb,
  loginAs,
  resetDb,
  reservedQuantity,
  skipReason,
  startTestServer,
  type ApiClient,
  type Session,
  type TestServer,
} from './setup.ts';

describe('orders, customer confirmation and stock reservations', { skip: dbAvailable ? false : skipReason }, () => {
  let server: TestServer;
  let client: ApiClient;
  let admin: Session;
  let staff: Session;
  let approver: Session;

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
    staff = await loginAs(client, 'staff');
    approver = await loginAs(client, 'approver');
  });

  const auth = (s: Session) => ({ token: s.accessToken });

  async function newOrder(items: unknown[], opts: { session?: Session; customerId?: string; headers?: Record<string, string> } = {}) {
    const customerId = opts.customerId ?? (await createCustomer()).id;
    const res = await client.post('/api/orders', { customerId, items }, { ...auth(opts.session ?? staff), headers: opts.headers });
    return res;
  }

  /** Draft → read-back → customer confirmed, for one or more product lines. */
  async function confirmedOrder(lines: Array<{ productId: string; quantity: number }>, session: Session = staff) {
    const created = await newOrder(lines.map((l) => ({ productId: l.productId, requestedText: 'as spoken', quantity: l.quantity })), { session });
    assert.equal(created.status, 201, created.text);
    const id = created.body.order.id as string;
    const rb = await client.post(`/api/orders/${id}/readback`, undefined, auth(session));
    assert.equal(rb.status, 200, rb.text);
    const confirmed = await client.post(`/api/orders/${id}/confirm`, { revision: rb.body.readback.revision, source: 'phone_staff' }, auth(session));
    assert.equal(confirmed.status, 200, confirmed.text);
    return id;
  }

  const reserve = (id: string, session: Session = staff, key?: string) =>
    client.post(`/api/orders/${id}/reserve`, undefined, { ...auth(session), headers: key ? { 'idempotency-key': key } : {} });

  it('creates a draft with catalogue snapshots and prices from the catalogue, never from the client', async () => {
    const a = await createProduct('A-1', 100, { name: 'Dolo 650', strength: '650 mg', packSize: '15x10', ptrPaise: 2600 });
    const b = await createProduct('B-1', 100, { name: 'Calpol 500', ptrPaise: 1000 });
    const res = await newOrder([
      { productId: a.id, requestedText: 'dolo six fifty', quantity: 2, confirmedDetails: { name: 'DOLO 650', strength: '650 MG' } },
      { productId: b.id, requestedText: 'calpol', quantity: 1 },
    ]);
    assert.equal(res.status, 201, res.text);
    const order = res.body.order;
    assert.match(order.orderNumber, /^PO-\d{8}-\d{5}$/);
    assert.equal(order.status, 'draft');
    assert.equal(order.revision, 1);
    assert.equal(order.items.length, 2);
    assert.equal(order.items[0].nameSnapshot, 'Dolo 650');
    assert.equal(order.items[0].strengthSnapshot, '650 mg');
    assert.equal(order.items[0].packSizeSnapshot, '15x10');
    assert.equal(order.items[0].unitPricePaise, 2600);
    assert.equal(order.items[0].lineTotalPaise, 5200);
    assert.equal(order.items[0].stockStatus, 'unchecked');
    assert.equal(order.items[0].customerDecision, 'pending');
    assert.equal(order.subtotalPaise, 6200);
    assert.deepEqual(order.events.map((e: { type: string }) => e.type), ['created', 'item_added', 'item_added']);
  });

  it('rejects ineligible customers, unknown or inactive products and identity mismatches', async () => {
    const product = await createProduct('P-1', 10, { name: 'Dolo 650', strength: '650 mg' });
    const blocked = await createCustomer({ status: 'blocked' });
    const res1 = await newOrder([], { customerId: blocked.id });
    assert.equal(res1.status, 422);
    assert.equal(res1.body.error.code, 'CUSTOMER_NOT_ELIGIBLE');

    const res2 = await newOrder([{ productId: '00000000-0000-4000-8000-000000000000', requestedText: 'x', quantity: 1 }]);
    assert.equal(res2.body.error.code, 'PRODUCT_NOT_FOUND');

    const inactive = await createProduct('P-OLD', 10, { status: 'discontinued' });
    const res3 = await newOrder([{ productId: inactive.id, requestedText: 'x', quantity: 1 }]);
    assert.equal(res3.body.error.code, 'PRODUCT_INACTIVE');

    const res4 = await newOrder([{ productId: product.id, requestedText: 'dolo 500', quantity: 1, confirmedDetails: { strength: '500 mg' } }]);
    assert.equal(res4.status, 422);
    assert.equal(res4.body.error.code, 'PRODUCT_IDENTITY_MISMATCH');
    assert.deepEqual(res4.body.error.details.mismatches, ['strength']);

    const res5 = await newOrder([{ requestedText: 'x', quantity: 1 }]);
    assert.equal(res5.body.error.code, 'VALIDATION_ERROR', 'a line needs a product or a flag reason');
  });

  it('replays an Idempotency-Key instead of creating a second order', async () => {
    const customer = await createCustomer();
    const first = await newOrder([], { customerId: customer.id, headers: { 'idempotency-key': 'create-key-0001' } });
    const second = await newOrder([], { customerId: customer.id, headers: { 'idempotency-key': 'create-key-0001' } });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.order.id, first.body.order.id);
    assert.equal(await (await db()).order.count(), 1);
  });

  it('enforces the line limit, rejects duplicate products and flags unresolved requests for staff', async () => {
    const created = await newOrder([]);
    const id = created.body.order.id;
    for (let i = 0; i < 15; i++) {
      const p = await createProduct(`LIM-${i}`, 10);
      const r = await client.post(`/api/orders/${id}/items`, { productId: p.id, requestedText: `item ${i}`, quantity: 1 }, auth(staff));
      assert.equal(r.status, 201, r.text);
    }
    const extra = await createProduct('LIM-X', 10);
    const over = await client.post(`/api/orders/${id}/items`, { productId: extra.id, requestedText: 'one too many', quantity: 1 }, auth(staff));
    assert.equal(over.status, 422);
    assert.equal(over.body.error.code, 'ORDER_ITEM_LIMIT');

    const other = await newOrder([]);
    const dup = await createProduct('DUP-1', 10);
    assert.equal((await client.post(`/api/orders/${other.body.order.id}/items`, { productId: dup.id, requestedText: 'a', quantity: 1 }, auth(staff))).status, 201);
    const again = await client.post(`/api/orders/${other.body.order.id}/items`, { productId: dup.id, requestedText: 'a again', quantity: 2 }, auth(staff));
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'DUPLICATE_ORDER_ITEM');

    const flagged = await client.post(`/api/orders/${other.body.order.id}/items`, { requestedText: 'something unclear', quantity: 3, flagReason: 'product_not_found' }, auth(staff));
    assert.equal(flagged.status, 201, flagged.text);
    const line = flagged.body.order.items.find((i: { status: string }) => i.status === 'flagged');
    assert.ok(line);
    assert.equal(line.productId, null);
    const prisma = await db();
    const exception = await prisma.exception.findFirst({ where: { orderItemId: line.id } });
    assert.equal(exception?.type, 'product_not_found');
    assert.equal(exception?.status, 'open');

    // Staff resolve the flagged line to a real product: the exception closes, the line becomes active.
    const resolved = await client.patch(`/api/orders/${other.body.order.id}/items/${line.id}`, { productId: extra.id }, auth(staff));
    assert.equal(resolved.status, 200, resolved.text);
    const fixed = resolved.body.order.items.find((i: { id: string }) => i.id === line.id);
    assert.equal(fixed.status, 'active');
    assert.equal(fixed.nameSnapshot, extra.name);
    assert.equal((await prisma.exception.findUnique({ where: { id: exception!.id } }))?.status, 'resolved');
  });

  it('corrects and removes lines, bumping the revision and invalidating a pending read-back', async () => {
    const a = await createProduct('A-2', 10);
    const b = await createProduct('B-2', 10);
    const created = await newOrder([{ productId: a.id, requestedText: 'a', quantity: 2 }, { productId: b.id, requestedText: 'b', quantity: 1 }]);
    const id = created.body.order.id;

    const rb = await client.post(`/api/orders/${id}/readback`, undefined, auth(staff));
    assert.equal(rb.status, 200);
    assert.equal(rb.body.readback.revision, 1);
    let detail = (await client.get(`/api/orders/${id}`, auth(staff))).body.order;
    assert.equal(detail.status, 'pending_customer_confirmation');
    assert.equal(detail.confirmations[0].status, 'pending');

    const itemA = detail.items[0];
    const upd = await client.patch(`/api/orders/${id}/items/${itemA.id}`, { quantity: 5 }, auth(staff));
    assert.equal(upd.status, 200, upd.text);
    detail = upd.body.order;
    assert.equal(detail.status, 'draft', 'a line change after read-back returns the order to draft');
    assert.equal(detail.revision, 2);
    assert.equal(detail.confirmations[0].status, 'superseded');
    assert.equal(detail.items[0].quantity, 5);
    assert.equal(detail.items[0].lineTotalPaise, 5 * 2600);

    const del = await client.delete(`/api/orders/${id}/items/${detail.items[1].id}`, auth(staff));
    assert.equal(del.status, 200);
    assert.equal(del.body.order.revision, 3);
    assert.equal(del.body.order.items.length, 1);
    assert.equal(del.body.order.subtotalPaise, 5 * 2600);

    const empty = await newOrder([]);
    assert.equal((await client.post(`/api/orders/${empty.body.order.id}/readback`, undefined, auth(staff))).body.error.code, 'ORDER_EMPTY');
  });

  it('binds customer confirmation to a complete read-back and its revision, and rejects duplicates', async () => {
    const a = await createProduct('A-3', 10, { name: 'Dolo 650', strength: '650 mg', packSize: '15x10' });
    const b = await createProduct('B-3', 10, { name: 'Calpol 500', strength: '500 mg' });
    const created = await newOrder([{ productId: a.id, requestedText: 'a', quantity: 20 }, { productId: b.id, requestedText: 'b', quantity: 1 }]);
    const id = created.body.order.id;

    const early = await client.post(`/api/orders/${id}/confirm`, { revision: 1, source: 'phone_staff' }, auth(staff));
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'READBACK_REQUIRED');

    const rb = await client.post(`/api/orders/${id}/readback`, undefined, auth(staff));
    assert.match(rb.body.readback.readbackText, /1\. Dolo 650 — 650 mg tablet, pack 15x10 — quantity 20 strips\./);
    assert.match(rb.body.readback.readbackText, /That is 2 items in total/);

    const stale = await client.post(`/api/orders/${id}/confirm`, { revision: 99, source: 'phone_staff' }, auth(staff));
    assert.equal(stale.body.error.code, 'STALE_REVISION');

    const ok = await client.post(`/api/orders/${id}/confirm`, { revision: 1, source: 'phone_ai', idempotencyKey: 'confirm-key-0001' }, auth(staff));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.order.status, 'customer_confirmed');
    assert.ok(ok.body.order.customerConfirmedAt);
    assert.ok(ok.body.order.items.every((i: { customerDecision: string }) => i.customerDecision === 'accepted'));
    assert.equal(ok.body.order.confirmations[0].status, 'confirmed');
    assert.equal(ok.body.order.confirmations[0].source, 'phone_ai');
    assert.equal(ok.body.order.confirmations[0].revision, 1);
    assert.ok(ok.body.order.events.some((e: { type: string }) => e.type === 'customer_confirmed'));

    const replay = await client.post(`/api/orders/${id}/confirm`, { revision: 1, source: 'phone_ai', idempotencyKey: 'confirm-key-0001' }, auth(staff));
    assert.equal(replay.status, 200);
    const duplicate = await client.post(`/api/orders/${id}/confirm`, { revision: 1, source: 'phone_ai', idempotencyKey: 'confirm-key-0002' }, auth(staff));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'ORDER_ALREADY_CONFIRMED');

    const locked = await client.post(`/api/orders/${id}/items`, { productId: a.id, requestedText: 'late', quantity: 1 }, auth(staff));
    assert.equal(locked.body.error.code, 'ORDER_LOCKED');

    // Declined lines are recorded and excluded from totals.
    const second = await newOrder([{ productId: a.id, requestedText: 'a', quantity: 1 }, { productId: b.id, requestedText: 'b', quantity: 1 }]);
    const sid = second.body.order.id;
    await client.post(`/api/orders/${sid}/readback`, undefined, auth(staff));
    const declinedId = second.body.order.items[1].id;
    const partial = await client.post(`/api/orders/${sid}/confirm`, { revision: 1, source: 'phone_staff', declinedItemIds: [declinedId] }, auth(staff));
    assert.equal(partial.status, 200, partial.text);
    assert.equal(partial.body.order.items[1].customerDecision, 'declined');
    assert.equal(partial.body.order.subtotalPaise, 2600);
  });

  it('refuses reservation and approval before customer confirmation', async () => {
    const a = await createProduct('A-4', 10);
    const created = await newOrder([{ productId: a.id, requestedText: 'a', quantity: 1 }]);
    const id = created.body.order.id;
    const r = await reserve(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CUSTOMER_UNCONFIRMED');
    const approve = await client.post(`/api/approvals/${id}/approve`, {}, auth(approver));
    assert.equal(approve.status, 409);
    assert.equal(approve.body.error.code, 'CUSTOMER_UNCONFIRMED');

    const confirmedId = await confirmedOrder([{ productId: a.id, quantity: 1 }]);
    const tooEarly = await client.post(`/api/approvals/${confirmedId}/approve`, {}, auth(approver));
    assert.equal(tooEarly.body.error.code, 'RESERVATION_REQUIRED');
  });

  it('reserves stock atomically through the mock adapter, replays the same key, and refuses a second key', async () => {
    const a = await createProduct('A-5', 100);
    const b = await createProduct('B-5', 50);
    const id = await confirmedOrder([{ productId: a.id, quantity: 10 }, { productId: b.id, quantity: 5 }]);

    const r = await reserve(id, staff, 'reserve-key-00001');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.outcome, 'reserved');
    assert.equal(r.body.replay, false);
    assert.equal(r.body.isMock, true);
    assert.equal(r.body.source, 'mock');
    assert.equal(r.body.orderStatus, 'pending_staff_approval');
    assert.equal(r.body.reservations.length, 2);
    assert.ok(r.body.expiresAt);
    assert.ok(r.body.lines.every((l: { status: string }) => l.status === 'in_stock'));
    assert.equal(await reservedQuantity('A-5'), 10);
    assert.equal(await reservedQuantity('B-5'), 5);

    const detail = (await client.get(`/api/orders/${id}`, auth(staff))).body.order;
    assert.equal(detail.status, 'pending_staff_approval');
    assert.ok(detail.items.every((i: { stockStatus: string }) => i.stockStatus === 'in_stock'));
    assert.ok(detail.events.some((e: { type: string }) => e.type === 'reservation_succeeded'));

    const list = await client.get(`/api/orders/${id}/reservations`, auth(staff));
    assert.equal(list.body.reservations.length, 2);
    assert.equal(list.body.reservations[0].provider, 'mock');

    const replay = await reserve(id, staff, 'reserve-key-00001');
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(await (await db()).stockReservation.count({ where: { orderId: id } }), 2, 'replay reserves nothing new');
    assert.equal(await reservedQuantity('A-5'), 10);

    const again = await reserve(id, staff, 'reserve-key-00002');
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ORDER_ALREADY_RESERVED');
  });

  it('fails cleanly on insufficient or missing stock: nothing reserved, exception raised, order back to customer_confirmed', async () => {
    const a = await createProduct('A-6', 5);
    const b = await createProduct('B-6', 50);
    const id = await confirmedOrder([{ productId: a.id, quantity: 10 }, { productId: b.id, quantity: 5 }]);

    const r = await reserve(id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.outcome, 'failed');
    assert.equal(r.body.reason, 'insufficient_stock');
    assert.equal(r.body.orderStatus, 'customer_confirmed');
    const short = r.body.lines.find((l: { sku: string }) => l.sku === 'A-6');
    assert.equal(short.status, 'insufficient');
    assert.equal(short.availableToSell, 5);
    assert.equal(await reservedQuantity('A-6'), 0, 'nothing is reserved when one line is short');
    assert.equal(await reservedQuantity('B-6'), 0);

    const prisma = await db();
    const exception = await prisma.exception.findUnique({ where: { id: r.body.exceptionId } });
    assert.equal(exception?.type, 'insufficient_stock');
    assert.equal(exception?.orderId, id);
    assert.equal(await prisma.stockReservation.count({ where: { orderId: id } }), 0);
    const item = await prisma.orderItem.findFirst({ where: { orderId: id, productId: a.id } });
    assert.equal(item?.stockStatus, 'insufficient');
    assert.equal(item?.availableAtCheck, 5);

    const oos = await createProduct('C-6-OOS', 100);
    const id2 = await confirmedOrder([{ productId: oos.id, quantity: 1 }]);
    const r2 = await reserve(id2);
    assert.equal(r2.body.outcome, 'failed');
    assert.equal(r2.body.reason, 'out_of_stock');
    assert.equal((await prisma.exception.findUnique({ where: { id: r2.body.exceptionId } }))?.type, 'out_of_stock');

    const retry = await reserve(id2);
    assert.equal(retry.body.outcome, 'failed', 'a failed attempt leaves the order reservable again');
  });

  it('marks the order failed on an inventory API error, records the exception, and still allows cancellation', async () => {
    const err = await createProduct('X-ERR', 100);
    const id = await confirmedOrder([{ productId: err.id, quantity: 1 }]);
    const r = await reserve(id);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'INVENTORY_UNAVAILABLE');
    assert.equal(r.body.error.details.orderStatus, 'failed');

    const prisma = await db();
    const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
    assert.equal(order?.status, 'failed');
    assert.equal(order?.items[0]?.stockStatus, 'error');
    assert.equal(await prisma.exception.count({ where: { orderId: id, type: 'inventory_api_error' } }), 1);

    const cancelled = await client.post(`/api/orders/${id}/cancel`, { reason: 'provider down, customer will call back' }, auth(approver));
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.body.order.status, 'cancelled');
  });

  it('serialises concurrent reservation attempts on one order', async () => {
    const a = await createProduct('A-7', 100);
    const id = await confirmedOrder([{ productId: a.id, quantity: 10 }]);
    const [r1, r2] = await Promise.all([reserve(id, staff, 'concurrent-key-1'), reserve(id, staff, 'concurrent-key-2')]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409], `${r1.text} | ${r2.text}`);
    const loser = r1.status === 409 ? r1 : r2;
    assert.ok(['RESERVATION_IN_PROGRESS', 'ORDER_ALREADY_RESERVED'].includes(loser.body.error.code));
    assert.equal(await (await db()).stockReservation.count({ where: { orderId: id, status: 'active' } }), 1);
    assert.equal(await reservedQuantity('A-7'), 10);
  });

  it('never over-reserves one product across orders reserving concurrently', async () => {
    const a = await createProduct('A-8', 10);
    const id1 = await confirmedOrder([{ productId: a.id, quantity: 8 }]);
    const id2 = await confirmedOrder([{ productId: a.id, quantity: 8 }]);
    const [r1, r2] = await Promise.all([reserve(id1), reserve(id2)]);
    const outcomes = [r1.body.outcome, r2.body.outcome].sort();
    assert.deepEqual(outcomes, ['failed', 'reserved'], `${r1.text} | ${r2.text}`);
    assert.equal(await reservedQuantity('A-8'), 8);
  });

  it('lets approvers release reservations, freeing stock and returning the order to customer_confirmed', async () => {
    const a = await createProduct('A-9', 100);
    const id = await confirmedOrder([{ productId: a.id, quantity: 10 }]);
    assert.equal((await reserve(id)).body.outcome, 'reserved');

    const forbidden = await client.post(`/api/orders/${id}/release`, { reason: 'staff cannot' }, auth(staff));
    assert.equal(forbidden.status, 403);

    const released = await client.post(`/api/orders/${id}/release`, { reason: 'customer changed mind' }, auth(approver));
    assert.equal(released.status, 200, released.text);
    assert.equal(released.body.orderStatus, 'customer_confirmed');
    assert.equal(released.body.released.length, 1);
    assert.equal(await reservedQuantity('A-9'), 0);
    const prisma = await db();
    assert.equal(await prisma.stockReservation.count({ where: { orderId: id, status: 'released' } }), 1);

    const none = await client.post(`/api/orders/${id}/release`, {}, auth(approver));
    assert.equal(none.body.error.code, 'NO_ACTIVE_RESERVATIONS');
  });

  it('expires overdue reservations: stock freed, order back to customer_confirmed, exception raised, approval blocked', async () => {
    const a = await createProduct('A-10', 100);
    const id = await confirmedOrder([{ productId: a.id, quantity: 10 }]);
    assert.equal((await reserve(id)).body.outcome, 'reserved');
    const prisma = await db();
    await prisma.stockReservation.updateMany({ where: { orderId: id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    // Not yet swept: approval itself notices the expiry.
    const early = await client.post(`/api/approvals/${id}/approve`, {}, auth(approver));
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'RESERVATION_EXPIRED');

    const { reservationsService } = await import('../../src/modules/orders/reservations.service.ts');
    const swept = await reservationsService.expireOverdue();
    assert.deepEqual(swept, { orders: 1, reservations: 1 });
    assert.equal(await reservedQuantity('A-10'), 0);
    assert.equal((await prisma.stockReservation.findFirst({ where: { orderId: id } }))?.status, 'expired');
    assert.equal((await prisma.order.findUnique({ where: { id } }))?.status, 'customer_confirmed');
    assert.equal(await prisma.exception.count({ where: { orderId: id, type: 'reservation_expired' } }), 1);

    const blocked = await client.post(`/api/approvals/${id}/approve`, {}, auth(approver));
    assert.equal(blocked.body.error.code, 'RESERVATION_REQUIRED');
    assert.equal((await reserve(id)).body.outcome, 'reserved', 'the order can be reserved again');
  });

  it('cancels by role, releasing reservations, and blocks terminal orders', async () => {
    const a = await createProduct('A-11', 100);
    const draft = await newOrder([{ productId: a.id, requestedText: 'a', quantity: 1 }]);
    const did = draft.body.order.id;
    const byStaff = await client.post(`/api/orders/${did}/cancel`, { reason: 'customer hung up' }, auth(staff));
    assert.equal(byStaff.status, 200, byStaff.text);
    assert.equal(byStaff.body.order.status, 'cancelled');
    assert.equal((await client.post(`/api/orders/${did}/cancel`, { reason: 'again' }, auth(admin))).body.error.code, 'INVALID_ORDER_STATE');

    const id = await confirmedOrder([{ productId: a.id, quantity: 10 }]);
    assert.equal((await reserve(id)).body.outcome, 'reserved');
    const staffLate = await client.post(`/api/orders/${id}/cancel`, { reason: 'staff cannot' }, auth(staff));
    assert.equal(staffLate.status, 403);
    const byApprover = await client.post(`/api/orders/${id}/cancel`, { reason: 'duplicate order' }, auth(approver));
    assert.equal(byApprover.status, 200, byApprover.text);
    assert.equal(byApprover.body.order.status, 'cancelled');
    assert.equal(await reservedQuantity('A-11'), 0);
    assert.ok(byApprover.body.order.reservations.every((r: { status: string }) => r.status === 'released'));
  });

  it('lists and filters orders and edits metadata until approval', async () => {
    const a = await createProduct('A-12', 100);
    const customer = await createCustomer();
    const first = await newOrder([{ productId: a.id, requestedText: 'a', quantity: 1 }], { customerId: customer.id });
    const id = first.body.order.id;
    await newOrder([]);

    const byCustomer = await client.get(`/api/orders?customerId=${customer.id}`, auth(staff));
    assert.equal(byCustomer.body.total, 1);
    assert.equal(byCustomer.body.data[0].customer.id, customer.id);
    const byStatus = await client.get('/api/orders?status=draft', auth(staff));
    assert.equal(byStatus.body.total, 2);
    const byNumber = await client.get(`/api/orders?q=${first.body.order.orderNumber.slice(-5)}`, auth(staff));
    assert.equal(byNumber.body.total, 1);

    const meta = await client.patch(`/api/orders/${id}`, { customerPoReference: 'PO-CUST-77', notes: 'deliver before noon' }, auth(staff));
    assert.equal(meta.status, 200, meta.text);
    assert.equal(meta.body.order.customerPoReference, 'PO-CUST-77');
    assert.ok(meta.body.order.events.some((e: { type: string }) => e.type === 'updated'));
  });
});
