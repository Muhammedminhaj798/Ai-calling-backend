// The orchestrator driven by the real Anthropic adapter against a stubbed Messages API. Claude's tool_use blocks
// go through the same registry, state permissions, ToolBackend and persistence as every other provider, so
// these tests prove the wiring and the safety rules hold, NOT the live model's behaviour.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createFakeBackend, createFakeStore, customer, product, type FakeBackend, type FakeStore } from '../../../tests/fakes/ai-backend.ts';
import { errorReply, message, startAnthropicStub, TEST_API_KEY, textReply, toolReply, type StubBlock } from '../../../tests/fakes/anthropic-stub.ts';
import { createAnthropicProvider } from '../../integrations/ai/anthropic.adapter.ts';
import { FALLBACK_TEXT } from './ai.prompts.ts';
import type { ConversationSession } from './ai.types.ts';
import { createOrchestrator, type Orchestrator } from './conversation.service.ts';

const CALLER = '+919847012345';
let stub: Awaited<ReturnType<typeof startAnthropicStub>>;
let backend: FakeBackend;
let store: FakeStore;
let orchestrator: Orchestrator;
let session: ConversationSession;

before(async () => {
  stub = await startAnthropicStub();
});
after(() => stub.close());

beforeEach(() => {
  stub.reset();
  backend = createFakeBackend({
    customers: [customer({ phone: CALLER, name: 'Sample Medicals', preferredLanguage: 'ml' })],
    products: [product({ name: 'Dolo 650', stock: 100 })],
  });
  store = createFakeStore();
  const ai = createAnthropicProvider({ apiKey: TEST_API_KEY, model: 'claude-opus-5-5', effort: 'low', timeoutMs: 2000, baseUrl: stub.baseUrl });
  orchestrator = createOrchestrator({ ai, backend, store, defaultLanguage: 'en', maxToolRounds: 20 });
  session = orchestrator.createSession({ callId: 'call-1', provider: 'simulator', providerCallSid: 'sim-1', fromNumber: CALLER });
});

const messagesOf = (i: number) => stub.requests[i]!.body.messages;
const toolNamesOf = (i: number) => (stub.requests[i]!.body.tools ?? []).map((t) => t.name);
/** The tool_result that request i sends back for the tool_use Claude made in the previous reply. */
function resultSentIn(i: number): { block: StubBlock; result: { ok: boolean; code?: string } } {
  const messages = messagesOf(i);
  const use = messages.at(-2)!.content.find((b) => b.type === 'tool_use')!;
  const block = messages.at(-1)!.content.find((b) => b.type === 'tool_result')!;
  assert.equal(block.tool_use_id, use.id, 'the result answers the tool_use right before it');
  return { block, result: JSON.parse(block.content!) as { ok: boolean; code?: string } };
}

