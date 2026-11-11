// AI tool layer over HTTP: the real services and database, with the model scripted. Every tool the
// scripted model calls lands in the step 1–3 services; nothing is mocked below the orchestrator.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { scriptedAiProvider } from '../../src/integrations/ai/mock.adapter.ts';
import { api, createCustomer, createProduct, db, dbAvailable, disconnectDb, loginAs, resetDb, skipReason, startTestServer, type ApiClient, type Session, type TestServer } from './setup.ts';

const CALLER = '+919847012345';
const tool = (name: string, args: Record<string, unknown> = {}) => ({ name, args });

describe('AI conversation engine (scripted model, real services)', { skip: dbAvailable ? false : skipReason }, () => {
  let server: TestServer;
  let client: ApiClient;
  let staff: Session;

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
    scriptedAiProvider.clear();
    staff = await loginAs(client, 'staff');
  });

  const auth = (s: Session) => ({ token: s.accessToken });

  async function registeredCaller() {
    const prisma = await db();
    const customer = await prisma.customer.create({ data: { externalCode: 'C-AI-1', name: 'Sample Medicals', phonePrimary: CALLER, preferredLanguage: 'ml', status: 'active' } });
    const address = await prisma.customerAddress.create({ data: { customerId: customer.id, label: 'Shop', line1: '1 Market Road', city: 'Kochi', state: 'Kerala', pincode: '682001', isDefault: true } });
    return { customer, address };
  }

  it('takes a complete order: caller-ID greeting, tool-driven items, read-back, confirmation, reservation, staff approval', async () => {
    const { customer, address } = await registeredCaller();
    const dolo = await createProduct('DOLO-650', 100, { name: 'Dolo 650', strength: '650 mg', packSize: '15x10' });
    const calpol = await createProduct('CAL-500', 50, { name: 'Calpol 500', strength: '500 mg', packSize: '10x10' });

    const started = await client.post('/api/conversations', { fromNumber: '09847012345' }, auth(staff));
    assert.equal(started.status, 201, started.text);
    const callId = started.body.callId as string;
    assert.equal(started.body.greeting.state, 'confirming_location');
    assert.equal(started.body.greeting.language, 'ml', 'greets in the customer\'s preferred language');
    assert.match(started.body.greeting.reply, /Sample Medicals/);

    scriptedAiProvider.enqueue(
      { toolCalls: [tool('create_draft_order', { deliveryAddressId: address.id })] },
      { toolCalls: [tool('search_products', { query: 'Dolo 650' })] },
      { toolCalls: [tool('check_inventory', { productId: dolo.id, quantity: 20 })] },
      { toolCalls: [tool('add_order_item', { productId: dolo.id, requestedText: 'dolo 650 twenty', quantity: 20, confirmedDetails: { name: 'Dolo 650', strength: '650 mg', packSize: '15x10' } })] },
      { text: 'Dolo 650, twenty strips. Anything else?' },
    );
    const t1 = await client.post(`/api/conversations/${callId}/turns`, { text: 'Shop address is fine. Dolo 650, twenty strips.' }, auth(staff));
    assert.equal(t1.status, 200, t1.text);
    assert.equal(t1.body.turn.state, 'collecting_items');
    assert.ok(t1.body.turn.toolCalls.every((c: { ok: boolean }) => c.ok), JSON.stringify(t1.body.turn.toolCalls));

    scriptedAiProvider.enqueue(
      { toolCalls: [tool('search_products', { query: 'Calpol 500' })] },
      { toolCalls: [tool('check_inventory', { productId: calpol.id, quantity: 5 })] },
      { toolCalls: [tool('add_order_item', { productId: calpol.id, requestedText: 'കാൽപോൾ 500 അഞ്ച്', quantity: 5, confirmedDetails: { name: 'Calpol 500' } })] },
      { toolCalls: [tool('generate_order_readback')] },
      { text: 'READBACK' },
    );
    const t2 = await client.post(`/api/conversations/${callId}/turns`, { text: 'കാൽപോൾ 500 അഞ്ച് സ്ട്രിപ്പ് കൂടി. അത്രയേ ഉള്ളൂ.' }, auth(staff));
    assert.equal(t2.status, 200, t2.text);
    assert.equal(t2.body.turn.state, 'waiting_customer_confirmation');
    assert.equal(t2.body.turn.language, 'ml');

    scriptedAiProvider.enqueue({ toolCalls: [tool('record_customer_confirmation', { revision: 3, confirmed: true })] }, { text: 'Thank you. Staff will confirm your order.' });
    const t3 = await client.post(`/api/conversations/${callId}/turns`, { text: 'ശരി' }, auth(staff));
    assert.equal(t3.status, 200, t3.text);
    assert.equal(t3.body.turn.state, 'completed');
    assert.equal(t3.body.turn.ended, true);

    const prisma = await db();
    const order = await prisma.order.findUnique({ where: { callId }, include: { items: { orderBy: { lineNo: 'asc' } }, reservations: true, confirmations: true } });
    assert.ok(order, 'order linked to the call');
    assert.equal(order!.status, 'pending_staff_approval', 'stock reserved, waiting for staff — the AI cannot approve');
    assert.equal(order!.deliveryAddressId, address.id);
    assert.equal(order!.createdBy, 'ai');
    assert.deepEqual(order!.items.map((i) => [i.nameSnapshot, i.quantity, i.customerDecision, i.stockStatus]), [['Dolo 650', 20, 'accepted', 'in_stock'], ['Calpol 500', 5, 'accepted', 'in_stock']]);
    assert.equal(order!.reservations.filter((r) => r.status === 'active').length, 2);
    assert.equal(order!.confirmations.find((c) => c.status === 'confirmed')?.source, 'phone_ai');

    const call = await prisma.call.findUnique({ where: { id: callId } });
    assert.equal(call?.customerId, customer.id);
    assert.equal(call?.conversationState, 'completed');
    assert.equal(call?.language, 'ml');

    const detail = await client.get(`/api/calls/${callId}`, auth(staff));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.call.order.orderNumber, order!.orderNumber);
    assert.equal(detail.body.call.customer.externalCode, 'C-AI-1');
    const transcript = await client.get(`/api/calls/${callId}/transcript`, auth(staff));
    assert.equal(transcript.body.transcript.length, 7, 'greeting + 3 customer turns + 3 agent replies');
    assert.equal(transcript.body.transcript[0].speaker, 'agent');
    const events = await client.get(`/api/calls/${callId}/events?type=tool_called`, auth(staff));
    assert.equal(events.body.events.length, 10, 'identify + create + (search, check, add) × 2 + readback + confirm');
    assert.ok(events.body.events.every((e: { ok: boolean; data: { result: { ok: boolean } } }) => e.ok && e.data.result.ok));
    const list = await client.get('/api/calls?conversationState=completed', auth(staff));
    assert.equal(list.body.total, 1);
    assert.equal(list.body.data[0].order.status, 'pending_staff_approval');

    const audit = await prisma.auditLog.findMany({ where: { entityId: order!.id, actorType: 'ai' } });
    assert.ok(audit.some((a) => a.action === 'order.customer_confirm'));
    assert.ok(audit.some((a) => a.action === 'order.reserve'));

    // Staff approval remains a human action.
    const forbidden = await client.post(`/api/approvals/${order!.id}/approve`, {}, auth(staff));
    assert.equal(forbidden.status, 403);
    const approver = await loginAs(client, 'approver');
    const approved = await client.post(`/api/approvals/${order!.id}/approve`, { note: 'ok' }, auth(approver));
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.order.status, 'approved');

    const ended = await client.post(`/api/conversations/${callId}/end`, { reason: 'caller_hangup' }, auth(staff));
    assert.equal(ended.body.conversationState, 'completed');
  });

  it('hands an unregistered caller to staff with an exception, and a blocked customer likewise', async () => {
    const started = await client.post('/api/conversations', { fromNumber: '+919111111111' }, auth(staff));
    assert.equal(started.status, 201, started.text);
    const callId = started.body.callId as string;
    assert.equal(started.body.greeting.state, 'identifying_customer');

    scriptedAiProvider.enqueue({ toolCalls: [tool('identify_customer', { phone: '+919111111112' })] }, { text: 'ignored' });
    const t = await client.post(`/api/conversations/${callId}/turns`, { text: 'My number is 9111111112' }, auth(staff));
    assert.equal(t.body.turn.state, 'handover_required');
    assert.equal(t.body.turn.ended, true);
    const prisma = await db();
    assert.equal(await prisma.exception.count({ where: { callId, type: 'customer_not_registered' } }), 1);
    assert.equal((await prisma.call.findUnique({ where: { id: callId } }))?.status, 'handed_over');
    const events = await client.get(`/api/calls/${callId}/events?type=handover_requested`, auth(staff));
    assert.equal(events.body.events.length, 1);

    const blocked = await createCustomer({ status: 'blocked' });
    const b = await client.post('/api/conversations', { fromNumber: blocked.phonePrimary }, auth(staff));
    assert.equal(b.body.greeting.state, 'handover_required');
    assert.equal(await prisma.exception.count({ where: { callId: b.body.callId, type: 'customer_not_eligible' } }), 1);
  });

  it('a call that drops after the read-back leaves an unconfirmed draft and a customer_unconfirmed exception', async () => {
    const { address } = await registeredCaller();
    const dolo = await createProduct('DOLO-650', 100, { name: 'Dolo 650' });
    const started = await client.post('/api/conversations', { fromNumber: CALLER }, auth(staff));
    const callId = started.body.callId as string;
    scriptedAiProvider.enqueue(
      { toolCalls: [tool('create_draft_order', { deliveryAddressId: address.id })] },
      { toolCalls: [tool('search_products', { query: 'Dolo 650' })] },
      { toolCalls: [tool('check_inventory', { productId: dolo.id, quantity: 2 })] },
      { toolCalls: [tool('add_order_item', { productId: dolo.id, requestedText: 'dolo', quantity: 2, confirmedDetails: { name: 'Dolo 650' } })] },
      { toolCalls: [tool('generate_order_readback')] },
      { text: 'Please confirm.' },
    );
    const t = await client.post(`/api/conversations/${callId}/turns`, { text: 'Dolo 650, two strips, that is all' }, auth(staff));
    assert.equal(t.body.turn.state, 'waiting_customer_confirmation');

    const ended = await client.post(`/api/conversations/${callId}/end`, { reason: 'caller_hangup' }, auth(staff));
    assert.equal(ended.body.conversationState, 'failed');
    const prisma = await db();
    const order = await prisma.order.findUnique({ where: { callId } });
    assert.equal(order?.status, 'pending_customer_confirmation', 'nothing was confirmed or reserved');
    assert.equal(await prisma.stockReservation.count({ where: { orderId: order!.id } }), 0);
    assert.equal(await prisma.exception.count({ where: { callId, type: 'customer_unconfirmed' } }), 1);
    assert.equal((await client.get(`/api/conversations/${callId}/turns`, auth(staff))).status, 404);
    assert.equal((await client.post(`/api/conversations/${callId}/turns`, { text: 'hello' })).status, 401);
  });
});
