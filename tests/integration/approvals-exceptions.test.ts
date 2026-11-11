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

describe('staff approvals and exception management', { skip: dbAvailable ? false : skipReason }, () => {
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

  /** Draft → read-back → confirmed → reserved (pending_staff_approval). */
  async function reservedOrder(lines: Array<{ productId: string; quantity: number }>) {
    const customer = await createCustomer();
    const created = await client.post('/api/orders', { customerId: customer.id, items: lines.map((l) => ({ ...l, requestedText: 'spoken' })) }, auth(staff));
    assert.equal(created.status, 201, created.text);
    const id = created.body.order.id as string;
    const rb = await client.post(`/api/orders/${id}/readback`, undefined, auth(staff));
    const confirmed = await client.post(`/api/orders/${id}/confirm`, { revision: rb.body.readback.revision, source: 'phone_staff' }, auth(staff));
    assert.equal(confirmed.status, 200, confirmed.text);
    const reserved = await client.post(`/api/orders/${id}/reserve`, undefined, auth(staff));
    assert.equal(reserved.body.outcome, 'reserved', reserved.text);
    return id;
  }

  it('lists pending approvals oldest-first with lines, reservations and customer', async () => {
    const a = await createProduct('AP-1', 100);
    const first = await reservedOrder([{ productId: a.id, quantity: 1 }]);
    const second = await reservedOrder([{ productId: a.id, quantity: 2 }]);
    const res = await client.get('/api/approvals/pending', auth(staff));
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.deepEqual(res.body.data.map((o: { id: string }) => o.id), [first, second]);
    assert.equal(res.body.data[0].reservations.length, 1);
    assert.ok(res.body.data[0].customer.name);
    assert.ok(res.body.data[0].items[0].nameSnapshot);

    const review = await client.get(`/api/approvals/${first}`, auth(staff));
    assert.equal(review.status, 200);
    assert.ok(Array.isArray(review.body.order.events));
  });

  it('only approvers and admins approve; the decision records the staff id, timestamp and audit event', async () => {
    const a = await createProduct('AP-2', 100);
    const id = await reservedOrder([{ productId: a.id, quantity: 3 }]);

    const forbidden = await client.post(`/api/approvals/${id}/approve`, {}, auth(staff));
    assert.equal(forbidden.status, 403);

    const ok = await client.post(`/api/approvals/${id}/approve`, { note: 'looks good' }, auth(approver));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.order.status, 'approved');
    const decision = ok.body.order.approvals[0];
    assert.equal(decision.decision, 'approved');
    assert.equal(decision.staffUserId, approver.user.id);
    assert.equal(decision.staffUser.email, approver.user.email);
    assert.ok(decision.createdAt);
    assert.equal(decision.note, 'looks good');
    assert.ok(ok.body.order.events.some((e: { type: string; actorId: string | null }) => e.type === 'approved' && e.actorId === approver.user.id));

    const prisma = await db();
    assert.equal(await prisma.auditLog.count({ where: { action: 'order.approve', entityId: id, actorId: approver.user.id } }), 1);
    assert.equal(await reservedQuantity('AP-2'), 3, 'approved reservations stay active until fulfilment');

    const twice = await client.post(`/api/approvals/${id}/approve`, {}, auth(admin));
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'INVALID_ORDER_STATE');
    const edit = await client.patch(`/api/orders/${id}`, { notes: 'late change' }, auth(admin));
    assert.equal(edit.body.error.code, 'ORDER_LOCKED');
    const lines = await client.post(`/api/orders/${id}/items`, { productId: a.id, requestedText: 'x', quantity: 1 }, auth(admin));
    assert.equal(lines.body.error.code, 'ORDER_LOCKED');
  });

  it('rejects with a mandatory reason and releases the reserved stock', async () => {
    const a = await createProduct('AP-3', 100);
    const id = await reservedOrder([{ productId: a.id, quantity: 4 }]);
    assert.equal(await reservedQuantity('AP-3'), 4);

    const noReason = await client.post(`/api/approvals/${id}/reject`, {}, auth(approver));
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.code, 'VALIDATION_ERROR');

    const ok = await client.post(`/api/approvals/${id}/reject`, { reason: 'credit limit exceeded' }, auth(admin));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.order.status, 'rejected');
    assert.equal(ok.body.order.approvals[0].decision, 'rejected');
    assert.equal(ok.body.order.approvals[0].note, 'credit limit exceeded');
    assert.equal(ok.body.order.approvals[0].staffUserId, admin.user.id);
    assert.ok(ok.body.order.reservations.every((r: { status: string }) => r.status === 'released'));
    assert.equal(await reservedQuantity('AP-3'), 0);

    const again = await client.post(`/api/approvals/${id}/reject`, { reason: 'again' }, auth(admin));
    assert.equal(again.status, 409);
  });

  it('blocks reservation of orders with unresolved lines and approval of orders with invalid reservations', async () => {
    const a = await createProduct('AP-4', 100);
    const customer = await createCustomer();
    const created = await client.post(
      '/api/orders',
      { customerId: customer.id, items: [{ productId: a.id, requestedText: 'a', quantity: 1 }, { requestedText: 'unclear syrup', quantity: 1, flagReason: 'ambiguous_product' }] },
      auth(staff),
    );
    const id = created.body.order.id;
    const rb = await client.post(`/api/orders/${id}/readback`, undefined, auth(staff));
    assert.equal(rb.status, 200, rb.text);
    assert.equal(rb.body.readback.flaggedRequests.length, 1);
    assert.equal(rb.body.readback.lines.length, 1);
    await client.post(`/api/orders/${id}/confirm`, { revision: 1, source: 'phone_staff' }, auth(staff));
    const reserve = await client.post(`/api/orders/${id}/reserve`, undefined, auth(staff));
    assert.equal(reserve.status, 422);
    assert.equal(reserve.body.error.code, 'ORDER_VALIDATION_FAILED');
    const prisma = await db();
    assert.equal(await prisma.exception.count({ where: { orderId: id, type: 'order_validation_failed' } }), 1);

    const good = await reservedOrder([{ productId: a.id, quantity: 2 }]);
    await prisma.stockReservation.updateMany({ where: { orderId: good }, data: { status: 'released', releasedAt: new Date() } });
    const invalid = await client.post(`/api/approvals/${good}/approve`, {}, auth(approver));
    assert.equal(invalid.status, 409);
    assert.equal(invalid.body.error.code, 'RESERVATION_INVALID');
  });

  it('manages exceptions: create, filter, assign, update, resolve, and guards closed ones', async () => {
    const a = await createProduct('EX-1', 100);
    const id = await reservedOrder([{ productId: a.id, quantity: 1 }]);

    const created = await client.post('/api/exceptions', { type: 'human_handover_required', description: 'Customer asked for a person', orderId: id, details: { reason: 'caller request' } }, auth(staff));
    assert.equal(created.status, 201, created.text);
    const exId = created.body.exception.id;
    assert.equal(created.body.exception.status, 'open');
    assert.equal(created.body.exception.order.id, id);

    const badLink = await client.post('/api/exceptions', { type: 'product_not_found', description: 'Linked order does not exist', orderId: '00000000-0000-4000-8000-000000000000' }, auth(staff));
    assert.equal(badLink.status, 404, badLink.text);
    assert.equal(badLink.body.error.code, 'ORDER_NOT_FOUND');

    const byType = await client.get('/api/exceptions?type=human_handover_required', auth(staff));
    assert.equal(byType.body.total, 1);
    const unassigned = await client.get('/api/exceptions?assignedTo=unassigned&status=open', auth(staff));
    assert.ok(unassigned.body.data.some((e: { id: string }) => e.id === exId));

    const badAssignee = await client.post(`/api/exceptions/${exId}/assign`, { assigneeId: '00000000-0000-4000-8000-000000000000' }, auth(approver));
    assert.equal(badAssignee.status, 404);
    const assigned = await client.post(`/api/exceptions/${exId}/assign`, { assigneeId: staff.user.id }, auth(approver));
    assert.equal(assigned.status, 200, assigned.text);
    assert.equal(assigned.body.exception.assignedTo, staff.user.id);
    assert.equal(assigned.body.exception.status, 'in_progress');
    const mine = await client.get('/api/exceptions?assignedTo=me', auth(staff));
    assert.equal(mine.body.total, 1);

    const updated = await client.patch(`/api/exceptions/${exId}`, { description: 'Customer asked for a person; call back after 5pm' }, auth(staff));
    assert.equal(updated.status, 200);
    assert.match(updated.body.exception.description, /call back/);

    const resolved = await client.post(`/api/exceptions/${exId}/resolve`, { resolutionNote: 'Called back and completed the order manually' }, auth(staff));
    assert.equal(resolved.status, 200, resolved.text);
    assert.equal(resolved.body.exception.status, 'resolved');
    assert.equal(resolved.body.exception.resolvedById, staff.user.id);
    assert.ok(resolved.body.exception.resolvedAt);
    const prisma = await db();
    assert.equal(await prisma.auditLog.count({ where: { action: 'exception.resolved', entityId: exId } }), 1);

    const closed = await client.post(`/api/exceptions/${exId}/resolve`, { resolutionNote: 'again' }, auth(staff));
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error.code, 'EXCEPTION_CLOSED');
    assert.equal((await client.post(`/api/exceptions/${exId}/assign`, { assigneeId: null }, auth(staff))).status, 409);

    const dismissed = await client.post('/api/exceptions', { type: 'duplicate_suspected', description: 'Looks like a repeat', orderId: id }, auth(staff));
    const dis = await client.post(`/api/exceptions/${dismissed.body.exception.id}/resolve`, { status: 'dismissed', resolutionNote: 'Not a duplicate' }, auth(approver));
    assert.equal(dis.body.exception.status, 'dismissed');
  });
});
