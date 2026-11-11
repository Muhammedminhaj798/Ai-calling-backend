// Order management: drafts, lines, read-back, customer confirmation, cancellation, history.
// Rules enforced here (ARCHITECTURE.md §0, §E): a line is only ever a catalogue product or an explicitly
// flagged request; prices come from the catalogue snapshot; nothing moves forward without the state machine.
// Mutations take an Actor so staff (HTTP) and the AI (tool layer) share one code path; cancel stays staff-only.
import { prisma } from '../../config/db.ts';
import { env } from '../../config/env.ts';
import type { Prisma, Product } from '../../generated/prisma/client.ts';
import type { ExceptionType, OrderStatus } from '../../generated/prisma/enums.ts';
import type { AuthUser } from '../../middleware/auth.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { audit, type RequestMeta } from '../../utils/audit.ts';
import { pageResult, parseSort, skipTake, type Page } from '../../utils/pagination.ts';
import { customersRepository } from '../customers/customers.repository.ts';
import { exceptionsService } from '../exceptions/exceptions.service.ts';
import { productsRepository } from '../products/products.repository.ts';
import { buildReadbackText, computeTotals, lineTotalPaise } from './orders.pricing.ts';
import { ordersRepository as repo, type Db, type OrderDetailRecord } from './orders.repository.ts';
import { APPROVER_CANCELLABLE_STATES, LINE_EDITABLE_STATES, META_EDITABLE_STATES, STAFF_CANCELLABLE_STATES, assertState } from './orders.state.ts';
import { actorFields, staffActor, type Actor, type ReadbackLine, type ReadbackResult } from './orders.types.ts';
import type { AddItemInput, CancelOrderInput, ConfirmOrderInput, CreateOrderInput, FlagReason, ListOrdersQuery, UpdateItemInput, UpdateOrderInput } from './orders.validation.ts';
import { releaseActiveReservations } from './reservations.service.ts';

const SORTABLE = ['createdAt', 'orderNumber', 'status', 'totalPaise'] as const;
const DUPLICATE_WINDOW_MS = 30 * 60_000;
/** States in which staff may still remove a flagged line that is blocking stock reservation. */
const FLAGGED_LINE_REMOVABLE_STATES: readonly OrderStatus[] = [...LINE_EDITABLE_STATES, 'customer_confirmed', 'failed'];

/** Which staff exception a flagged line raises. */
const FLAG_EXCEPTION: Record<FlagReason, ExceptionType> = {
  product_not_found: 'product_not_found',
  ambiguous_product: 'ambiguous_product',
  out_of_stock: 'out_of_stock',
  stock_unverified: 'inventory_api_error',
};

export type OrderDetail = OrderDetailRecord & { events: Awaited<ReturnType<typeof repo.events>> };

const auditActor = (actor: Actor) => ({ actorType: actor.type, actorId: actor.id ?? null });

async function loadOrder(db: Db, id: string): Promise<OrderDetailRecord> {
  const order = await repo.findDetail(db, id);
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
  return order;
}

async function withEvents(order: OrderDetailRecord): Promise<OrderDetail> {
  return { ...order, events: await repo.events(order.id) };
}

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The details the customer confirmed must match the catalogue product; otherwise the wrong medicine is being ordered. */
function assertIdentity(product: Product, confirmed: AddItemInput['confirmedDetails']): void {
  if (!confirmed) return;
  const mismatches = (['name', 'strength', 'packSize'] as const).filter((k) => confirmed[k] !== undefined && norm(confirmed[k]) !== norm(product[k]));
  if (mismatches.length > 0) {
    throw new AppError(422, 'PRODUCT_IDENTITY_MISMATCH', 'Confirmed medicine details do not match the catalogue product', {
      mismatches,
      catalogue: { name: product.name, strength: product.strength, packSize: product.packSize },
    });
  }
}

async function resolveProduct(productId: string, confirmed: AddItemInput['confirmedDetails']): Promise<Product> {
  const product = await productsRepository.findById(productId);
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Catalogue product not found');
  if (product.status !== 'active') throw new AppError(422, 'PRODUCT_INACTIVE', `Product ${product.externalCode} is ${product.status} and cannot be ordered`);
  assertIdentity(product, confirmed);
  return product;
}

