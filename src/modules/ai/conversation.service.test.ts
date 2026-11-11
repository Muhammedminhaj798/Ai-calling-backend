import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createFakeBackend, createFakeStore, customer, product, type FakeBackend, type FakeStore } from '../../../tests/fakes/ai-backend.ts';
import { AiProviderError } from '../../integrations/ai/ai.port.ts';
import { createScriptedAiProvider, type ScriptedAiProvider } from '../../integrations/ai/mock.adapter.ts';
import { FALLBACK_TEXT } from './ai.prompts.ts';
import { HANDOVER_TEXT } from './handover.ts';
import { createOrchestrator, type Orchestrator } from './conversation.service.ts';
import type { ConversationSession } from './ai.types.ts';

const CALLER = '+919847012345';
let ai: ScriptedAiProvider;
let backend: FakeBackend;
let store: FakeStore;
let orchestrator: Orchestrator;
let session: ConversationSession;

beforeEach(() => {
  ai = createScriptedAiProvider();
  backend = createFakeBackend({
    customers: [customer({ phone: CALLER, name: 'Sample Medicals', preferredLanguage: 'ml' })],
    products: [product({ name: 'Dolo 650', stock: 100 }), product({ name: 'Dolo 500', strength: '500 mg', stock: 100 }), product({ name: 'Mockzine 10', strength: '10 mg', stock: 'error' })],
  });
  store = createFakeStore();
  orchestrator = createOrchestrator({ ai, backend, store, defaultLanguage: 'en', maxToolRounds: 6 });
  session = orchestrator.createSession({ callId: 'call-1', provider: 'simulator', providerCallSid: 'sim-1', fromNumber: CALLER });
});

const tool = (name: string, args: Record<string, unknown> = {}) => ({ name, args });

describe('orchestrator — greeting', () => {
  it('identifies the caller by caller-ID, switches to their preferred language and greets by name', async () => {
    const g = await orchestrator.greet(session);
    assert.equal(session.state, 'confirming_location');
    assert.equal(session.language, 'ml');
    assert.match(g.reply, /Sample Medicals/);
    assert.match(g.reply, /നമസ്കാരം/);
    assert.equal(store.transcripts[0]?.speaker, 'agent');
    assert.ok(store.events.some((e) => e.type === 'session_started'));
    assert.ok(store.events.some((e) => e.type === 'tool_called' && e.toolName === 'identify_customer'));
    assert.deepEqual(store.patches.at(-1)?.['customerId'], 'cust-2345');
  });

  it('hands an unknown caller to staff after one retry chance is given to the model', async () => {
    session = orchestrator.createSession({ callId: 'call-2', provider: 'simulator', providerCallSid: 'sim-2', fromNumber: '+919111111111' });
    const g = await orchestrator.greet(session);
    assert.equal(session.state, 'identifying_customer', 'first miss: the model may ask for a registered number');
    assert.equal(g.ended, false);
  });
});

