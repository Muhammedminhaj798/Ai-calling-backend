// Order state machine (ARCHITECTURE.md §A.5). Every status change goes through assertTransition().
import type { OrderStatus } from '../../generated/prisma/enums.ts';
import { AppError } from '../../middleware/error-handler.ts';

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ['pending_customer_confirmation', 'cancelled'],
  // line edits during read-back fall back to draft and invalidate the pending confirmation
  pending_customer_confirmation: ['draft', 'customer_confirmed', 'cancelled'],
  customer_confirmed: ['pending_stock_reservation', 'cancelled'],
  // transient lock held while the inventory provider is being called
  pending_stock_reservation: ['pending_staff_approval', 'customer_confirmed', 'failed'],
  // released or expired reservations send the order back to customer_confirmed
  pending_staff_approval: ['approved', 'rejected', 'customer_confirmed', 'cancelled'],
  approved: ['fulfilled', 'cancelled'],
  // inventory provider error during reservation; retry or cancel
  failed: ['pending_stock_reservation', 'cancelled'],
  rejected: [],
  cancelled: [],
  fulfilled: [],
};

export const TERMINAL_STATES: readonly OrderStatus[] = ['rejected', 'cancelled', 'fulfilled'];

/** Lines may be added, changed or removed only before the customer confirms. */
export const LINE_EDITABLE_STATES: readonly OrderStatus[] = ['draft', 'pending_customer_confirmation'];

/** Order metadata (PO reference, notes) is editable until staff approval. */
export const META_EDITABLE_STATES: readonly OrderStatus[] = [
  'draft',
  'pending_customer_confirmation',
  'customer_confirmed',
  'pending_staff_approval',
  'failed',
];

/** `staff` may cancel only unconfirmed orders; `approver`/`admin` may cancel anything not terminal and not mid-reservation. */
export const STAFF_CANCELLABLE_STATES: readonly OrderStatus[] = ['draft', 'pending_customer_confirmation'];
export const APPROVER_CANCELLABLE_STATES: readonly OrderStatus[] = [
  'draft',
  'pending_customer_confirmation',
  'customer_confirmed',
  'pending_staff_approval',
  'approved',
  'failed',
];

export const RESERVABLE_STATES: readonly OrderStatus[] = ['customer_confirmed', 'failed'];
export const REJECTABLE_STATES: readonly OrderStatus[] = ['pending_staff_approval', 'customer_confirmed', 'failed'];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'INVALID_ORDER_STATE', `Order cannot move from ${from} to ${to}`, { from, to });
  }
}

export function assertState(status: OrderStatus, allowed: readonly OrderStatus[], code = 'INVALID_ORDER_STATE', message?: string): void {
  if (!allowed.includes(status)) {
    throw new AppError(409, code, message ?? `Order is ${status}; this action requires one of: ${allowed.join(', ')}`, { status, allowed });
  }
}
