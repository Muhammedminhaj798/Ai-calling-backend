// Controlled end-to-end scenario: a 15-line order through the conversation engine with a scripted model,
// real services and database. Includes a medicine correction, a quantity correction, an unavailable
// medicine, an ambiguous medicine, a mixed-language sentence, a duplicate (16th) line, read-back, customer
// confirmation, staff clean-up of the flagged line, stock reservation and staff approval. The customer names
// at most two medicines per sentence: each medicine costs three tool rounds (search, stock check, add) and
// the production default AI_MAX_TOOL_ROUNDS=8 hands over beyond that. Measures engine latency per turn
// (database + services; the model is scripted, so model and network latency are excluded).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { scriptedAiProvider } from '../../src/integrations/ai/mock.adapter.ts';
import { api, createProduct, db, dbAvailable, disconnectDb, loginAs, resetDb, reservedQuantity, skipReason, startTestServer, type ApiClient, type Session, type TestServer } from './setup.ts';

const CALLER = '+919847012345';
const tool = (name: string, args: Record<string, unknown> = {}) => ({ name, args });

describe('15-medicine order scenario (scripted model, real services)', { skip: dbAvailable ? false : skipReason }, () => {
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

  it('captures all 15 lines faithfully and leaves approval to staff', async () => {
    const prisma = await db();
    const customer = await prisma.customer.create({ data: { externalCode: 'C-S15', name: 'Scenario Medicals', phonePrimary: CALLER, preferredLanguage: 'ml', status: 'active' } });
    const address = await prisma.customerAddress.create({ data: { customerId: customer.id, label: 'Shop', line1: '15 Scenario Road', city: 'Kochi', state: 'Kerala', pincode: '682001', isDefault: true } });

    // Catalogue: 14 ordinary products, one out of stock (Oflox 200) and an ambiguous pair (Dolo 500 / Dolo 650).
    const names = ['Azithro 500', 'Cefix 200', 'Amoxi 500', 'Metfor 500', 'Atorva 10', 'Pantop 40', 'Ranit 150', 'Cetriz 10', 'Monte 10', 'Levo 500', 'Omez 20', 'Telmi 40', 'Amlo 5', 'Dolo 650', 'Dolo 500', 'Oflox 200'];
    const products: Record<string, { id: string; name: string; strength: string }> = {};
    for (const name of names) {
      const strength = `${name.split(' ')[1]} mg`;
      const p = await createProduct(name.toUpperCase().replace(' ', '-'), name === 'Oflox 200' ? 0 : 500, { name, strength, packSize: '10x10' });
      products[name] = { id: p.id, name, strength };
    }
    const spoken: Array<[string, number]> = [];
    const addScript = (name: string, qty: number, requested = `${name} ${qty}`) => {
      spoken.push([name, qty]);
      return [
        { toolCalls: [tool('search_products', { query: name })] },
        { toolCalls: [tool('check_inventory', { productId: products[name]!.id, quantity: qty })] },
        { toolCalls: [tool('add_order_item', { productId: products[name]!.id, requestedText: requested, quantity: qty, confirmedDetails: { name, strength: products[name]!.strength, packSize: '10x10' } })] },
      ];
    };
    const latencies: Array<{ turn: string; ms: number; tools: number }> = [];
    async function turn(label: string, text: string) {
      const started = Date.now();
      const res = await client.post(`/api/conversations/${callId}/turns`, { text }, auth(staff));
      latencies.push({ turn: label, ms: Date.now() - started, tools: res.body.turn?.toolCalls?.length ?? 0 });
      assert.equal(res.status, 200, res.text);
      assert.ok(res.body.turn.toolCalls.every((c: { ok: boolean }) => c.ok), `${label}: ${JSON.stringify(res.body.turn.toolCalls)}`);
      return res.body.turn as { state: string; language: string; reply: string };
    }

    const t0 = Date.now();
    const started = await client.post('/api/conversations', { fromNumber: CALLER }, auth(staff));
    latencies.push({ turn: 'greeting', ms: Date.now() - t0, tools: 1 });
    assert.equal(started.status, 201, started.text);
    const callId = started.body.callId as string;
    assert.equal(started.body.greeting.state, 'confirming_location');

    // Turns 1–5: delivery confirmed, ten medicines two at a time.
    scriptedAiProvider.enqueue({ toolCalls: [tool('create_draft_order', { deliveryAddressId: address.id })] }, ...addScript('Azithro 500', 10), ...addScript('Cefix 200', 5), { text: 'Two items noted. Next?' });
    let t = await turn('turn 1 (draft + 2 items)', 'Deliver to the shop. Azithro 500 ten, Cefix 200 five.');
    assert.equal(t.state, 'collecting_items');
    scriptedAiProvider.enqueue(...addScript('Amoxi 500', 20), ...addScript('Metfor 500', 30), { text: 'Noted. Next?' });
    await turn('turn 2 (2 items)', 'Amoxi 500 twenty, Metfor 500 thirty.');
    scriptedAiProvider.enqueue(...addScript('Atorva 10', 15), ...addScript('Pantop 40', 25), { text: 'Noted. Next?' });
    await turn('turn 3 (2 items)', 'Atorva 10 fifteen, Pantop 40 twenty five.');
    scriptedAiProvider.enqueue(...addScript('Ranit 150', 10), ...addScript('Cetriz 10', 40), { text: 'Noted. Next?' });
    await turn('turn 4 (2 items)', 'Ranit 150 ten, Cetriz 10 forty.');
    scriptedAiProvider.enqueue(...addScript('Monte 10', 12), ...addScript('Levo 500', 8), { text: 'Ten items so far. Next?' });
    await turn('turn 5 (2 items)', 'Monte 10 twelve, Levo 500 eight.');

    // Turn 6–7: medicine correction. Omez 20 is added, then the customer says they meant Telmi 40.
    scriptedAiProvider.enqueue(...addScript('Omez 20', 6), { text: 'Omez 20, six strips added.' });
    await turn('turn 6 (1 item)', 'Omez 20 six strips.');
    const omezLine = (await prisma.orderItem.findFirst({ where: { order: { callId }, productId: products['Omez 20']!.id } }))!;
    scriptedAiProvider.enqueue(
      { toolCalls: [tool('search_products', { query: 'Telmi 40' })] },
      { toolCalls: [tool('check_inventory', { productId: products['Telmi 40']!.id, quantity: 6 })] },
      { toolCalls: [tool('update_order_item', { itemId: omezLine.id, productId: products['Telmi 40']!.id, confirmedDetails: { name: 'Telmi 40' } })] },
      { text: 'Changed Omez 20 to Telmi 40, six strips.' },
    );
    spoken.pop();
    spoken.push(['Telmi 40', 6]);
    await turn('turn 7 (medicine correction)', 'Sorry, not Omez, I meant Telmi 40, six strips.');

    // Turn 8: quantity correction on Cetriz (40 → 24).
    const cetrizLine = (await prisma.orderItem.findFirst({ where: { order: { callId }, productId: products['Cetriz 10']!.id } }))!;
    scriptedAiProvider.enqueue({ toolCalls: [tool('check_inventory', { productId: products['Cetriz 10']!.id, quantity: 24 })] }, { toolCalls: [tool('update_order_item', { itemId: cetrizLine.id, quantity: 24 })] }, { text: 'Cetriz 10 changed to twenty four.' });
    spoken[spoken.findIndex(([n]) => n === 'Cetriz 10')] = ['Cetriz 10', 24];
    await turn('turn 8 (quantity correction)', 'Make Cetriz twenty four, not forty.');

    // Turn 9: mixed-language sentence (Malayalam with English medicine names): Amlo 5 and Dolo 650.
    scriptedAiProvider.enqueue(...addScript('Amlo 5', 10, 'അംലോ 5 പത്ത്'), ...addScript('Dolo 650', 20, 'Dolo 650 ഇരുപത്'), { text: 'അംലോ 5 പത്തും Dolo 650 ഇരുപതും ചേർത്തു.' });
    t = await turn('turn 9 (mixed language, 2 items)', 'അംലോ 5 പത്ത് strip, Dolo 650 ഇരുപത് strip കൂടി വേണം.');
    assert.equal(t.language, 'ml');

    // Turns 10–11: ambiguous "Dolo" → the model must offer both; the customer picks Dolo 500.
    scriptedAiProvider.enqueue({ toolCalls: [tool('search_products', { query: 'Dolo' })] }, { text: 'Do you mean Dolo 650 or Dolo 500?' });
    t = await turn('turn 10 (ambiguous)', 'Also one more Dolo, five strips.');
    assert.match(t.reply, /650 or.*500/);
    const ambiguousEvent = await prisma.callEvent.findFirst({ where: { callId, type: 'tool_called', toolName: 'search_products' }, orderBy: { createdAt: 'desc' } });
    assert.equal((ambiguousEvent!.data as { result: { data: { exactMatch: unknown } } }).result.data.exactMatch, null, 'no exact match for an ambiguous name');
    scriptedAiProvider.enqueue({ toolCalls: [tool('check_inventory', { productId: products['Dolo 500']!.id, quantity: 5 })] }, { toolCalls: [tool('add_order_item', { productId: products['Dolo 500']!.id, requestedText: 'Dolo 500 five', quantity: 5, confirmedDetails: { name: 'Dolo 500', strength: '500 mg' } })] }, { text: 'Dolo 500, five strips.' });
    spoken.push(['Dolo 500', 5]);
    await turn('turn 11 (ambiguity resolved)', 'Dolo 500.');

    // Turn 12: unavailable medicine (Oflox 200 is out of stock) → recorded for staff, no substitution.
    scriptedAiProvider.enqueue(
      { toolCalls: [tool('search_products', { query: 'Oflox 200' })] },
      { toolCalls: [tool('check_inventory', { productId: products['Oflox 200']!.id, quantity: 10 })] },
      { toolCalls: [tool('add_order_item', { requestedText: 'Oflox 200 ten', quantity: 10, flagReason: 'out_of_stock' })] },
      { text: 'Oflox 200 is out of stock; I have noted it for staff. Shall I read the order back?' },
    );
    await turn('turn 12 (unavailable)', 'Oflox 200 ten strips.');
    const outOfStock = await prisma.callEvent.findFirst({ where: { callId, toolName: 'check_inventory' }, orderBy: { createdAt: 'desc' } });
    assert.equal((outOfStock!.data as { result: { data: { availableToSell: number } } }).result.data.availableToSell, 0);

    // Turn 13: a 16th line that repeats a product must be refused by the backend.
    scriptedAiProvider.enqueue({ toolCalls: [tool('search_products', { query: 'Azithro 500' })] }, { toolCalls: [tool('check_inventory', { productId: products['Azithro 500']!.id, quantity: 1 })] }, { toolCalls: [tool('add_order_item', { productId: products['Azithro 500']!.id, requestedText: 'again', quantity: 1, confirmedDetails: { name: 'Azithro 500' } })] }, { text: 'That is already on the order.' });
    const dup = await client.post(`/api/conversations/${callId}/turns`, { text: 'Azithro 500 one more strip' }, auth(staff));
    assert.equal(dup.status, 200, dup.text);
    const dupCall = dup.body.turn.toolCalls.find((c: { name: string }) => c.name === 'add_order_item');
    assert.equal(dupCall.ok, false, 'duplicate product / 16th line refused');

    // Turns 14–15: read-back and confirmation.
    scriptedAiProvider.enqueue({ toolCalls: [tool('generate_order_readback')] }, { text: 'READBACK' });
    t = await turn('turn 14 (read-back)', 'Yes, read it back.');
    assert.equal(t.state, 'waiting_customer_confirmation');
    const order = (await prisma.order.findUnique({ where: { callId }, include: { items: { orderBy: { lineNo: 'asc' } } } }))!;
    assert.equal(order.items.length, 15);
    scriptedAiProvider.enqueue({ toolCalls: [tool('record_customer_confirmation', { revision: order.revision, confirmed: true })] }, { text: 'Thank you, staff will confirm.' });
    t = await turn('turn 15 (confirmation)', 'ശരി, ഉറപ്പിക്കാം.');
    assert.equal(t.state, 'completed');

    // --- Verify the database order against the conversation ---
    const final = (await prisma.order.findUnique({ where: { callId }, include: { items: { orderBy: { lineNo: 'asc' } }, confirmations: true, reservations: true } }))!;
    assert.equal(final.status, 'customer_confirmed', 'reservation refused while an unresolved line remains; staff must act');
    assert.equal(final.deliveryAddressId, address.id);
    const active = final.items.filter((i) => i.status === 'active');
    const flagged = final.items.filter((i) => i.status === 'flagged');
    assert.equal(active.length, 14);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0]?.requestedText, 'Oflox 200 ten');
    assert.equal(flagged[0]?.flagReason, 'out_of_stock');
    assert.deepEqual(
      active.map((i) => [i.nameSnapshot, i.quantity]).sort(),
      spoken.sort(),
      'every spoken line, after both corrections, is on the order with the catalogue name',
    );
    assert.ok(active.every((i) => i.strengthSnapshot && i.packSizeSnapshot === '10x10' && i.customerDecision === 'accepted'));
    assert.ok(!active.some((i) => i.nameSnapshot === 'Omez 20'), 'the corrected medicine is gone');
    assert.equal(active.find((i) => i.nameSnapshot === 'Cetriz 10')?.quantity, 24);
    assert.equal(final.confirmations.find((c) => c.status === 'confirmed')?.revision, order.revision);
    assert.equal(final.reservations.length, 0);
    assert.equal(await prisma.exception.count({ where: { orderId: final.id, type: 'out_of_stock' } }), 1);
    assert.equal(await prisma.exception.count({ where: { orderId: final.id, type: 'order_validation_failed' } }), 1, 'refused reservation recorded for staff');

    // --- Staff resolve the flagged line, reserve and approve ---
    const removed = await client.delete(`/api/orders/${final.id}/items/${flagged[0]!.id}`, auth(staff));
    assert.equal(removed.status, 200, removed.text);
    const reserved = await client.post(`/api/orders/${final.id}/reserve`, undefined, auth(staff));
    assert.equal(reserved.status, 200, reserved.text);
    assert.equal(reserved.body.outcome, 'reserved', reserved.text);
    assert.equal(reserved.body.reservations.length, 14);
    assert.equal(await reservedQuantity('CETRIZ-10'), 24);
    const approver = await loginAs(client, 'approver');
    const approved = await client.post(`/api/approvals/${final.id}/approve`, { note: 'scenario' }, auth(approver));
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body.order.status, 'approved');

    assert.equal(await prisma.transcript.count({ where: { callId } }), 1 + 2 * 15, 'greeting + 15 customer/agent exchanges');
    console.log('\nengine latency per turn (ms; scripted model, so model and network time excluded; Neon round-trips included):');
    for (const l of latencies) console.log(`  ${l.turn.padEnd(34)} ${String(l.ms).padStart(6)} ms  (${l.tools} tool calls)`);
  });
});
