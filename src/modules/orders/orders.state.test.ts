import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrderStatus } from '../../generated/prisma/enums.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { assertState, assertTransition, canTransition, isTerminal, ORDER_TRANSITIONS, TERMINAL_STATES } from './orders.state.ts';

describe('order state machine', () => {
  it('follows the happy path draft → read-back → confirmed → reserving → pending approval → approved → fulfilled', () => {
    const path: OrderStatus[] = ['draft', 'pending_customer_confirmation', 'customer_confirmed', 'pending_stock_reservation', 'pending_staff_approval', 'approved', 'fulfilled'];
    for (let i = 0; i < path.length - 1; i++) assert.equal(canTransition(path[i]!, path[i + 1]!), true, `${path[i]} → ${path[i + 1]}`);
  });

  it('forbids approval before customer confirmation and before a successful reservation', () => {
    assert.equal(canTransition('draft', 'approved'), false);
    assert.equal(canTransition('pending_customer_confirmation', 'approved'), false);
    assert.equal(canTransition('customer_confirmed', 'approved'), false);
    assert.equal(canTransition('failed', 'approved'), false);
  });

  it('forbids fulfilment before staff approval and any change after a terminal state', () => {
    assert.equal(canTransition('pending_staff_approval', 'fulfilled'), false);
    assert.equal(canTransition('customer_confirmed', 'fulfilled'), false);
    for (const terminal of TERMINAL_STATES) {
      assert.equal(isTerminal(terminal), true);
      assert.deepEqual(ORDER_TRANSITIONS[terminal], []);
    }
  });

  it('allows read-back to be invalidated, reservations to be released or expired, and failed attempts to be retried', () => {
    assert.equal(canTransition('pending_customer_confirmation', 'draft'), true);
    assert.equal(canTransition('pending_staff_approval', 'customer_confirmed'), true);
    assert.equal(canTransition('pending_stock_reservation', 'failed'), true);
    assert.equal(canTransition('failed', 'pending_stock_reservation'), true);
    assert.equal(canTransition('approved', 'cancelled'), true);
  });

  it('assertTransition / assertState throw 409 with explicit codes', () => {
    assert.doesNotThrow(() => assertTransition('draft', 'pending_customer_confirmation'));
    assert.throws(
      () => assertTransition('draft', 'approved'),
      (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'INVALID_ORDER_STATE',
    );
    assert.throws(
      () => assertState('approved', ['draft'], 'ORDER_LOCKED'),
      (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'ORDER_LOCKED',
    );
  });
});
