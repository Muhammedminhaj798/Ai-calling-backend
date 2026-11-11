import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createFakeBackend, customer, product, type FakeBackend } from '../../../tests/fakes/ai-backend.ts';
import type { ToolCall } from '../../integrations/ai/ai.port.ts';
import { executeTool, toolDefinitionsFor, type ToolContext } from './ai.tools.ts';
import type { ConversationSession, ToolResult } from './ai.types.ts';
import { createOrchestrator } from './conversation.service.ts';
import { createFakeStore } from '../../../tests/fakes/ai-backend.ts';

const CALLER = '+919847012345';
let backend: FakeBackend;
let session: ConversationSession;
let clock = 1_000_000;
let n = 0;

const ctx = (): ToolContext => ({ session, backend, meta: { ip: undefined, requestId: undefined }, now: () => clock });
const call = (name: string, args: unknown, id = `c-${++n}`): ToolCall => ({ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const run = (name: string, args: unknown, id?: string): Promise<ToolResult> => executeTool(call(name, args, id), ctx());
const data = (r: ToolResult) => (r.ok ? (r.data as Record<string, unknown>) : assert.fail(`expected ok, got ${JSON.stringify(r)}`));
const fail = (r: ToolResult, code: string) => (r.ok ? assert.fail(`expected ${code}, got ok`) : assert.equal(r.code, code, r.error));

beforeEach(() => {
  backend = createFakeBackend({
    customers: [customer({ phone: CALLER, name: 'Sample Medicals', preferredLanguage: 'ml' }), customer({ phone: '+919000000009', name: 'Blocked Pharma', status: 'blocked' })],
    products: [
      product({ name: 'Dolo 650', strength: '650 mg', stock: 100 }),
      product({ name: 'Dolo 500', strength: '500 mg', stock: 100 }),
      product({ name: 'Calpol 650', strength: '650 mg', stock: 3 }),
      product({ name: 'Mockzine 10', strength: '10 mg', stock: 'error' }),
      product({ name: 'Mocklyte ORS', strength: null, stock: null }),
    ],
  });
  const orchestrator = createOrchestrator({ ai: { name: 'mock', complete: async () => ({ text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, model: 'x' }) }, backend, store: createFakeStore(), defaultLanguage: 'en', now: () => clock });
  session = orchestrator.createSession({ callId: 'call-1', provider: 'simulator', providerCallSid: 'sim-1', fromNumber: CALLER });
  session.state = 'identifying_customer';
});

/** Drives the session to collecting_items with a draft order. */
async function readyToOrder() {
  data(await run('identify_customer', { phone: CALLER }));
  data(await run('create_draft_order', {}));
}

describe('tool registry — validation and permissions', () => {
  it('offers only the tools allowed in the current state', () => {
    assert.deepEqual(toolDefinitionsFor('identifying_customer').map((t) => t.name), ['identify_customer', 'get_customer_addresses', 'request_human_handover']);
    assert.ok(toolDefinitionsFor('collecting_items').some((t) => t.name === 'search_products'));
    assert.ok(!toolDefinitionsFor('collecting_items').some((t) => t.name === 'record_customer_confirmation'));
    const search = toolDefinitionsFor('collecting_items').find((t) => t.name === 'search_products')!;
    assert.equal((search.parameters as { type: string }).type, 'object');
    assert.ok(!('$schema' in search.parameters));
  });

  it('rejects unknown tools, disallowed states, malformed JSON and invalid arguments without throwing', async () => {
    fail(await run('approve_order', {}), 'UNKNOWN_TOOL');
    fail(await run('add_order_item', { productId: '00000000-0000-4000-8000-000000000000', requestedText: 'x', quantity: 1 }), 'TOOL_NOT_ALLOWED');
    fail(await run('identify_customer', '{not json'), 'INVALID_ARGUMENTS');
    const bad = await run('identify_customer', { phone: '1' });
    fail(bad, 'INVALID_ARGUMENTS');
    assert.ok(Array.isArray((bad as { details?: unknown }).details));
  });

  it('returns the cached result for a duplicated tool call id instead of executing twice', async () => {
    const first = await run('identify_customer', { phone: CALLER }, 'dup-1');
    const again = await run('identify_customer', { phone: CALLER }, 'dup-1');
    assert.deepEqual(again, first);
    assert.equal(backend.calls['findCustomerByPhone'], 1);
  });
});

describe('customer identification', () => {
  it('identifies an active customer, offers the default address and moves to confirming_location', async () => {
    const r = data(await run('identify_customer', { phone: '09847012345' }));
    assert.equal(r['name'], 'Sample Medicals');
    assert.equal(r['preferredLanguage'], 'ml');
    assert.ok(r['defaultAddressId']);
    assert.equal(session.state, 'confirming_location');
    assert.equal(session.customer?.id, 'cust-2345');
  });

  it('asks once for another number, then hands over to staff with a customer_not_registered exception', async () => {
    fail(await run('identify_customer', { phone: '+919111111111' }), 'CUSTOMER_NOT_FOUND');
    assert.equal(session.state, 'identifying_customer');
    const second = await run('identify_customer', { phone: '+919111111112' });
    fail(second, 'CUSTOMER_NOT_FOUND');
    assert.equal(session.state, 'handover_required');
    assert.equal(backend.exceptions[0]?.type, 'customer_not_registered');
  });

  it('hands a blocked customer to staff with a customer_not_eligible exception', async () => {
    fail(await run('identify_customer', { phone: '+919000000009' }), 'CUSTOMER_NOT_ELIGIBLE');
    assert.equal(session.state, 'handover_required');
    assert.equal(backend.exceptions[0]?.type, 'customer_not_eligible');
    assert.equal(session.customer, null);
  });
});

describe('draft order and catalogue matching', () => {
  it('creates the draft once (idempotent) with the confirmed address', async () => {
    data(await run('identify_customer', { phone: CALLER }));
    fail(await run('create_draft_order', { deliveryAddressId: '00000000-0000-4000-8000-000000000000' }), 'ADDRESS_NOT_FOUND');
    const first = data(await run('create_draft_order', {}));
    assert.equal(session.state, 'collecting_items');
    assert.equal(session.deliveryAddressId, 'addr-2345');
    const again = data(await run('create_draft_order', {}));
    assert.equal(again['orderId'], first['orderId']);
    assert.equal(again['existing'], true);
    assert.equal(backend.orders.length, 1);
  });

  it('search returns candidates and never auto-selects an ambiguous product', async () => {
    await readyToOrder();
    const ambiguous = data(await run('search_products', { query: 'dolo' }));
    assert.equal(ambiguous['exactMatch'], null);
    assert.equal((ambiguous['candidates'] as unknown[]).length, 2);
    assert.match(String(ambiguous['instruction']), /let the customer choose/i);
    assert.equal(session.state, 'matching_products');
    assert.equal(session.candidates.size, 2);

    const exact = data(await run('search_products', { query: 'Dolo 650' }));
    assert.equal((exact['exactMatch'] as { name: string }).name, 'Dolo 650');
    assert.match(String(exact['instruction']), /confirm/i);

    const none = data(await run('search_products', { query: 'xyzzy' }));
    assert.equal((none['candidates'] as unknown[]).length, 0);
    assert.match(String(none['instruction']), /product_not_found/);
  });

  it('refuses product ids that were not offered by a search', async () => {
    await readyToOrder();
    fail(await run('get_product_details', { productId: '00000000-0000-4000-8000-000000000000' }), 'PRODUCT_NOT_OFFERED');
    fail(await run('check_inventory', { productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }), 'PRODUCT_NOT_OFFERED');
  });
});

describe('inventory checks and order lines', () => {
  it('adds a line only after a fresh, sufficient stock check for the same quantity', async () => {
    await readyToOrder();
    data(await run('search_products', { query: 'Dolo 650' }));
    const id = 'prod-dolo-650';
    fail(await run('add_order_item', { productId: id, requestedText: 'dolo', quantity: 10, confirmedDetails: { name: 'Dolo 650' } }), 'STOCK_CHECK_REQUIRED');

    const stock = data(await run('check_inventory', { productId: id, quantity: 10 }));
    assert.equal(stock['sufficient'], true);
    assert.equal(stock['isMock'], true);
    assert.equal(session.state, 'building_order');

    fail(await run('add_order_item', { productId: id, requestedText: 'dolo', quantity: 12, confirmedDetails: { name: 'Dolo 650' } }), 'STOCK_CHECK_REQUIRED');

    clock += 6 * 60_000; // check is stale after five minutes
    fail(await run('add_order_item', { productId: id, requestedText: 'dolo', quantity: 10, confirmedDetails: { name: 'Dolo 650' } }), 'STOCK_CHECK_REQUIRED');
    data(await run('check_inventory', { productId: id, quantity: 10 }));

    fail(await run('add_order_item', { productId: id, requestedText: 'dolo', quantity: 10, confirmedDetails: { name: 'Dolo 650', strength: '500 mg' } }), 'PRODUCT_IDENTITY_MISMATCH');
    const added = data(await run('add_order_item', { productId: id, requestedText: 'dolo six fifty ten strips', quantity: 10, confirmedDetails: { name: 'Dolo 650', strength: '650 mg' } }));
    assert.equal(added['lines'], 1);
    assert.equal(session.state, 'collecting_items');
    assert.equal(session.order?.items[0]?.name, 'Dolo 650');
    fail(await run('add_order_item', { productId: id, requestedText: 'again', quantity: 10, confirmedDetails: { name: 'Dolo 650' } }), 'DUPLICATE_ORDER_ITEM');
  });

  it('explains shortages and only allows the customer-accepted outcome', async () => {
    await readyToOrder();
    data(await run('search_products', { query: 'Calpol 650' }));
    const short = data(await run('check_inventory', { productId: 'prod-calpol-650', quantity: 10 }));
    assert.equal(short['sufficient'], false);
    assert.equal(short['availableToSell'], 3);
    assert.match(String(short['instruction']), /Only 3/);
    assert.equal(session.state, 'reviewing_shortages');
    fail(await run('add_order_item', { productId: 'prod-calpol-650', requestedText: 'calpol', quantity: 10, confirmedDetails: { name: 'Calpol 650' } }), 'STOCK_INSUFFICIENT');
    data(await run('check_inventory', { productId: 'prod-calpol-650', quantity: 3 }));
    data(await run('add_order_item', { productId: 'prod-calpol-650', requestedText: 'calpol', quantity: 3, confirmedDetails: { name: 'Calpol 650' } }));
    assert.equal(session.order?.items[0]?.quantity, 3);
  });

  it('reports an inventory outage honestly and lets the request be recorded for staff', async () => {
    await readyToOrder();
    data(await run('search_products', { query: 'Mockzine 10' }));
    const r = await run('check_inventory', { productId: 'prod-mockzine-10', quantity: 5 });
    fail(r, 'INVENTORY_UNAVAILABLE');
    assert.match(String((r as { error: string }).error), /cannot be confirmed/);
    fail(await run('add_order_item', { productId: 'prod-mockzine-10', requestedText: 'mockzine', quantity: 5, confirmedDetails: { name: 'Mockzine 10' } }), 'STOCK_CHECK_REQUIRED');
    const flagged = data(await run('add_order_item', { requestedText: 'mockzine 10 five strips', quantity: 5, flagReason: 'stock_unverified' }));
    assert.equal(flagged['flagged'], true);
    assert.equal(backend.exceptions[0]?.type, 'stock_unverified');
  });

  it('treats an unknown SKU as unavailable', async () => {
    await readyToOrder();
    data(await run('search_products', { query: 'Mocklyte ORS' }));
    const r = data(await run('check_inventory', { productId: 'prod-mocklyte-ors', quantity: 2 }));
    assert.equal(r['availableToSell'], null);
    assert.equal(r['status'], 'unknown');
  });

  it('warns when the quantity passed does not match what the customer said', async () => {
    await readyToOrder();
    session.lastCustomerUtterance = 'ഡോളോ ഇരുപത് സ്ട്രിപ്പ്';
    data(await run('search_products', { query: 'Dolo 650' }));
    data(await run('check_inventory', { productId: 'prod-dolo-650', quantity: 2 }));
    const r = data(await run('add_order_item', { productId: 'prod-dolo-650', requestedText: 'dolo', quantity: 2, confirmedDetails: { name: 'Dolo 650' } }));
    assert.match(String(r['warning']), /mentioned 20/);
  });

  it('collects several medicines, corrects a quantity and removes a line', async () => {
    await readyToOrder();
    for (const [name, qty] of [['Dolo 650', 10], ['Dolo 500', 5], ['Calpol 650', 1]] as const) {
      data(await run('search_products', { query: name }));
      const id = `prod-${name.toLowerCase().replace(' ', '-')}`;
      data(await run('check_inventory', { productId: id, quantity: qty }));
      data(await run('add_order_item', { productId: id, requestedText: name, quantity: qty, confirmedDetails: { name } }));
    }
    assert.equal(session.order?.items.length, 3);
    const line = session.order!.items[0]!;
    fail(await run('update_order_item', { itemId: line.id, quantity: 20 }), 'STOCK_CHECK_REQUIRED');
    data(await run('check_inventory', { productId: 'prod-dolo-650', quantity: 20 }));
    data(await run('update_order_item', { itemId: line.id, quantity: 20 }));
    assert.equal(session.order?.items[0]?.quantity, 20);
    data(await run('remove_order_item', { itemId: session.order!.items[2]!.id }));
    assert.equal(session.order?.items.length, 2);
    fail(await run('remove_order_item', { itemId: '00000000-0000-4000-8000-000000000000' }), 'ITEM_NOT_FOUND');
  });
});

describe('read-back, confirmation and handover', () => {
  async function orderWithLine() {
    await readyToOrder();
    data(await run('search_products', { query: 'Dolo 650' }));
    data(await run('check_inventory', { productId: 'prod-dolo-650', quantity: 10 }));
    data(await run('add_order_item', { productId: 'prod-dolo-650', requestedText: 'dolo', quantity: 10, confirmedDetails: { name: 'Dolo 650' } }));
  }

  it('requires a read-back before confirmation and binds confirmation to its revision', async () => {
    await readyToOrder();
    fail(await run('generate_order_readback', {}), 'ORDER_EMPTY');
    data(await run('search_products', { query: 'Dolo 650' }));
    data(await run('check_inventory', { productId: 'prod-dolo-650', quantity: 10 }));
    data(await run('add_order_item', { productId: 'prod-dolo-650', requestedText: 'dolo', quantity: 10, confirmedDetails: { name: 'Dolo 650' } }));
    const rb = data(await run('generate_order_readback', {}));
    assert.equal(rb['revision'], 2);
    assert.match(String(rb['readbackText']), /1\. Dolo 650/);
    assert.equal(session.state, 'waiting_customer_confirmation');

    fail(await run('record_customer_confirmation', { revision: 1, confirmed: true }), 'STALE_REVISION');

    // A correction after the read-back invalidates it.
    data(await run('check_inventory', { productId: 'prod-dolo-650', quantity: 12 }));
    data(await run('update_order_item', { itemId: session.order!.items[0]!.id, quantity: 12 }));
    assert.equal(session.state, 'collecting_items');
    assert.equal(session.readbackRevision, null);
    fail(await run('record_customer_confirmation', { revision: 2, confirmed: true }), 'TOOL_NOT_ALLOWED');

    const rb2 = data(await run('generate_order_readback', {}));
    assert.equal(rb2['revision'], 3);
    const confirmed = data(await run('record_customer_confirmation', { revision: 3, confirmed: true }));
    assert.equal(confirmed['confirmed'], true);
    assert.equal((confirmed['reservation'] as { outcome: string }).outcome, 'reserved');
    assert.equal(session.state, 'completed');
    assert.equal(backend.orders[0]?.status, 'pending_staff_approval', 'the order waits for staff, the AI cannot approve');
    assert.equal(backend.calls['confirm'], 1);
    assert.equal(backend.calls['reserve'], 1);
    fail(await run('record_customer_confirmation', { revision: 3, confirmed: true }), 'TOOL_NOT_ALLOWED');
  });

  it('a declined read-back reopens the order for changes', async () => {
    await orderWithLine();
    data(await run('generate_order_readback', {}));
    const r = data(await run('record_customer_confirmation', { revision: 2, confirmed: false }));
    assert.equal(r['confirmed'], false);
    assert.equal(session.state, 'collecting_items');
    assert.equal(backend.calls['confirm'], undefined);
  });

  it('a failed reservation after confirmation still completes the call with an exception for staff', async () => {
    await readyToOrder();
    data(await run('search_products', { query: 'Calpol 650' }));
    data(await run('check_inventory', { productId: 'prod-calpol-650', quantity: 3 }));
    data(await run('add_order_item', { productId: 'prod-calpol-650', requestedText: 'calpol', quantity: 3, confirmedDetails: { name: 'Calpol 650' } }));
    backend.products.find((p) => p.productId === 'prod-calpol-650')!.stock = 0; // stock vanished between check and reservation
    data(await run('generate_order_readback', {}));
    const r = data(await run('record_customer_confirmation', { revision: 2, confirmed: true }));
    assert.equal((r['reservation'] as { outcome: string }).outcome, 'failed');
    assert.equal(session.state, 'completed');
    assert.equal(backend.exceptions.at(-1)?.type, 'insufficient_stock');
  });

  it('request_human_handover raises the exception and freezes the session', async () => {
    await orderWithLine();
    const r = data(await run('request_human_handover', { reason: 'customer_requested', details: 'asked for Suresh' }));
    assert.equal(r['handover'], true);
    assert.equal(session.state, 'handover_required');
    assert.equal(backend.exceptions.at(-1)?.type, 'human_handover_required');
    assert.match(String(backend.exceptions.at(-1)?.description), /asked for Suresh/);
    fail(await run('add_order_item', { requestedText: 'x', quantity: 1, flagReason: 'product_not_found' }), 'TOOL_NOT_ALLOWED');
  });
});