describe('orchestrator — full order conversation with a scripted model', () => {
  it('collects items, reads back, records confirmation and leaves the order with staff', async () => {
    await orchestrator.greet(session);
    const addr = session.customer!.addresses[0]!.id;

    // Turn 1: customer confirms location and names the first medicine; the model creates the draft, searches, checks, adds.
    ai.enqueue(
      { toolCalls: [tool('create_draft_order', { deliveryAddressId: addr })] },
      { toolCalls: [tool('search_products', { query: 'Dolo 650' })] },
      { toolCalls: [tool('check_inventory', { productId: 'prod-dolo-650', quantity: 20 })] },
      { toolCalls: [tool('add_order_item', { productId: 'prod-dolo-650', requestedText: 'dolo 650 twenty strips', quantity: 20, confirmedDetails: { name: 'Dolo 650', strength: '650 mg', packSize: '15x10' } })] },
      { text: 'Dolo 650, twenty strips added. Anything else?' },
    );
    const t1 = await orchestrator.handleTurn(session, 'Yes deliver to the shop. I need Dolo 650, twenty strips.');
    assert.equal(t1.reply, 'Dolo 650, twenty strips added. Anything else?');
    assert.equal(t1.state, 'collecting_items');
    assert.deepEqual(t1.toolCalls.map((c) => `${c.name}:${c.ok}`), ['create_draft_order:true', 'search_products:true', 'check_inventory:true', 'add_order_item:true']);
    assert.equal(backend.orders[0]?.items.length, 1);
    assert.ok(ai.requests[0]!.toolNames.includes('create_draft_order'));
    assert.ok(!ai.requests[0]!.toolNames.includes('record_customer_confirmation'));
    const system = ai.requests.at(-1)!.messages[0]!;
    assert.equal(system.role, 'system');
    assert.match(system.content, /Never guess/);
    assert.match(system.content, /Draft order PO-TEST-1/);

    // Turn 2: second medicine in Malayalam, then read-back.
    ai.enqueue(
      { toolCalls: [tool('search_products', { query: 'Dolo 500' })] },
      { toolCalls: [tool('check_inventory', { productId: 'prod-dolo-500', quantity: 5 })] },
      { toolCalls: [tool('add_order_item', { productId: 'prod-dolo-500', requestedText: 'ഡോളോ 500 അഞ്ച്', quantity: 5, confirmedDetails: { name: 'Dolo 500' } })] },
      { toolCalls: [tool('generate_order_readback')] },
      { text: 'READBACK' },
    );
    const t2 = await orchestrator.handleTurn(session, 'ഡോളോ 500 അഞ്ച് സ്ട്രിപ്പ് കൂടി. അത്രയേ ഉള്ളൂ.');
    assert.equal(t2.language, 'ml');
    assert.equal(t2.state, 'waiting_customer_confirmation');
    assert.equal(session.readbackRevision, 3);
    assert.equal(store.transcripts.filter((t) => t.speaker === 'customer').at(-1)?.language, 'ml');

    // Turn 3: customer confirms.
    ai.enqueue({ toolCalls: [tool('record_customer_confirmation', { revision: 3, confirmed: true })] }, { text: 'Thank you, staff will confirm your order.' });
    const t3 = await orchestrator.handleTurn(session, 'ശരി, ഉറപ്പിച്ചോളൂ');
    assert.equal(t3.state, 'completed');
    assert.equal(t3.ended, true);
    assert.equal(backend.orders[0]?.status, 'pending_staff_approval');
    assert.equal(backend.calls['confirm'], 1);
    assert.equal(backend.calls['reserve'], 1);

    const after = await orchestrator.handleTurn(session, 'hello?');
    assert.equal(after.ended, true);
    assert.equal(backend.calls['confirm'], 1, 'nothing runs after completion');
  });

  it('a correction after the read-back drops back to collecting and the old revision cannot be confirmed', async () => {
    await orchestrator.greet(session);
    ai.enqueue(
      { toolCalls: [tool('create_draft_order')] },
      { toolCalls: [tool('search_products', { query: 'Dolo 650' })] },
      { toolCalls: [tool('check_inventory', { productId: 'prod-dolo-650', quantity: 10 })] },
      { toolCalls: [tool('add_order_item', { productId: 'prod-dolo-650', requestedText: 'dolo', quantity: 10, confirmedDetails: { name: 'Dolo 650' } })] },
      { toolCalls: [tool('generate_order_readback')] },
      { text: 'Read-back given' },
    );
    await orchestrator.handleTurn(session, 'Dolo 650 ten strips, that is all');
    assert.equal(session.state, 'waiting_customer_confirmation');

    ai.enqueue(
      { toolCalls: [tool('check_inventory', { productId: 'prod-dolo-650', quantity: 15 })] },
      { toolCalls: [tool('update_order_item', { itemId: session.order!.items[0]!.id, quantity: 15 })] },
      { toolCalls: [tool('record_customer_confirmation', { revision: 2, confirmed: true })] },
      { toolCalls: [tool('generate_order_readback')] },
      { text: 'Changed to fifteen. Read-back repeated.' },
    );
    const t = await orchestrator.handleTurn(session, 'No wait, make it fifteen');
    assert.equal(session.order?.items[0]?.quantity, 15);
    const results = store.events.filter((e) => e.toolName === 'record_customer_confirmation');
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, false, 'confirming the stale revision is refused');
    assert.equal(t.state, 'waiting_customer_confirmation');
    assert.equal(session.readbackRevision, 3);
    assert.equal(backend.calls['confirm'], undefined);
  });

  it('turns a model provider failure into a handover with a safe reply', async () => {
    await orchestrator.greet(session);
    ai.complete = async () => {
      throw new AiProviderError('upstream 500');
    };
    const t = await orchestrator.handleTurn(session, 'Dolo 650 please');
    assert.equal(t.state, 'handover_required');
    assert.equal(t.ended, true);
    assert.equal(t.reply, FALLBACK_TEXT[session.language], 'the fixed fallback line in the session language, never model text');
    assert.ok(store.events.some((e) => e.type === 'provider_error'));
    assert.ok(store.events.some((e) => e.type === 'handover_requested'));
    assert.equal(backend.exceptions.at(-1)?.type, 'human_handover_required');
    assert.deepEqual(store.patches.at(-1), { status: 'handed_over', handoverReason: 'provider_error: upstream 500', conversationState: 'handover_required' });
  });

  it('hands over when the model loops on tools without replying', async () => {
    await orchestrator.greet(session);
    for (let i = 0; i < 10; i++) ai.enqueue({ toolCalls: [tool('get_customer_addresses')] });
    const t = await orchestrator.handleTurn(session, 'hello');
    assert.equal(t.state, 'handover_required');
    assert.ok(store.events.some((e) => e.type === 'tool_rounds_exhausted'));
  });

  it('request_human_handover from the model ends the AI part of the call with the fixed handover line', async () => {
    await orchestrator.greet(session);
    ai.enqueue({ toolCalls: [tool('request_human_handover', { reason: 'customer_requested' })] }, { text: 'this text is ignored' });
    const t = await orchestrator.handleTurn(session, 'ഞാൻ ഒരു ആളോട് സംസാരിക്കട്ടെ');
    assert.equal(t.reply, HANDOVER_TEXT.ml);
    assert.equal(t.state, 'handover_required');
    assert.equal(ai.pending, 1, 'no further model call after the handover tool');
  });

  it('inventory outage during a turn is surfaced to the model, not promised to the customer', async () => {
    await orchestrator.greet(session);
    ai.enqueue(
      { toolCalls: [tool('create_draft_order')] },
      { toolCalls: [tool('search_products', { query: 'Mockzine 10' })] },
      { toolCalls: [tool('check_inventory', { productId: 'prod-mockzine-10', quantity: 5 })] },
      { text: 'Sorry, I cannot confirm stock for Mockzine right now; staff will check it.' },
    );
    const t = await orchestrator.handleTurn(session, 'Mockzine 10, five strips');
    assert.match(t.reply, /cannot confirm/);
    const failed = store.events.find((e) => e.type === 'tool_failed' && e.toolName === 'check_inventory');
    assert.ok(failed);
    assert.equal((failed!.data as { result: { code: string } }).result.code, 'INVENTORY_UNAVAILABLE');
    const toolMsg = ai.requests.at(-1)!.messages.at(-1)!;
    assert.equal(toolMsg.role, 'tool');
    assert.match(toolMsg.role === 'tool' ? toolMsg.content : '', /INVENTORY_UNAVAILABLE/);
  });

  it('ending a call with an unconfirmed draft raises customer_unconfirmed and marks the conversation failed', async () => {
    await orchestrator.greet(session);
    ai.enqueue(
      { toolCalls: [tool('create_draft_order')] },
      { toolCalls: [tool('search_products', { query: 'Dolo 650' })] },
      { toolCalls: [tool('check_inventory', { productId: 'prod-dolo-650', quantity: 1 })] },
      { toolCalls: [tool('add_order_item', { productId: 'prod-dolo-650', requestedText: 'dolo', quantity: 1, confirmedDetails: { name: 'Dolo 650' } })] },
      { toolCalls: [tool('generate_order_readback')] },
      { text: 'Please confirm' },
    );
    await orchestrator.handleTurn(session, 'Dolo 650 one strip');
    const state = await orchestrator.endSession(session, 'caller_hangup');
    assert.equal(state, 'failed');
    assert.equal(backend.exceptions.at(-1)?.type, 'customer_unconfirmed');
    assert.ok(store.events.some((e) => e.type === 'session_ended'));
    assert.equal(store.patches.at(-1)?.['status'], 'completed');
    assert.match(String(store.patches.at(-1)?.['aiSummary']), /PO-TEST-1 pending_customer_confirmation/);
  });

  it('ending a call without any draft completes it quietly', async () => {
    await orchestrator.greet(session);
    assert.equal(await orchestrator.endSession(session, 'caller_hangup'), 'completed');
    assert.equal(backend.exceptions.length, 0);
  });

  it('keeps the model history bounded and never starts it on a dangling tool result', async () => {
    orchestrator = createOrchestrator({ ai, backend, store, defaultLanguage: 'en', historyLimit: 8 });
    session = orchestrator.createSession({ callId: 'call-3', provider: 'simulator', providerCallSid: 'sim-3', fromNumber: CALLER });
    await orchestrator.greet(session);
    for (let i = 0; i < 5; i++) {
      ai.enqueue({ toolCalls: [tool('get_customer_addresses')] }, { text: `reply ${i}` });
      await orchestrator.handleTurn(session, `message ${i}`);
    }
    assert.ok(session.messages.length <= 8);
    assert.notEqual(session.messages[0]?.role, 'tool');
  });
});