const snapshot = (product: Product) => ({
  productId: product.id,
  nameSnapshot: product.name,
  brandSnapshot: product.brand,
  strengthSnapshot: product.strength,
  formSnapshot: product.form,
  packSizeSnapshot: product.packSize,
  unitSnapshot: product.unit,
  unitPricePaise: product.ptrPaise,
});

interface LineRef {
  productId: string | null;
}

async function addLine(db: Db, order: { id: string; customerId: string; callId: string | null }, input: AddItemInput, actor: Actor, existing: LineRef[]) {
  if (existing.length >= env.MAX_ORDER_ITEMS) {
    throw new AppError(422, 'ORDER_ITEM_LIMIT', `Orders are limited to ${env.MAX_ORDER_ITEMS} lines`, { max: env.MAX_ORDER_ITEMS });
  }
  const lineNo = await repo.nextLineNo(db, order.id);

  if (input.productId) {
    const product = await resolveProduct(input.productId, input.confirmedDetails);
    if (existing.some((i) => i.productId === product.id)) {
      throw new AppError(409, 'DUPLICATE_ORDER_ITEM', `${product.name} is already on this order; change its quantity instead`, { productId: product.id });
    }
    const item = await repo.addItem(db, {
      orderId: order.id,
      lineNo,
      requestedText: input.requestedText,
      quantity: input.quantity,
      status: 'active',
      ...snapshot(product),
      lineTotalPaise: lineTotalPaise(input.quantity, product.ptrPaise),
    });
    await repo.addEvent(db, { orderId: order.id, type: 'item_added', ...actorFields(actor), data: { itemId: item.id, lineNo, sku: product.externalCode, quantity: input.quantity } });
    return item;
  }

  // Unresolved or unavailable request: kept verbatim, flagged, and handed to staff — never guessed.
  const flagReason = input.flagReason!;
  const item = await repo.addItem(db, {
    orderId: order.id,
    lineNo,
    requestedText: input.requestedText,
    quantity: input.quantity,
    status: 'flagged',
    flagReason,
  });
  await repo.addEvent(db, { orderId: order.id, type: 'item_flagged', ...actorFields(actor), data: { itemId: item.id, lineNo, requestedText: input.requestedText, flagReason } });
  await exceptionsService.raise(
    {
      type: FLAG_EXCEPTION[flagReason],
      description: `Medicine request "${input.requestedText}" (quantity ${input.quantity}) flagged as ${flagReason.replace(/_/g, ' ')}; needs staff review`,
      orderId: order.id,
      orderItemId: item.id,
      customerId: order.customerId,
      callId: order.callId,
      details: { requestedText: input.requestedText, quantity: input.quantity, flagReason },
    },
    actor,
    db,
  );
  return item;
}

/** Recomputes totals, bumps the revision and, if a read-back was pending, invalidates it (back to draft). */
async function afterLineChange(db: Db, order: OrderDetailRecord, actor: Actor): Promise<void> {
  const items = await repo.items(db, order.id);
  const data: Prisma.OrderUpdateInput = { ...computeTotals(items), revision: { increment: 1 } };
  if (order.status === 'pending_customer_confirmation') {
    await repo.supersedePendingConfirmations(db, order.id);
    data.status = 'draft';
    await repo.addEvent(db, { orderId: order.id, type: 'status_changed', fromStatus: 'pending_customer_confirmation', toStatus: 'draft', ...actorFields(actor), reason: 'lines changed after read-back' });
  }
  await repo.update(db, order.id, data);
}

