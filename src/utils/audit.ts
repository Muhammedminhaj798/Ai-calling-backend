// Append-only audit trail (ARCHITECTURE.md §E). A failed audit write is logged, never thrown,
// so it cannot break the business operation it describes.
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

export async function audit(event: AuditEvent): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        before: toJson(event.before),
        after: toJson(event.after),
        ip: event.ip ?? null,
        requestId: event.requestId ?? null,
      },
    });
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
