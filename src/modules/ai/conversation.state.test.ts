import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConversationState } from '../../generated/prisma/enums.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { assertConversationTransition, canTransitionConversation, CONVERSATION_TRANSITIONS, isToolAllowed, TOOL_NAMES } from './conversation.state.ts';

describe('conversation state machine', () => {
  it('follows the main flow', () => {
    const flow: ConversationState[] = ['initializing', 'identifying_customer', 'confirming_location', 'collecting_items', 'matching_products', 'checking_inventory', 'building_order', 'reading_back', 'waiting_customer_confirmation', 'completed'];
    for (let i = 0; i < flow.length - 1; i++) assert.equal(canTransitionConversation(flow[i]!, flow[i + 1]!), true, `${flow[i]} → ${flow[i + 1]}`);
  });

  it('cannot skip mandatory steps', () => {
    assert.equal(canTransitionConversation('initializing', 'collecting_items'), false, 'no items before identification');
    assert.equal(canTransitionConversation('identifying_customer', 'collecting_items'), false, 'no items before location');
    assert.equal(canTransitionConversation('collecting_items', 'waiting_customer_confirmation'), false, 'no confirmation without read-back');
    assert.equal(canTransitionConversation('checking_inventory', 'waiting_customer_confirmation'), false);
  });

  it('supports corrections after read-back, retries and handover from any active state', () => {
    assert.equal(canTransitionConversation('waiting_customer_confirmation', 'collecting_items'), true);
    assert.equal(canTransitionConversation('reviewing_shortages', 'checking_inventory'), true);
    for (const state of Object.keys(CONVERSATION_TRANSITIONS) as ConversationState[]) {
      if (state === 'completed' || state === 'failed' || state === 'handover_required') continue;
      assert.equal(canTransitionConversation(state, 'handover_required'), true, `${state} → handover_required`);
      assert.equal(canTransitionConversation(state, 'failed'), true, `${state} → failed`);
    }
    assert.deepEqual(CONVERSATION_TRANSITIONS.completed, []);
    assert.deepEqual(CONVERSATION_TRANSITIONS.failed, []);
    assert.deepEqual([...CONVERSATION_TRANSITIONS.handover_required], ['completed', 'failed']);
  });

  it('throws a 409 on an invalid transition', () => {
    assert.throws(() => assertConversationTransition('completed', 'collecting_items'), (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'INVALID_CONVERSATION_STATE');
  });

  it('enforces tool permissions per state on the backend', () => {
    assert.equal(isToolAllowed('identify_customer', 'identifying_customer'), true);
    assert.equal(isToolAllowed('identify_customer', 'collecting_items'), false);
    assert.equal(isToolAllowed('record_customer_confirmation', 'waiting_customer_confirmation'), true);
    assert.equal(isToolAllowed('record_customer_confirmation', 'collecting_items'), false, 'no confirmation without a read-back');
    assert.equal(isToolAllowed('create_draft_order', 'identifying_customer'), false, 'no order before the location is confirmed');
    assert.equal(isToolAllowed('add_order_item', 'confirming_location'), false);
    assert.equal(isToolAllowed('request_human_handover', 'completed'), false);
    for (const tool of TOOL_NAMES) {
      assert.equal(isToolAllowed(tool, 'completed'), false, `${tool} after completion`);
      assert.equal(isToolAllowed(tool, 'handover_required'), false, `${tool} after handover`);
    }
  });
});
