// The two audit failure rules (utils/audit.ts): inside an operation's transaction the row is part of it and a failed
// write fails it; after an operation, a failed write is logged and never thrown. Also that exceptionsService.raise
// writes its audit row in the transaction it was given. No database: the clients are fakes.
import '../../tests/env.ts';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { prisma } from '../config/db.ts';
import { exceptionsService } from '../modules/exceptions/exceptions.service.ts';
import { audit } from './audit.ts';
import { logger } from './logger.ts';

afterEach(() => mock.restoreAll());

const EVENT = { actorType: 'ai', action: 'order.item_add', entityType: 'order', entityId: 'order-1' } as const;

/** PrismaClient is a proxy: its delegates take plain assignment (node:test's mock.method cannot see their methods). */
function replaceAuditCreate(create: (args: unknown) => Promise<unknown>): () => void {
  const delegate = prisma.auditLog as unknown as { create: (args: unknown) => Promise<unknown> };
  const original = delegate.create;
  delegate.create = create;
  return () => {
    delegate.create = original;
  };
}

describe('audit', () => {
  it('inside a transaction: written through it, and a failed write is thrown so the operation rolls back', async () => {
    const create = mock.fn(async (_args: unknown) => {
      throw new Error('insert failed');
    });
    const global = mock.fn(async () => ({}));
    const restore = replaceAuditCreate(global);
    try {
      await assert.rejects(audit(EVENT, { auditLog: { create } } as never), /insert failed/);
    } finally {
      restore();
    }
    assert.equal(create.mock.callCount(), 1);
    assert.equal((create.mock.calls[0]!.arguments[0] as { data: { action: string } }).data.action, 'order.item_add');
    assert.equal(global.mock.callCount(), 0, 'never on the process client, outside the transaction');
  });

  it('after an operation (no transaction): a failed write is logged, never thrown', async () => {
    const logged = mock.method(logger, 'error', () => undefined);
    const restore = replaceAuditCreate(async () => {
      throw new Error('database unavailable');
    });
    try {
      await audit(EVENT);
    } finally {
      restore();
    }
    assert.deepEqual(logged.mock.calls.map((c) => c.arguments[0]), ['audit.write_failed']);
  });
});

describe('exceptionsService.raise', () => {
  it('in a transaction: the exception and its audit row both go through it, and an audit failure fails the raise', async () => {
    const tx = {
      exception: { create: mock.fn(async () => ({ id: 'exc-1', type: 'product_not_found', status: 'open' })) },
      auditLog: { create: mock.fn(async () => Promise.reject(new Error('audit insert failed'))) },
    };
    await assert.rejects(exceptionsService.raise({ type: 'product_not_found', description: 'not in the catalogue', orderId: 'order-1' }, { type: 'ai', id: null }, tx as never), /audit insert failed/);
    assert.deepEqual([tx.exception.create.mock.callCount(), tx.auditLog.create.mock.callCount()], [1, 1]);
  });

  it('outside a transaction: an audit failure is logged and the exception is still returned', async () => {
    const created = { id: 'exc-2', type: 'inventory_api_error', status: 'open' };
    const exceptionDelegate = prisma.exception as unknown as { create: (args: unknown) => Promise<unknown> };
    const originalCreate = exceptionDelegate.create;
    exceptionDelegate.create = async () => created;
    const restore = replaceAuditCreate(async () => {
      throw new Error('database unavailable');
    });
    const logged = mock.method(logger, 'error', () => undefined);
    try {
      const exception = await exceptionsService.raise({ type: 'inventory_api_error', description: 'provider down' }, { type: 'system', id: null });
      assert.equal(exception.id, 'exc-2');
    } finally {
      exceptionDelegate.create = originalCreate;
      restore();
    }
    assert.deepEqual(logged.mock.calls.map((c) => c.arguments[0]), ['audit.write_failed']);
  });
});
