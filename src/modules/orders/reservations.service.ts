// Stock reservation service (ARCHITECTURE.md §B.7). Reserves through the inventory adapter only — the mock
// today, the client API later — and never records a reservation the provider did not confirm.
//
// Flow: validate lines → lock the order (pending_stock_reservation) → recheck available-to-sell →
// reserve all lines with an idempotency key → persist reservations and move to pending_staff_approval.
// Any shortage or provider failure releases whatever was reserved, raises an exception and returns the
// order to customer_confirmed (or `failed` after a provider outage).
import { randomUUID } from 'node:crypto';
import { prisma } from '../../config/db.ts';
import { env } from '../../config/env.ts';
import type { ExceptionType } from '../../generated/prisma/enums.ts';
import { InventoryAdapterError, type InventoryAdapter, type ReserveLine } from '../../integrations/inventory/inventory.port.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { audit, type RequestMeta } from '../../utils/audit.ts';
import { logger } from '../../utils/logger.ts';
import { exceptionsService } from '../exceptions/exceptions.service.ts';
import { getInventoryAdapter } from '../inventory/inventory.service.ts';
import { productsRepository } from '../products/products.repository.ts';
import { ordersRepository as repo, type OrderDetailRecord } from './orders.repository.ts';
import { RESERVABLE_STATES } from './orders.state.ts';
import { actorFields, SYSTEM_ACTOR, type Actor, type LineAvailability, type ReservationFailureReason, type ReservationOutcome, type ReservationSummary } from './orders.types.ts';
import { evaluateAvailability, fromReserveResult, shortageExceptionType, shortageReason, type PlanLine } from './reservations.plan.ts';

const summary = (r: OrderDetailRecord['reservations'][number]): ReservationSummary => ({
  id: r.id,
  orderItemId: r.orderItemId,
  productId: r.productId,
  quantity: r.quantity,
  status: r.status,
  provider: r.provider,
  externalReservationRef: r.externalReservationRef,
  expiresAt: r.expiresAt,
  releasedAt: r.releasedAt,
});

async function load(orderId: string): Promise<OrderDetailRecord> {
  const order = await repo.findDetail(prisma, orderId);
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  return order;
}

const acceptedLines = (order: OrderDetailRecord) => order.items.filter((i) => i.status === 'active' && i.customerDecision === 'accepted');

async function planLines(order: OrderDetailRecord): Promise<PlanLine[]> {
  const accepted = acceptedLines(order);
  const products = await productsRepository.findByIds(accepted.map((i) => i.productId!));
  const sku = new Map(products.map((p) => [p.id, p.externalCode]));
  return accepted.map((i) => ({ itemId: i.id, sku: sku.get(i.productId!) ?? i.productId!, quantity: i.quantity }));
}

async function applyStockStatuses(lines: LineAvailability[]): Promise<void> {
  const now = new Date();
  for (const line of lines) {
    await prisma.orderItem.update({ where: { id: line.itemId }, data: { stockStatus: line.status, stockCheckedAt: now, availableAtCheck: line.availableToSell } });
  }
}

function groupByRef(rows: Array<{ externalReservationRef: string | null; quantity: number; product: { externalCode: string } }>): Map<string, ReserveLine[]> {
  const groups = new Map<string, ReserveLine[]>();
  for (const r of rows) {
    const key = r.externalReservationRef ?? 'local';
    groups.set(key, [...(groups.get(key) ?? []), { sku: r.product.externalCode, quantity: r.quantity }]);
  }
  return groups;
}

/**
 * Releases every active reservation of an order at the provider and marks the rows. Used by release,
 * cancel, reject and expiry. A provider failure is recorded as an exception and does not block the caller.
 */
export async function releaseActiveReservations(orderId: string, actor: Actor, reason: string, markAs: 'released' | 'expired' = 'released'): Promise<ReservationSummary[]> {
  const active = await repo.activeReservations(prisma, orderId);
  if (active.length === 0) return [];
  const adapter = getInventoryAdapter();
  for (const [ref, lines] of groupByRef(active)) {
    try {
      await adapter.release(ref, lines);
    } catch (err) {
      logger.error('reservation.release_failed', { orderId, ref, message: err instanceof Error ? err.message : String(err) });
      await exceptionsService.raise(
        {
          type: 'inventory_api_error',
          description: `Could not release reservation ${ref} at the inventory provider; verify and release manually`,
          orderId,
          details: { reservationRef: ref, lines, reason },
        },
        actor,
      );
    }
  }
  await repo.markReservations(prisma, active.map((r) => r.id), markAs);
  await repo.addEvent(prisma, {
    orderId,
    type: markAs === 'expired' ? 'reservation_expired' : 'reservation_released',
    ...actorFields(actor),
    reason,
    data: { reservationIds: active.map((r) => r.id) },
  });
  return active.map(summary);
}

