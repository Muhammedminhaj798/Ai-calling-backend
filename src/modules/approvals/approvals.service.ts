// Staff approval: the mandatory human gate before fulfilment (ARCHITECTURE.md §0 rule 4). Only orders whose
// customer confirmed the read-back and whose every accepted line holds a live reservation can be approved.
import { prisma } from '../../config/db.ts';
import type { AuthUser } from '../../middleware/auth.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { audit, type RequestMeta } from '../../utils/audit.ts';
import { pageResult, skipTake, type Page } from '../../utils/pagination.ts';
import { ordersRepository, type OrderDetailRecord } from '../orders/orders.repository.ts';
import { ordersService, type OrderDetail } from '../orders/orders.service.ts';
import { REJECTABLE_STATES } from '../orders/orders.state.ts';
import { actorFields, staffActor } from '../orders/orders.types.ts';
import { releaseActiveReservations } from '../orders/reservations.service.ts';
import { approvalsRepository as repo } from './approvals.repository.ts';
import type { ApproveInput, PendingQuery, RejectInput } from './approvals.validation.ts';

async function load(orderId: string): Promise<OrderDetailRecord> {
  const order = await ordersRepository.findDetail(prisma, orderId);
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  return order;
}

/** Every check that must hold before an approver may approve. Throws with a specific code otherwise. */
export function assertApprovable(order: OrderDetailRecord, now = new Date()): void {
  if (order.status === 'draft' || order.status === 'pending_customer_confirmation') {
    throw new AppError(409, 'CUSTOMER_UNCONFIRMED', 'The customer has not confirmed this order', { status: order.status });
  }
  if (order.status === 'customer_confirmed' || order.status === 'failed' || order.status === 'pending_stock_reservation') {
    throw new AppError(409, 'RESERVATION_REQUIRED', 'Stock must be reserved successfully before approval', { status: order.status });
  }
  if (order.status !== 'pending_staff_approval') {
    throw new AppError(409, 'INVALID_ORDER_STATE', `Order is ${order.status} and cannot be approved`, { status: order.status });
  }
  const flagged = order.items.filter((i) => i.status === 'flagged');
  if (flagged.length > 0) {
    throw new AppError(409, 'ORDER_HAS_FLAGGED_ITEMS', 'Resolve or remove unresolved lines before approving', { itemIds: flagged.map((i) => i.id) });
  }
  const active = order.reservations.filter((r) => r.status === 'active');
  for (const line of order.items.filter((i) => i.status === 'active' && i.customerDecision === 'accepted')) {
    const reservation = active.find((r) => r.orderItemId === line.id);
    if (!reservation || reservation.quantity !== line.quantity) {
      throw new AppError(409, 'RESERVATION_INVALID', 'A line has no valid stock reservation; reserve again before approving', { itemId: line.id });
    }
    if (reservation.expiresAt.getTime() <= now.getTime()) {
      throw new AppError(409, 'RESERVATION_EXPIRED', 'A stock reservation has expired; reserve again before approving', { itemId: line.id, expiredAt: reservation.expiresAt });
    }
  }
}

export const approvalsService = {
  async listPending(query: PendingQuery): Promise<Page<OrderDetailRecord>> {
    const { skip, take } = skipTake(query);
    const [data, total] = await repo.listPending(query.customerId ? { customerId: query.customerId } : {}, skip, take);
    return pageResult(data, total, query);
  },

  review: (orderId: string): Promise<OrderDetail> => ordersService.getDetail(orderId),

  async approve(orderId: string, input: ApproveInput, user: AuthUser, meta: RequestMeta): Promise<OrderDetail> {
    const order = await load(orderId);
    assertApprovable(order);
    const actor = staffActor(user);
    await prisma.$transaction(async (db) => {
      const moved = await ordersRepository.transition(db, orderId, ['pending_staff_approval'], 'approved');
      if (!moved) throw new AppError(409, 'ORDER_STATE_CHANGED', 'Order changed while approving; reload and retry');
      await repo.createDecision(db, { orderId, staffUserId: user.id, decision: 'approved', fromStatus: 'pending_staff_approval', toStatus: 'approved', note: input?.note ?? null });
      await ordersRepository.addEvent(db, { orderId, type: 'approved', fromStatus: 'pending_staff_approval', toStatus: 'approved', ...actorFields(actor), reason: input?.note ?? null });
    });
    await audit({ actorType: 'staff', actorId: user.id, action: 'order.approve', entityType: 'order', entityId: orderId, after: { note: input?.note ?? null, lines: order.items.length, total: order.totalPaise }, ...meta });
    return ordersService.getDetail(orderId);
  },

  async reject(orderId: string, input: RejectInput, user: AuthUser, meta: RequestMeta): Promise<OrderDetail> {
    const order = await load(orderId);
    if (!REJECTABLE_STATES.includes(order.status)) {
      throw new AppError(409, 'INVALID_ORDER_STATE', `Order is ${order.status} and cannot be rejected`, { status: order.status, allowed: REJECTABLE_STATES });
    }
    const actor = staffActor(user);
    await releaseActiveReservations(orderId, actor, `rejected: ${input.reason}`);
    await prisma.$transaction(async (db) => {
      const moved = await ordersRepository.transition(db, orderId, REJECTABLE_STATES, 'rejected', { reserveIdempotencyKey: null });
      if (!moved) throw new AppError(409, 'ORDER_STATE_CHANGED', 'Order changed while rejecting; reload and retry');
      await repo.createDecision(db, { orderId, staffUserId: user.id, decision: 'rejected', fromStatus: order.status, toStatus: 'rejected', note: input.reason });
      await ordersRepository.addEvent(db, { orderId, type: 'rejected', fromStatus: order.status, toStatus: 'rejected', ...actorFields(actor), reason: input.reason });
    });
    await audit({ actorType: 'staff', actorId: user.id, action: 'order.reject', entityType: 'order', entityId: orderId, before: { status: order.status }, after: { reason: input.reason }, ...meta });
    return ordersService.getDetail(orderId);
  },
};
