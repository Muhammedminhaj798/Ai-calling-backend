import { prisma } from '../../config/db.ts';
import type { Prisma } from '../../generated/prisma/client.ts';

export type Db = Prisma.TransactionClient;

export const exceptionInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  resolvedBy: { select: { id: true, name: true, email: true } },
  order: { select: { id: true, orderNumber: true, status: true } },
  customer: { select: { id: true, externalCode: true, name: true } },
  orderItem: { select: { id: true, lineNo: true, requestedText: true, quantity: true, status: true } },
} satisfies Prisma.ExceptionInclude;

export type ExceptionRecord = Prisma.ExceptionGetPayload<{ include: typeof exceptionInclude }>;

export const exceptionsRepository = {
  create: (db: Db, data: Prisma.ExceptionUncheckedCreateInput) => db.exception.create({ data, include: exceptionInclude }),
  findById: (id: string) => prisma.exception.findUnique({ where: { id }, include: exceptionInclude }),
  update: (db: Db, id: string, data: Prisma.ExceptionUncheckedUpdateInput) => db.exception.update({ where: { id }, data, include: exceptionInclude }),
  list(where: Prisma.ExceptionWhereInput, orderBy: Prisma.ExceptionOrderByWithRelationInput, skip: number, take: number) {
    return Promise.all([prisma.exception.findMany({ where, orderBy, skip, take, include: exceptionInclude }), prisma.exception.count({ where })]);
  },
  /** Closes every open exception attached to an order line (used when staff resolve the line itself). */
  resolveForItem: (db: Db, orderItemId: string, resolvedById: string | null, resolutionNote: string) =>
    db.exception.updateMany({
      where: { orderItemId, status: { in: ['open', 'in_progress'] } },
      data: { status: 'resolved', resolutionNote, resolvedById, resolvedAt: new Date() },
    }),
};