async function failAttempt(order: OrderDetailRecord, adapter: InventoryAdapter, lines: LineAvailability[], reason: ReservationFailureReason, type: ExceptionType, actor: Actor, meta: RequestMeta | undefined, extra: Record<string, unknown> = {}): Promise<ReservationOutcome> {
  const short = lines.filter((l) => l.status !== 'in_stock');
  const exception = await exceptionsService.raise(
    {
      type,
      description:
        `Stock reservation failed for ${order.orderNumber}: ` +
        short.map((l) => `${l.sku} wanted ${l.quantity}, available ${l.availableToSell ?? 'unknown'}`).join('; '),
      orderId: order.id,
      customerId: order.customerId,
      callId: order.callId,
      details: { reason, lines: short, provider: adapter.source, ...extra },
    },
    actor,
  );
  await repo.transition(prisma, order.id, ['pending_stock_reservation'], 'customer_confirmed');
  await repo.addEvent(prisma, {
    orderId: order.id,
    type: 'reservation_failed',
    fromStatus: 'pending_stock_reservation',
    toStatus: 'customer_confirmed',
    ...actorFields(actor),
    reason,
    data: { exceptionId: exception.id, lines },
  });
  await audit({ actorType: actor.type, actorId: actor.id ?? null, action: 'order.reserve_failed', entityType: 'order', entityId: order.id, after: { reason, exceptionId: exception.id }, ...meta });
  return { outcome: 'failed', orderStatus: 'customer_confirmed', reason, source: adapter.source, isMock: adapter.isMock, lines, exceptionId: exception.id };
}

async function reservedOutcome(order: OrderDetailRecord, adapter: InventoryAdapter, replay: boolean, lines?: LineAvailability[]): Promise<ReservationOutcome> {
  const active = order.reservations.filter((r) => r.status === 'active');
  const planned = lines ?? (await planLines(order)).map((l): LineAvailability => {
    const item = order.items.find((i) => i.id === l.itemId);
    return { ...l, availableToSell: item?.availableAtCheck ?? null, status: 'in_stock' };
  });
  return {
    outcome: 'reserved',
    orderStatus: order.status,
    replay,
    source: adapter.source,
    isMock: adapter.isMock,
    expiresAt: active[0]?.expiresAt ?? null,
    lines: planned,
    reservations: active.map(summary),
  };
}

