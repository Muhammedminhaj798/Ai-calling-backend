import { prisma } from '../../config/db.ts';
import type { Prisma } from '../../generated/prisma/client.ts';
import { orderDetailInclude } from '../orders/orders.repository.ts';

export const approvalsRepository = {
  listPending(where: Prisma.OrderWhereInput, skip: number, take: number) {
    const full: Prisma.OrderWhereInput = { ...where, status: 'pending_staff_approval' };
    return Promise.all([
      prisma.order.findMany({ where: full, orderBy: { customerConfirmedAt: 'asc' }, skip, take, include: orderDetailInclude }),
      prisma.order.count({ where: full }),
    ]);
  },
  createDecision: (db: Prisma.TransactionClient, data: Prisma.StaffApprovalUncheckedCreateInput) => db.staffApproval.create({ data }),
};
