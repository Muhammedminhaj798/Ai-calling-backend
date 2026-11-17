// Append-only audit trail (ARCHITECTURE.md §E). Two rules, by where the write happens:
// - After an operation has committed (no `tx`): a failed audit write is logged, never thrown, so it cannot break
//   an operation that has already happened.
// - Inside the operation's transaction (`tx`): the audit row is part of the operation. It commits with it or not at
//   all, and a failed write fails the operation. So an order line flagged inside its transaction is added together
//   with its staff exception and that exception's audit row, or none of them is: there is never a line without its
//   exception, nor an audit row for an exception that was rolled back. PostgreSQL leaves a transaction unusable
//   after any failed statement, so the error could not be swallowed there anyway, and writing the row on another
//   connection (as before) committed it even when the operation rolled back.
import type { Request, Response } from 'express';
import { prisma } from '../config/db.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { logger } from './logger.ts';

export type ActorType = 'staff' | 'system' | 'ai' | 'anonymous';

export interface AuditEvent {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | undefined;
  requestId?: string | undefined;
}

export interface RequestMeta {
  ip: string | undefined;
  requestId: string | undefined;
}

export function requestMeta(req: Request, res: Response): RequestMeta {
  return { ip: req.ip, requestId: res.locals['requestId'] as string | undefined };
}

/** Writes one audit row: logged on failure without `tx`, part of (and failing) the transaction with it. See above. */
export async function audit(event: AuditEvent, tx?: Prisma.TransactionClient): Promise<void> {
  const data = {
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    before: toJson(event.before),
    after: toJson(event.after),
    ip: event.ip ?? null,
    requestId: event.requestId ?? null,
  };
  if (tx) {
    await tx.auditLog.create({ data });
    return;
  }
  try {
    await prisma.auditLog.create({ data });
  } catch (err) {
    logger.error('audit.write_failed', {
      action: event.action,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}