export const reservationsService = {
  async reserve(orderId: string, idempotencyKey: string | undefined, actor: Actor, meta?: RequestMeta): Promise<ReservationOutcome> {
    const order = await load(orderId);
    const adapter = getInventoryAdapter();

    if (order.status === 'pending_staff_approval') {
      if (idempotencyKey && order.reserveIdempotencyKey === idempotencyKey) return reservedOutcome(order, adapter, true);
      throw new AppError(409, 'ORDER_ALREADY_RESERVED', 'Stock is already reserved for this order; release it before reserving again');
    }
    if (order.status === 'pending_stock_reservation') {
      throw new AppError(409, 'RESERVATION_IN_PROGRESS', 'Another reservation attempt is in progress for this order');
    }
    if (order.status === 'draft' || order.status === 'pending_customer_confirmation') {
      throw new AppError(409, 'CUSTOMER_UNCONFIRMED', 'Customer confirmation is required before stock can be reserved', { status: order.status });
    }
    if (!RESERVABLE_STATES.includes(order.status)) {
      throw new AppError(409, 'INVALID_ORDER_STATE', `Order is ${order.status} and cannot be reserved`, { status: order.status });
    }

    const flagged = order.items.filter((i) => i.status === 'flagged');
    const accepted = acceptedLines(order);
    if (flagged.length > 0 || accepted.length === 0 || accepted.some((i) => !i.productId || i.quantity < 1)) {
      const description = flagged.length > 0
        ? `${flagged.length} unresolved line(s) must be resolved or removed before stock can be reserved`
        : 'Order has no accepted lines linked to catalogue products';
      const exception = await exceptionsService.raise(
        { type: 'order_validation_failed', description, orderId, customerId: order.customerId, callId: order.callId, details: { flaggedItemIds: flagged.map((i) => i.id) } },
        actor,
      );
      throw new AppError(422, 'ORDER_VALIDATION_FAILED', description, { exceptionId: exception.id, flaggedItemIds: flagged.map((i) => i.id) });
    }

    const lines = await planLines(order);
    const key = idempotencyKey ?? randomUUID();

    const locked = await repo.transition(prisma, orderId, RESERVABLE_STATES, 'pending_stock_reservation', { reserveIdempotencyKey: key });
    if (!locked) throw new AppError(409, 'RESERVATION_IN_PROGRESS', 'Another reservation attempt is in progress for this order');
    await repo.addEvent(prisma, { orderId, type: 'status_changed', fromStatus: order.status, toStatus: 'pending_stock_reservation', ...actorFields(actor), data: { idempotencyKey: key } });

    try {
      // 1. Recheck available-to-sell before touching the provider's reservations.
      const levels = await adapter.getStock(lines.map((l) => l.sku));
      const plan = evaluateAvailability(lines, levels);
      await applyStockStatuses(plan.lines);
      if (!plan.allAvailable) return await failAttempt(order, adapter, plan.lines, shortageReason(plan.lines), shortageExceptionType(plan.lines), actor, meta);

      // 2. Reserve every line under one idempotency key.
      const result = await adapter.reserve(lines.map((l) => ({ sku: l.sku, quantity: l.quantity })), key);
      if (!result.allReserved) {
        // The provider could not reserve everything: undo any partial lines, then report the shortages.
        const partial = result.lines.filter((l) => l.reserved > 0).map((l) => ({ sku: l.sku, quantity: l.reserved }));
        if (partial.length > 0) {
          try {
            await adapter.release(result.reservationRef, partial);
          } catch (err) {
            logger.error('reservation.partial_release_failed', { orderId, ref: result.reservationRef, message: err instanceof Error ? err.message : String(err) });
            await exceptionsService.raise(
              { type: 'inventory_api_error', description: `Partial reservation ${result.reservationRef} could not be released; verify at the inventory provider`, orderId, details: { reservationRef: result.reservationRef, partial } },
              actor,
            );
          }
        }
        const after = fromReserveResult(lines, result.lines);
        await applyStockStatuses(after.lines);
        return await failAttempt(order, adapter, after.lines, 'provider_partial', shortageExceptionType(after.lines), actor, meta, { reservationRef: result.reservationRef });
      }

      // 3. The provider confirmed every line: persist and hand over to staff.
      const expiresAt = new Date(Date.now() + env.RESERVATION_TTL_HOURS * 3_600_000);
      const detail = await prisma.$transaction(async (db) => {
        await repo.createReservations(
          db,
          lines.map((l) => ({
            orderId,
            orderItemId: l.itemId,
            productId: accepted.find((i) => i.id === l.itemId)!.productId!,
            quantity: l.quantity,
            status: 'active',
            provider: adapter.source,
            externalReservationRef: result.reservationRef,
            idempotencyKey: key,
            expiresAt,
          })),
        );
        await db.orderItem.updateMany({ where: { id: { in: lines.map((l) => l.itemId) } }, data: { stockStatus: 'in_stock', stockCheckedAt: new Date() } });
        const moved = await repo.transition(db, orderId, ['pending_stock_reservation'], 'pending_staff_approval');
        if (!moved) throw new AppError(409, 'ORDER_STATE_CHANGED', 'Order changed while reserving; reload and retry');
        await repo.addEvent(db, {
          orderId,
          type: 'reservation_succeeded',
          fromStatus: 'pending_stock_reservation',
          toStatus: 'pending_staff_approval',
          ...actorFields(actor),
          data: { reservationRef: result.reservationRef, provider: adapter.source, isMock: adapter.isMock, expiresAt, lines },
        });
        return (await repo.findDetail(db, orderId))!;
      });
      await audit({ actorType: actor.type, actorId: actor.id ?? null, action: 'order.reserve', entityType: 'order', entityId: orderId, after: { reservationRef: result.reservationRef, provider: adapter.source, lines: lines.length, expiresAt }, ...meta });
      return reservedOutcome(detail, adapter, false, plan.lines);
    } catch (err) {
      if (err instanceof AppError && err.code === 'ORDER_STATE_CHANGED') throw err;
      const message = err instanceof Error ? err.message : String(err);
      await repo.transition(prisma, orderId, ['pending_stock_reservation'], 'failed');
      await prisma.orderItem.updateMany({ where: { id: { in: lines.map((l) => l.itemId) } }, data: { stockStatus: 'error', stockCheckedAt: new Date() } });
      const exception = await exceptionsService.raise(
        { type: 'inventory_api_error', description: `Inventory provider error during reservation of ${order.orderNumber}: ${message}`, orderId, customerId: order.customerId, callId: order.callId, details: { idempotencyKey: key, provider: adapter.source } },
        actor,
      );
      await repo.addEvent(prisma, { orderId, type: 'reservation_failed', fromStatus: 'pending_stock_reservation', toStatus: 'failed', ...actorFields(actor), reason: message, data: { exceptionId: exception.id } });
      await audit({ actorType: actor.type, actorId: actor.id ?? null, action: 'order.reserve_failed', entityType: 'order', entityId: orderId, after: { reason: 'inventory_api_error', exceptionId: exception.id }, ...meta });
      if (err instanceof InventoryAdapterError) {
        throw new AppError(503, 'INVENTORY_UNAVAILABLE', 'Inventory system did not respond; the order is marked failed and the reservation can be retried', { orderStatus: 'failed', exceptionId: exception.id });
      }
      throw err;
    }
  },

  async release(orderId: string, actor: Actor, meta: RequestMeta, reason = 'released by staff'): Promise<{ orderStatus: string; released: ReservationSummary[] }> {
    const order = await load(orderId);
    if (!order.reservations.some((r) => r.status === 'active')) {
      throw new AppError(409, 'NO_ACTIVE_RESERVATIONS', 'This order has no active reservations to release');
    }
    const released = await releaseActiveReservations(orderId, actor, reason);
    let status = order.status;
    if (order.status === 'pending_staff_approval') {
      await repo.transition(prisma, orderId, ['pending_staff_approval'], 'customer_confirmed', { reserveIdempotencyKey: null });
      await repo.addEvent(prisma, { orderId, type: 'status_changed', fromStatus: 'pending_staff_approval', toStatus: 'customer_confirmed', ...actorFields(actor), reason });
      status = 'customer_confirmed';
    }
    await audit({ actorType: actor.type, actorId: actor.id ?? null, action: 'order.release', entityType: 'order', entityId: orderId, after: { released: released.length, reason }, ...meta });
    return { orderStatus: status, released };
  },

  async list(orderId: string): Promise<ReservationSummary[]> {
    await load(orderId);
    return (await repo.reservations(orderId)).map(summary);
  },

  /**
   * Expires overdue reservations: releases them at the provider, marks them expired, sends the order back to
   * customer_confirmed and raises reservation_expired for staff. Called by the server's interval timer.
   */
  async expireOverdue(now = new Date()): Promise<{ orders: number; reservations: number }> {
    const rows = await repo.findExpiredActive(now);
    const byOrder = new Map<string, typeof rows>();
    for (const r of rows) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);

    for (const [orderId, group] of byOrder) {
      const order = group[0]!.order;
      await releaseActiveReservations(orderId, SYSTEM_ACTOR, `expired at ${now.toISOString()}`, 'expired');
      if (order.status === 'pending_staff_approval') {
        await repo.transition(prisma, orderId, ['pending_staff_approval'], 'customer_confirmed', { reserveIdempotencyKey: null });
        await repo.addEvent(prisma, { orderId, type: 'status_changed', fromStatus: 'pending_staff_approval', toStatus: 'customer_confirmed', ...actorFields(SYSTEM_ACTOR), reason: 'reservation expired' });
      }
      await exceptionsService.raise(
        {
          type: 'reservation_expired',
          description: `Stock reservation expired before staff approval (${group.length} line(s)); reserve again before approving`,
          orderId,
          customerId: order.customerId,
          callId: order.callId,
          details: { reservationIds: group.map((r) => r.id), expiredAt: now },
        },
        SYSTEM_ACTOR,
      );
    }
    return { orders: byOrder.size, reservations: rows.length };
  },
};
