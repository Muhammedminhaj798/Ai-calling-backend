// Exception management: the staff queue for everything the automated flow could not resolve on its own.
// Other modules raise exceptions through `raise()`; staff work them through the HTTP endpoints.
import { prisma } from '../../config/db.ts';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { AuthUser } from '../../middleware/auth.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { audit, type RequestMeta } from '../../utils/audit.ts';
import { pageResult, parseSort, skipTake, type Page } from '../../utils/pagination.ts';
import { authRepository } from '../auth/auth.repository.ts';
import type { Actor } from '../orders/orders.types.ts';
import { exceptionsRepository as repo, type Db, type ExceptionRecord } from './exceptions.repository.ts';
import type { RaiseExceptionInput } from './exceptions.types.ts';
import type { AssignExceptionInput, CreateExceptionInput, ListExceptionsQuery, ResolveExceptionInput, UpdateExceptionInput } from './exceptions.validation.ts';

const SORTABLE = ['createdAt', 'type', 'status'] as const;
const CLOSED = ['resolved', 'dismissed'] as const;

const toJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);

async function getOrThrow(id: string): Promise<ExceptionRecord> {
  const exception = await repo.findById(id);
  if (!exception) throw new AppError(404, 'NOT_FOUND', 'Exception not found');
  return exception;
}

function assertOpen(exception: ExceptionRecord): void {
  if ((CLOSED as readonly string[]).includes(exception.status)) {
    throw new AppError(409, 'EXCEPTION_CLOSED', `Exception is already ${exception.status}`);
  }
}

export const exceptionsService = {
  /** Internal: raise an exception from system code (orders, reservations, AI). Never throws on audit failure. */
  async raise(input: RaiseExceptionInput, actor: Actor, db: Db = prisma): Promise<ExceptionRecord> {
    const exception = await repo.create(db, {
      type: input.type,
      description: input.description,
      callId: input.callId ?? null,
      customerId: input.customerId ?? null,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      details: toJson(input.details),
    });
    await audit({
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: 'exception.raise',
      entityType: 'exception',
      entityId: exception.id,
      after: { type: input.type, orderId: input.orderId ?? null, orderItemId: input.orderItemId ?? null },
    });
    return exception;
  },

  async create(input: CreateExceptionInput, user: AuthUser, meta: RequestMeta): Promise<ExceptionRecord> {
    if (input.orderId && !(await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true } }))) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Linked order not found');
    }
    if (input.customerId && !(await prisma.customer.findUnique({ where: { id: input.customerId }, select: { id: true } }))) {
      throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Linked customer not found');
    }
    if (input.orderItemId && !(await prisma.orderItem.findUnique({ where: { id: input.orderItemId }, select: { id: true } }))) {
      throw new AppError(404, 'ORDER_ITEM_NOT_FOUND', 'Linked order line not found');
    }
    const exception = await repo.create(prisma, {
      type: input.type,
      description: input.description,
      callId: input.callId ?? null,
      customerId: input.customerId ?? null,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      details: toJson(input.details),
    });
    await audit({ actorType: 'staff', actorId: user.id, action: 'exception.create', entityType: 'exception', entityId: exception.id, after: input, ...meta });
    return exception;
  },

  get: getOrThrow,

  async list(query: ListExceptionsQuery, user: AuthUser): Promise<Page<ExceptionRecord>> {
    const where: Prisma.ExceptionWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.callId ? { callId: query.callId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.assignedTo === 'me' ? { assignedTo: user.id } : query.assignedTo === 'unassigned' ? { assignedTo: null } : query.assignedTo ? { assignedTo: query.assignedTo } : {}),
    };
    const sort = parseSort(query.sort, SORTABLE, 'createdAt');
    const { skip, take } = skipTake(query);
    const [data, total] = await repo.list(where, { [sort.field]: sort.direction }, skip, take);
    return pageResult(data, total, query);
  },

  async update(id: string, input: UpdateExceptionInput, user: AuthUser, meta: RequestMeta): Promise<ExceptionRecord> {
    const existing = await getOrThrow(id);
    assertOpen(existing);
    const updated = await repo.update(prisma, id, { ...input, details: toJson(input.details) });
    await audit({ actorType: 'staff', actorId: user.id, action: 'exception.update', entityType: 'exception', entityId: id, before: { status: existing.status, description: existing.description }, after: input, ...meta });
    return updated;
  },

  async assign(id: string, input: AssignExceptionInput, user: AuthUser, meta: RequestMeta): Promise<ExceptionRecord> {
    const existing = await getOrThrow(id);
    assertOpen(existing);
    if (input.assigneeId) {
      const assignee = await authRepository.findUserById(input.assigneeId);
      if (!assignee || !assignee.isActive) throw new AppError(404, 'ASSIGNEE_NOT_FOUND', 'Staff user not found or inactive');
    }
    const updated = await repo.update(prisma, id, {
      assignedTo: input.assigneeId,
      status: input.assigneeId && existing.status === 'open' ? 'in_progress' : existing.status,
    });
    await audit({ actorType: 'staff', actorId: user.id, action: 'exception.assign', entityType: 'exception', entityId: id, before: { assignedTo: existing.assignedTo }, after: { assignedTo: input.assigneeId }, ...meta });
    return updated;
  },

  async resolve(id: string, input: ResolveExceptionInput, user: AuthUser, meta: RequestMeta): Promise<ExceptionRecord> {
    const existing = await getOrThrow(id);
    assertOpen(existing);
    const updated = await repo.update(prisma, id, {
      status: input.status,
      resolutionNote: input.resolutionNote,
      resolvedById: user.id,
      resolvedAt: new Date(),
    });
    await audit({ actorType: 'staff', actorId: user.id, action: `exception.${input.status}`, entityType: 'exception', entityId: id, before: { status: existing.status }, after: input, ...meta });
    return updated;
  },

  /** Internal: close the exceptions attached to a line that staff just resolved. */
  resolveForItem: (db: Db, orderItemId: string, resolvedById: string | null, note: string) => repo.resolveForItem(db, orderItemId, resolvedById, note),
};