export const ordersService = {
  async create(input: CreateOrderInput, actor: Actor, meta: RequestMeta, idempotencyKey?: string): Promise<OrderDetail> {
    if (idempotencyKey) {
      const existing = await repo.findByIdempotencyKey(idempotencyKey);
      if (existing) return withEvents(existing);
    }
    const customer = await customersRepository.findById(input.customerId);
    if (!customer) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    if (customer.status !== 'active') {
      if (input.callId) {
        await exceptionsService.raise(
          { type: 'customer_not_eligible', description: `Customer ${customer.externalCode} is ${customer.status}; automated ordering is not allowed`, customerId: customer.id, callId: input.callId },
          actor,
        );
      }
      throw new AppError(422, 'CUSTOMER_NOT_ELIGIBLE', `Customer is ${customer.status}; only active customers can place orders`, { status: customer.status });
    }
    if (input.deliveryAddressId && !customer.addresses.some((a) => a.id === input.deliveryAddressId)) {
      throw new AppError(422, 'ADDRESS_NOT_FOUND', 'deliveryAddressId is not one of this customer\'s addresses', { deliveryAddressId: input.deliveryAddressId });
    }
    if (input.callId) {
      const forCall = await repo.findByCallId(input.callId);
      if (forCall) throw new AppError(409, 'ORDER_EXISTS_FOR_CALL', 'An order already exists for this call', { orderId: forCall.id });
    }

    const order = await prisma.$transaction(async (db) => {
      const created = await repo.create(db, {
        orderNumber: await repo.nextOrderNumber(db),
        customer: { connect: { id: customer.id } },
        call: input.callId ? { connect: { id: input.callId } } : undefined,
        deliveryAddress: input.deliveryAddressId ? { connect: { id: input.deliveryAddressId } } : undefined,
        customerPoReference: input.customerPoReference,
        notes: input.notes,
        idempotencyKey,
        createdBy: actor.id ?? actor.type,
        status: 'draft',
      });
      await repo.addEvent(db, { orderId: created.id, type: 'created', toStatus: 'draft', ...actorFields(actor), data: { customerId: customer.id, callId: input.callId ?? null, deliveryAddressId: input.deliveryAddressId ?? null } });
      const added: LineRef[] = [];
      for (const line of input.items) added.push(await addLine(db, created, line, actor, added));
      if (input.items.length > 0) await repo.update(db, created.id, computeTotals(await repo.items(db, created.id)));
      return (await repo.findDetail(db, created.id))!;
    });

    if (input.callId) {
      const recent = await repo.findRecentOpenForCustomer(customer.id, new Date(Date.now() - DUPLICATE_WINDOW_MS), order.id);
      if (recent.length > 0) {
        await exceptionsService.raise(
          { type: 'duplicate_suspected', description: `Customer ${customer.externalCode} has ${recent.length} other open order(s) from the last 30 minutes`, orderId: order.id, customerId: customer.id, callId: input.callId, details: { otherOrders: recent } },
          actor,
        );
      }
    }
    await audit({ ...auditActor(actor), action: 'order.create', entityType: 'order', entityId: order.id, after: { orderNumber: order.orderNumber, customerId: customer.id, lines: order.items.length }, ...meta });
    return withEvents(order);
  },

  async getDetail(id: string): Promise<OrderDetail> {
    return withEvents(await loadOrder(prisma, id));
  },

  async list(query: ListOrdersQuery): Promise<Page<Awaited<ReturnType<typeof repo.list>>[0][number]>> {
    const where: Prisma.OrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.callId ? { callId: query.callId } : {}),
      ...(query.q ? { orderNumber: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    };
    const sort = parseSort(query.sort, SORTABLE, 'createdAt');
    const { skip, take } = skipTake(query);
    const [data, total] = await repo.list(where, { [sort.field]: sort.direction }, skip, take);
    return pageResult(data, total, query);
  },

  async updateMeta(id: string, input: UpdateOrderInput, actor: Actor, meta: RequestMeta): Promise<OrderDetail> {
    const order = await loadOrder(prisma, id);
    assertState(order.status, META_EDITABLE_STATES, 'ORDER_LOCKED', `Order is ${order.status} and can no longer be edited`);
    await prisma.$transaction(async (db) => {
      await repo.update(db, id, input);
      await repo.addEvent(db, { orderId: id, type: 'updated', ...actorFields(actor), data: input });
    });
    await audit({ ...auditActor(actor), action: 'order.update', entityType: 'order', entityId: id, before: { customerPoReference: order.customerPoReference, notes: order.notes }, after: input, ...meta });
    return this.getDetail(id);
  },

  async addItem(id: string, input: AddItemInput, actor: Actor, meta: RequestMeta): Promise<OrderDetail> {
    const order = await loadOrder(prisma, id);
    assertState(order.status, LINE_EDITABLE_STATES, 'ORDER_LOCKED', 'Lines can only be changed before the customer confirms the order');
    const item = await prisma.$transaction(async (db) => {
      const created = await addLine(db, order, input, actor, order.items);
      await afterLineChange(db, order, actor);
      return created;
    });
    await audit({ ...auditActor(actor), action: 'order.item_add', entityType: 'order', entityId: id, after: { itemId: item.id, ...input }, ...meta });
    return this.getDetail(id);
  },

  async updateItem(id: string, itemId: string, input: UpdateItemInput, actor: Actor, meta: RequestMeta): Promise<OrderDetail> {
    const order = await loadOrder(prisma, id);
    assertState(order.status, LINE_EDITABLE_STATES, 'ORDER_LOCKED', 'Lines can only be changed before the customer confirms the order');
    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw new AppError(404, 'NOT_FOUND', 'Order line not found');

    await prisma.$transaction(async (db) => {
      const data: Prisma.OrderItemUncheckedUpdateInput = {};
      let unitPrice = item.unitPricePaise;
      if (input.productId) {
        const product = await resolveProduct(input.productId, input.confirmedDetails);
        if (order.items.some((i) => i.id !== itemId && i.productId === product.id)) {
          throw new AppError(409, 'DUPLICATE_ORDER_ITEM', `${product.name} is already on this order`, { productId: product.id });
        }
        Object.assign(data, snapshot(product), { status: 'active', flagReason: null, stockStatus: 'unchecked', stockCheckedAt: null, availableAtCheck: null });
        unitPrice = product.ptrPaise;
        if (item.status === 'flagged') {
          await exceptionsService.resolveForItem(db, itemId, actor.id ?? null, `Line resolved to catalogue product ${product.externalCode} (${product.name})`);
        }
      } else if (input.confirmedDetails && item.productId) {
        assertIdentity((await productsRepository.findById(item.productId))!, input.confirmedDetails);
      }
      const quantity = input.quantity ?? item.quantity;
      if (input.quantity !== undefined) data.quantity = quantity;
      if (input.requestedText !== undefined) data.requestedText = input.requestedText;
      data.lineTotalPaise = lineTotalPaise(quantity, unitPrice);
      await repo.updateItem(db, itemId, data);
      await repo.addEvent(db, { orderId: id, type: 'item_updated', ...actorFields(actor), data: { itemId, before: { quantity: item.quantity, productId: item.productId }, after: input } });
      await afterLineChange(db, order, actor);
    });
    await audit({ ...auditActor(actor), action: 'order.item_update', entityType: 'order', entityId: id, before: { itemId, quantity: item.quantity, productId: item.productId }, after: input, ...meta });
    return this.getDetail(id);
  },

  async removeItem(id: string, itemId: string, actor: Actor, meta: RequestMeta): Promise<OrderDetail> {
    const order = await loadOrder(prisma, id);
    const item = order.items.find((i) => i.id === itemId);
    if (!item) throw new AppError(404, 'NOT_FOUND', 'Order line not found');
    // A flagged (unresolved) line never had a confirmed product, so staff may still drop it after the customer
    // confirmed the rest; otherwise the order could neither be reserved nor approved. Its exception is resolved.
    const allowed = item.status === 'flagged' ? FLAGGED_LINE_REMOVABLE_STATES : LINE_EDITABLE_STATES;
    assertState(order.status, allowed, 'ORDER_LOCKED', 'Lines can only be changed before the customer confirms the order');
    await prisma.$transaction(async (db) => {
      if (item.status === 'flagged') await exceptionsService.resolveForItem(db, itemId, actor.id ?? null, 'Line removed from the order');
      await repo.deleteItem(db, itemId);
      await repo.addEvent(db, { orderId: id, type: 'item_removed', ...actorFields(actor), data: { itemId, lineNo: item.lineNo, requestedText: item.requestedText, quantity: item.quantity } });
      await afterLineChange(db, order, actor);
    });
    await audit({ ...auditActor(actor), action: 'order.item_remove', entityType: 'order', entityId: id, before: { itemId, lineNo: item.lineNo, productId: item.productId }, ...meta });
    return this.getDetail(id);
  },

  /** Issues the complete read-back for the current revision and moves the order to pending_customer_confirmation. */
  async readback(id: string, actor: Actor, meta: RequestMeta): Promise<ReadbackResult> {
    const order = await loadOrder(prisma, id);
    assertState(order.status, LINE_EDITABLE_STATES, 'INVALID_ORDER_STATE', 'Read-back is only possible before the customer confirms the order');
    const active = order.items.filter((i) => i.status === 'active' && i.productId);
    if (active.length === 0) throw new AppError(422, 'ORDER_EMPTY', 'Add at least one resolved line before reading the order back');

    const products = await productsRepository.findByIds(active.map((i) => i.productId!));
    const sku = new Map(products.map((p) => [p.id, p.externalCode]));
    const lines: ReadbackLine[] = active.map((i) => ({
      itemId: i.id,
      lineNo: i.lineNo,
      productId: i.productId!,
      sku: sku.get(i.productId!) ?? '',
      name: i.nameSnapshot ?? i.requestedText,
      strength: i.strengthSnapshot,
      form: i.formSnapshot,
      packSize: i.packSizeSnapshot,
      unit: i.unitSnapshot,
      quantity: i.quantity,
    }));
    const flaggedRequests = order.items.filter((i) => i.status === 'flagged').map((i) => ({ itemId: i.id, requestedText: i.requestedText, quantity: i.quantity, flagReason: i.flagReason }));
    const readbackText = buildReadbackText(lines);

    const confirmation = await prisma.$transaction(async (db) => {
      await repo.supersedePendingConfirmations(db, id);
      const created = await repo.createConfirmation(db, {
        orderId: id,
        revision: order.revision,
        itemsSnapshot: JSON.parse(JSON.stringify({ lines, flaggedRequests })) as Prisma.InputJsonValue,
        readbackText,
        ...actorFields(actor),
      });
      if (order.status === 'draft') {
        const moved = await repo.transition(db, id, ['draft'], 'pending_customer_confirmation');
        if (!moved) throw new AppError(409, 'ORDER_STATE_CHANGED', 'Order changed during read-back; reload and retry');
        await repo.addEvent(db, { orderId: id, type: 'status_changed', fromStatus: 'draft', toStatus: 'pending_customer_confirmation', ...actorFields(actor) });
      }
      await repo.addEvent(db, { orderId: id, type: 'readback_issued', ...actorFields(actor), data: { confirmationId: created.id, revision: order.revision, lines: lines.length } });
      return created;
    });
    await audit({ ...auditActor(actor), action: 'order.readback', entityType: 'order', entityId: id, after: { confirmationId: confirmation.id, revision: order.revision }, ...meta });
    return { confirmationId: confirmation.id, orderId: id, revision: order.revision, status: 'pending_customer_confirmation', lines, flaggedRequests, readbackText };
  },

  /** Records the customer's confirmation of the read-back for `revision`. Idempotent per idempotencyKey; duplicates are rejected. */
  async confirm(id: string, input: ConfirmOrderInput, actor: Actor, meta: RequestMeta): Promise<OrderDetail> {
    const order = await loadOrder(prisma, id);

    if (!LINE_EDITABLE_STATES.includes(order.status)) {
      const replay = input.idempotencyKey && order.confirmations.some((c) => c.status === 'confirmed' && c.idempotencyKey === input.idempotencyKey);
      if (replay) return withEvents(order);
      throw new AppError(409, 'ORDER_ALREADY_CONFIRMED', `Customer confirmation was already recorded; order is ${order.status}`, { status: order.status });
    }
    if (order.status === 'draft') throw new AppError(409, 'READBACK_REQUIRED', 'Read the complete order back to the customer before recording confirmation');
    if (input.revision !== order.revision) {
      throw new AppError(409, 'STALE_REVISION', `Read-back revision ${input.revision} is stale; the order is now at revision ${order.revision}. Issue a new read-back.`, { currentRevision: order.revision });
    }
    const pending = order.confirmations.find((c) => c.status === 'pending' && c.revision === order.revision);
    if (!pending) throw new AppError(409, 'READBACK_REQUIRED', 'No read-back is pending for this revision; issue a read-back first');

    const active = order.items.filter((i) => i.status === 'active');
    const declined = new Set(input.declinedItemIds);
    for (const declinedId of declined) {
      if (!active.some((i) => i.id === declinedId)) throw new AppError(422, 'INVALID_ITEM', 'declinedItemIds contains a line that is not on this order', { itemId: declinedId });
    }
    if (active.every((i) => declined.has(i.id))) throw new AppError(422, 'NO_ACCEPTED_ITEMS', 'The customer declined every line; cancel the order instead');

    const confirmedAt = new Date();
    const totals = computeTotals(active.map((i) => ({ ...i, customerDecision: declined.has(i.id) ? 'declined' : 'accepted' })));
    const detail = await prisma.$transaction(async (db) => {
      const moved = await repo.transition(db, id, ['pending_customer_confirmation'], 'customer_confirmed', { ...totals, customerConfirmedAt: confirmedAt });
      if (!moved) throw new AppError(409, 'ORDER_STATE_CHANGED', 'Order changed while confirming; reload and retry');
      await db.orderItem.updateMany({ where: { orderId: id, status: 'active', id: { in: [...declined] } }, data: { customerDecision: 'declined' } });
      await db.orderItem.updateMany({ where: { orderId: id, status: 'active', id: { notIn: [...declined] } }, data: { customerDecision: 'accepted' } });
      await repo.markConfirmed(db, pending.id, { source: input.source, confirmedAt, idempotencyKey: input.idempotencyKey ?? null, ...actorFields(actor) });
      await repo.addEvent(db, {
        orderId: id,
        type: 'customer_confirmed',
        fromStatus: 'pending_customer_confirmation',
        toStatus: 'customer_confirmed',
        ...actorFields(actor),
        data: { confirmationId: pending.id, revision: order.revision, source: input.source, declinedItemIds: [...declined] },
      });
      return (await repo.findDetail(db, id))!;
    });
    await audit({ ...auditActor(actor), action: 'order.customer_confirm', entityType: 'order', entityId: id, after: { revision: order.revision, source: input.source, declined: [...declined] }, ...meta });
    return withEvents(detail);
  },

  /** Staff only: the AI has no tool for this. */
  async cancel(id: string, input: CancelOrderInput, user: AuthUser, meta: RequestMeta): Promise<OrderDetail> {
    const order = await loadOrder(prisma, id);
    const allowed = user.role === 'staff' ? STAFF_CANCELLABLE_STATES : APPROVER_CANCELLABLE_STATES;
    if (!allowed.includes(order.status)) {
      if (user.role === 'staff' && APPROVER_CANCELLABLE_STATES.includes(order.status)) {
        throw new AppError(403, 'FORBIDDEN', 'Only approvers or admins can cancel an order after the customer confirmed it');
      }
      throw new AppError(409, 'INVALID_ORDER_STATE', `Order is ${order.status} and cannot be cancelled`, { status: order.status });
    }
    const actor = staffActor(user);
    await releaseActiveReservations(id, actor, `cancelled: ${input.reason}`);
    const detail = await prisma.$transaction(async (db) => {
      const moved = await repo.transition(db, id, allowed, 'cancelled', { reserveIdempotencyKey: null });
      if (!moved) throw new AppError(409, 'ORDER_STATE_CHANGED', 'Order changed while cancelling; reload and retry');
      await repo.addEvent(db, { orderId: id, type: 'cancelled', fromStatus: order.status, toStatus: 'cancelled', ...actorFields(actor), reason: input.reason });
      return (await repo.findDetail(db, id))!;
    });
    await audit({ actorType: 'staff', actorId: user.id, action: 'order.cancel', entityType: 'order', entityId: id, before: { status: order.status }, after: { reason: input.reason }, ...meta });
    return withEvents(detail);
  },
};
