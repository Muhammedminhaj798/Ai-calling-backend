// Audit rows written inside an operation's transaction commit or roll back with it (src/utils/audit.ts). Against the
// real database: a flagged order line, its staff exception and that exception's audit row are added together, and an
// audit insert that fails at the database rolls all three back, leaving the order as it was.
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { AI_ACTOR } from '../../src/modules/ai/ai.types.ts';
import { ordersService } from '../../src/modules/orders/orders.service.ts';
import { createCustomer, db, dbAvailable, disconnectDb, resetDb, skipReason } from './setup.ts';

const NO_META = { ip: undefined, requestId: undefined };
const FLAGGED = { requestedText: 'the blue cough syrup', quantity: 1, flagReason: 'product_not_found' as const };

type Tx = { auditLog: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } } & Record<string | symbol, unknown>;

describe('audit rows inside a transaction', { skip: dbAvailable ? false : skipReason }, () => {
  beforeEach(() => resetDb());
  after(() => disconnectDb());

  async function draftOrder() {
    const customer = await createCustomer();
    return ordersService.create({ customerId: customer.id, items: [] }, AI_ACTOR, NO_META);
  }

  async function rows(orderId: string) {
    const prisma = await db();
    return {
      lines: await prisma.orderItem.count({ where: { orderId } }),
      exceptions: await prisma.exception.count({ where: { orderId } }),
      raiseAudits: await prisma.auditLog.count({ where: { action: 'exception.raise' } }),
      revision: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).revision,
    };
  }

  /**
   * The next transaction on the process client writes its audit rows with an invalid `ip`, so the insert fails in
   * PostgreSQL itself (inet syntax) and aborts the transaction, as a real audit write failure would. PrismaClient is
   * a proxy that takes plain assignment.
   */
  async function failNextTransactionAudit(): Promise<void> {
    const client = (await db()) as unknown as { $transaction: (fn: (tx: Tx) => Promise<unknown>, opts?: unknown) => Promise<unknown> };
    const original = client.$transaction;
    client.$transaction = (fn, opts) => {
      client.$transaction = original;
      return original.call(client, (tx: Tx) => {
        const failing = new Proxy(tx, {
          get: (target, key) =>
            key === 'auditLog' ? { create: (args: { data: Record<string, unknown> }) => target.auditLog.create({ data: { ...args.data, ip: 'not-an-ip' } }) } : target[key],
        });
        return fn(failing);
      }, opts);
    };
  }

  it('a flagged line, its exception and the exception audit row commit together', async () => {
    const order = await draftOrder();
    await ordersService.addItem(order.id, FLAGGED, AI_ACTOR, NO_META);
    assert.deepEqual(await rows(order.id), { lines: 1, exceptions: 1, raiseAudits: 1, revision: order.revision + 1 });
  });

  it('an audit insert failing in the database rolls back the line and its exception; adding the line again works', async () => {
    const order = await draftOrder();
    const before = await rows(order.id);
    await failNextTransactionAudit();
    await assert.rejects(ordersService.addItem(order.id, FLAGGED, AI_ACTOR, NO_META), /inet|invalid input/i);
    assert.deepEqual(await rows(order.id), before, 'no line, no exception, no audit row, revision unchanged');

    await ordersService.addItem(order.id, FLAGGED, AI_ACTOR, NO_META);
    assert.deepEqual(await rows(order.id), { lines: 1, exceptions: 1, raiseAudits: 1, revision: order.revision + 1 });
  });
});
