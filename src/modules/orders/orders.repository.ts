// Prisma queries for orders, lines, events, confirmations and reservations. Functions take the client to
// run on (`prisma` or a transaction client) so services can compose them atomically.
import { prisma } from '../../config/db.ts';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { OrderStatus, ReservationStatus } from '../../generated/prisma/enums.ts';

export type Db = Prisma.TransactionClient;

export const orderDetailInclude = {
  items: { orderBy: { lineNo: 'asc' } },
  customer: { select: { id: true, externalCode: true, name: true, phonePrimary: true, status: true, preferredLanguage: true } },
  reservations: { orderBy: { createdAt: 'desc' } },
  confirmations: { orderBy: { createdAt: 'desc' } },
  approvals: { orderBy: { createdAt: 'desc' }, include: { staffUser: { select: { id: true, name: true, email: true } } } },
  exceptions: {
    where: { status: { in: ['open', 'in_progress'] } },
    select: { id: true, type: true, status: true, description: true, orderItemId: true, assignedTo: true },
  },
} satisfies Prisma.OrderInclude;

export type OrderDetailRecord = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;

const listInclude = {
  items: {
    orderBy: { lineNo: 'asc' },
    select: { id: true, lineNo: true, nameSnapshot: true, requestedText: true, quantity: true, status: true, stockStatus: true, customerDecision: true },
  },
  customer: { select: { id: true, externalCode: true, name: true } },
} satisfies Prisma.OrderInclude;

export const ordersRepository = {
  /** PO-YYYYMMDD-NNNNN from the order_number_seq sequence (migration 3). */
  async nextOrderNumber(db: Db): Promise<string> {
    const [row] = await db.$queryRaw<{ n: bigint }[]>`SELECT nextval('order_number_seq') AS n`;
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `PO-${date}-${String(row?.n ?? 0n).padStart(5, '0')}`;
  },

  create: (db: Db, data: Prisma.OrderCreateInput) => db.order.create({ data }),
  update: (db: Db, id: string, data: Prisma.OrderUpdateInput) => db.order.update({ where: { id }, data }),
  findDetail: (db: Db, id: string) => db.order.findUnique({ where: { id }, include: orderDetailInclude }),
  findByIdempotencyKey: (idempotencyKey: string) => prisma.order.findUnique({ where: { idempotencyKey }, include: orderDetailInclude }),
  findByCallId: (callId: string) => prisma.order.findUnique({ where: { callId } }),
  findRecentOpenForCustomer: (customerId: string, since: Date, excludeId: string) =>
    prisma.order.findMany({
      where: { customerId, id: { not: excludeId }, createdAt: { gte: since }, status: { notIn: ['rejected', 'cancelled', 'fulfilled'] } },
      select: { id: true, orderNumber: true, status: true },
    }),

  list(where: Prisma.OrderWhereInput, orderBy: Prisma.OrderOrderByWithRelationInput, skip: number, take: number) {
    return Promise.all([prisma.order.findMany({ where, orderBy, skip, take, include: listInclude }), prisma.order.count({ where })]);
  },

  /**
   * Guarded status change: succeeds only while the order is still in one of `from`. Returns false when a
   * concurrent request moved it first — this is how parallel confirm/reserve/approve calls are serialised.
   */
  async transition(db: Db, id: string, from: readonly OrderStatus[], to: OrderStatus, data: Prisma.OrderUpdateManyMutationInput = {}): Promise<boolean> {
    const { count } = await db.order.updateMany({ where: { id, status: { in: [...from] } }, data: { ...data, status: to } });
    return count === 1;
  },

  // --- lines ---
  findItem: (db: Db, orderId: string, itemId: string) => db.orderItem.findFirst({ where: { id: itemId, orderId } }),
  async nextLineNo(db: Db, orderId: string): Promise<number> {
    const agg = await db.orderItem.aggregate({ where: { orderId }, _max: { lineNo: true } });
    return (agg._max.lineNo ?? 0) + 1;
  },
  addItem: (db: Db, data: Prisma.OrderItemUncheckedCreateInput) => db.orderItem.create({ data }),
  updateItem: (db: Db, id: string, data: Prisma.OrderItemUncheckedUpdateInput) => db.orderItem.update({ where: { id }, data }),
  deleteItem: (db: Db, id: string) => db.orderItem.delete({ where: { id } }),
  items: (db: Db, orderId: string) => db.orderItem.findMany({ where: { orderId }, orderBy: { lineNo: 'asc' } }),

  // --- history ---
  /** `data` may be any serialisable value; it is normalised to plain JSON (Dates become ISO strings). */
  addEvent: (db: Db, event: Omit<Prisma.OrderEventUncheckedCreateInput, 'data'> & { data?: unknown }) =>
    db.orderEvent.create({
      data: { ...event, data: event.data === undefined ? undefined : (JSON.parse(JSON.stringify(event.data)) as Prisma.InputJsonValue) },
    }),
  events: (orderId: string, take = 200) => prisma.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, take }),

  // --- customer confirmation ---
  supersedePendingConfirmations: (db: Db, orderId: string) =>
    db.orderConfirmation.updateMany({ where: { orderId, status: 'pending' }, data: { status: 'superseded' } }),
  createConfirmation: (db: Db, data: Prisma.OrderConfirmationUncheckedCreateInput) => db.orderConfirmation.create({ data }),
  markConfirmed: (db: Db, id: string, data: Prisma.OrderConfirmationUncheckedUpdateInput) =>
    db.orderConfirmation.update({ where: { id }, data: { ...data, status: 'confirmed' } }),

  // --- reservations ---
  createReservations: (db: Db, rows: Prisma.StockReservationUncheckedCreateInput[]) => db.stockReservation.createMany({ data: rows }),
  reservations: (orderId: string) => prisma.stockReservation.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } }),
  activeReservations: (db: Db, orderId: string) =>
    db.stockReservation.findMany({ where: { orderId, status: 'active' }, include: { product: { select: { externalCode: true } } } }),
  markReservations: (db: Db, ids: string[], status: Exclude<ReservationStatus, 'active'>) =>
    db.stockReservation.updateMany({ where: { id: { in: ids } }, data: { status, releasedAt: new Date() } }),
  findExpiredActive: (now: Date) =>
    prisma.stockReservation.findMany({
      where: { status: 'active', expiresAt: { lt: now } },
      include: { product: { select: { externalCode: true } }, order: { select: { id: true, status: true, customerId: true, callId: true } } },
    }),
};