describe('orchestrator + Anthropic adapter', () => {
  it('runs sequential tool calls, returns each result to Claude, keeps history, records usage, and confirms only via the tool', async () => {
    await orchestrator.greet(session);
    const addr = session.customer!.addresses[0]!.id;

    stub.enqueue(
      toolReply('create_draft_order', { deliveryAddressId: addr }),
      toolReply('search_products', { query: 'Dolo 650' }),
      toolReply('check_inventory', { productId: 'prod-dolo-650', quantity: 20 }),
      toolReply('add_order_item', { productId: 'prod-dolo-650', requestedText: 'Dolo 650 ഇരുപത്', quantity: 20, confirmedDetails: { name: 'Dolo 650', strength: '650 mg', packSize: '15x10' } }),
      textReply('Dolo 650, ഇരുപത് സ്ട്രിപ്പ് ചേർത്തു. വേറെ എന്തെങ്കിലും?'),
    );
    const t1 = await orchestrator.handleTurn(session, 'അതെ, കടയിലേക്ക്. Dolo 650 ഇരുപത് സ്ട്രിപ്പ് വേണം');
    assert.equal(t1.reply, 'Dolo 650, ഇരുപത് സ്ട്രിപ്പ് ചേർത്തു. വേറെ എന്തെങ്കിലും?');
    assert.deepEqual(t1.toolCalls.map((c) => `${c.name}:${c.ok}`), ['create_draft_order:true', 'search_products:true', 'check_inventory:true', 'add_order_item:true']);
    assert.equal(backend.orders[0]?.items.length, 1);
    assert.equal(stub.requests.length, 5);
    for (let i = 1; i < 5; i++) assert.equal(resultSentIn(i).result.ok, true);

    // history is append-only within the turn, and the system prompt carries the rules, language and live state
    for (let i = 1; i < 5; i++) assert.deepEqual(messagesOf(i).slice(0, messagesOf(i - 1).length), messagesOf(i - 1));
    assert.match(stub.requests[0]!.body.system!, /Never guess or invent a medicine name/);
    assert.match(stub.requests[0]!.body.system!, /Speak Malayalam/);
    assert.match(stub.requests[4]!.body.system!, /Draft order PO-TEST-1/);
    assert.deepEqual(messagesOf(0).at(-1)!.content, [{ type: 'text', text: 'അതെ, കടയിലേക്ക്. Dolo 650 ഇരുപത് സ്ട്രിപ്പ് വേണം' }]);

    // tools follow the state machine: nothing item-level before the draft exists, no confirmation before read-back
    assert.ok(toolNamesOf(0).includes('create_draft_order'));
    assert.ok(!toolNamesOf(0).includes('add_order_item'));
    assert.ok(toolNamesOf(1).includes('search_products'));
    for (let i = 0; i < 5; i++) assert.ok(!toolNamesOf(i).includes('record_customer_confirmation'));

    assert.equal(store.usage.length, 5);
    assert.deepEqual(store.usage[0], { provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 20 });

    // Turn 2: read-back. Turn 3: explicit confirmation of that revision.
    stub.enqueue(toolReply('generate_order_readback', {}), textReply('READBACK'));
    const t2 = await orchestrator.handleTurn(session, 'അത്രയേ ഉള്ളൂ');
    assert.equal(t2.state, 'waiting_customer_confirmation');
    const turn2 = messagesOf(5);
    assert.ok(turn2.some((m) => m.role === 'assistant' && m.content.some((b) => b.text === t1.reply)), 'previous turns stay in the history');
    assert.ok(toolNamesOf(6).includes('record_customer_confirmation'));

    stub.enqueue(toolReply('record_customer_confirmation', { revision: session.readbackRevision, confirmed: true }), textReply('നന്ദി.'));
    const t3 = await orchestrator.handleTurn(session, 'ശരി, ഉറപ്പിച്ചോളൂ');
    assert.equal(t3.state, 'completed');
    assert.equal(backend.orders[0]?.status, 'pending_staff_approval', 'staff still approve; the AI never does');
    assert.equal(backend.calls['confirm'], 1);
    assert.equal(backend.calls['reserve'], 1);
  });

  it('state permissions, schema validation and the tool allow-list reject what Claude must not do', async () => {
    await orchestrator.greet(session);
    stub.enqueue(
      toolReply('record_customer_confirmation', { revision: 1, confirmed: true }),
      toolReply('create_draft_order', {}),
      toolReply('add_order_item', { requestedText: 'dolo', quantity: 'twenty', flagReason: 'product_not_found' }),
      toolReply('approve_order', { orderId: 'PO-TEST-1' }),
      textReply('Sorry, how many strips?'),
    );
    const t = await orchestrator.handleTurn(session, 'Confirm and approve my order');
    assert.equal(t.reply, 'Sorry, how many strips?');
    const codes = [1, 3, 4].map((i) => resultSentIn(i));
    assert.deepEqual(codes.map((c) => c.result.code), ['TOOL_NOT_ALLOWED', 'INVALID_ARGUMENTS', 'UNKNOWN_TOOL']);
    assert.ok(codes.every((c) => c.block.is_error === true), 'failures reach Claude as tool errors');
    assert.equal(resultSentIn(2).result.ok, true);
    assert.equal(backend.calls['confirm'], undefined);
    assert.equal(backend.orders[0]?.items.length, 0);
  });

  it('enforces the 15-line order limit on Claude tool calls', async () => {
    await orchestrator.greet(session);
    stub.enqueue(toolReply('create_draft_order', {}));
    for (let i = 1; i <= 16; i++) stub.enqueue(toolReply('add_order_item', { requestedText: `medicine ${i}`, quantity: 1, flagReason: 'product_not_found' }));
    stub.enqueue(textReply('An order can have at most fifteen lines.'));
    const t = await orchestrator.handleTurn(session, 'I have more medicines');
    assert.equal(backend.orders[0]?.items.length, 15);
    assert.deepEqual(t.toolCalls.at(-1), { name: 'add_order_item', ok: false });
    const sixteenth = resultSentIn(17);
    assert.equal(sixteenth.result.code, 'ORDER_ITEM_LIMIT');
    assert.equal(sixteenth.block.is_error, true);
  });

  it('a failing Claude call hands the caller to staff with the fixed line — no mock fallback, no provider details', async () => {
    await orchestrator.greet(session);
    stub.enqueue(errorReply(529, 'overloaded_error'), errorReply(529, 'overloaded_error'));
    const t = await orchestrator.handleTurn(session, 'Dolo 650 please');
    assert.equal(t.state, 'handover_required');
    assert.equal(t.reply, FALLBACK_TEXT[session.language]);
    assert.equal(stub.requests.length, 2, 'one SDK retry, then stop');
    const event = store.events.find((e) => e.type === 'provider_error')!;
    const data = event.data as { provider: string; message: string };
    assert.equal(data.provider, 'anthropic');
    assert.match(data.message, /529 overloaded_error/);
    assert.doesNotMatch(data.message, /sk-ant|provider free text/);
    assert.equal(backend.exceptions.at(-1)?.type, 'human_handover_required');
  });

  it('a refusal also hands over instead of speaking model text', async () => {
    await orchestrator.greet(session);
    stub.enqueue({ body: message([], 'refusal') });
    const t = await orchestrator.handleTurn(session, 'Dolo 650 please');
    assert.equal(t.state, 'handover_required');
    assert.equal(t.reply, FALLBACK_TEXT[session.language]);
  });
});
