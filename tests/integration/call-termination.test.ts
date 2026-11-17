// Ending a call from several processes at once, against the real database. Each "process" here has its own
// PrismaClient (its own connection pool), its own store and orchestrator, and its own in-memory session for the
// call; nothing is shared between them except PostgreSQL, as with the API server and the LiveKit voice worker.
// callsService's in-process de-duplication is deliberately not used: only the database coordinates these ends.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import type { ConversationState, OrderStatus } from '../../src/generated/prisma/enums.ts';
import { createScriptedAiProvider } from '../../src/integrations/ai/mock.adapter.ts';
import { serviceToolBackend } from '../../src/modules/ai/ai.backend.ts';
import { getOrchestrator } from '../../src/modules/ai/ai.service.ts';
import { AI_ACTOR, type ConversationSession, type SessionStore } from '../../src/modules/ai/ai.types.ts';
import { createOrchestrator, type SessionEndReason } from '../../src/modules/ai/conversation.service.ts';
import { callsService } from '../../src/modules/calls/calls.service.ts';
import { createCallsSessionStore } from '../../src/modules/calls/calls.store.ts';
import { sessionRegistry } from '../../src/modules/calls/session.registry.ts';
import { ordersService } from '../../src/modules/orders/orders.service.ts';
import { reservationsService } from '../../src/modules/orders/reservations.service.ts';
import { createCustomer, createProduct, db, dbAvailable, disconnectDb, reservedQuantity, resetDb, skipReason } from './setup.ts';

const NO_META = { ip: undefined, requestId: undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Holds `client`'s next transaction open once its work is done, before it commits, so the row locks it took stay held
 * until `release()`. `reached` resolves when the work is done. PrismaClient is a proxy that takes plain assignment
 * (node:test's mock.method cannot see its methods).
 */
function holdNextTransaction(client: PrismaClient) {
  const target = client as unknown as { $transaction: (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown> };
  const original = target.$transaction;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let markReached!: () => void;
  const reached = new Promise<void>((r) => (markReached = r));
  target.$transaction = (fn, opts) => {
    target.$transaction = original;
    return original.call(client, async (tx: unknown) => {
      const result = await fn(tx);
      markReached();
      await released;
      return result;
    }, opts);
  };
  return { reached, release };
}

/** A second, independent client on the verified test database (setup.ts's gate: DATABASE_URL is that database). */
function independentClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']!, connectionTimeoutMillis: 30_000 }),
    log: ['error'],
    // maxWait includes opening a connection: a pool whose idle connection was closed reconnects to Neon first,
    // which can take over 10 s on a slow network.
    transactionOptions: { maxWait: 60_000, timeout: 60_000 },
  });
}

type Process = ReturnType<typeof processOn>;

function processOn(client: PrismaClient, store: SessionStore = createCallsSessionStore(client)) {
  const orchestrator = createOrchestrator({ ai: createScriptedAiProvider(), backend: serviceToolBackend, store, defaultLanguage: 'en' });
  return {
    store,
    /** This process's own view of the call, possibly stale (it may never have seen the latest state). */
    session(call: { id: string; providerCallSid: string; fromNumber: string }, state: ConversationState): ConversationSession {
      const session = orchestrator.createSession({ callId: call.id, provider: 'mock', providerCallSid: call.providerCallSid, fromNumber: call.fromNumber });
      session.state = state;
      return session;
    },
    end: (session: ConversationSession, reason: SessionEndReason) => orchestrator.endSession(session, reason),
  };
}

describe('call termination across processes (database-coordinated)', { skip: dbAvailable ? false : skipReason }, () => {
  let clientA: PrismaClient; // the test process's own client, as the API server's
  let clientB: PrismaClient;
  let clientC: PrismaClient;
  let A: Process;
  let B: Process;
  let C: Process;

  before(async () => {
    clientA = (await db()) as unknown as PrismaClient;
    clientB = independentClient();
    clientC = independentClient();
    A = processOn(clientA);
    B = processOn(clientB);
    C = processOn(clientC);
  });
  after(async () => {
    try {
      await Promise.all([clientB?.$disconnect(), clientC?.$disconnect()]);
    } finally {
      await disconnectDb();
    }
  });
  beforeEach(() => resetDb());

  /** A call in progress for 65 s with two transcript lines and, optionally, an order taken on it. */
  async function openCall(state: ConversationState, orderStatus?: OrderStatus) {
    const customer = await createCustomer();
    const call = await clientA.call.create({
      data: { provider: 'mock', providerCallSid: `term-${randomUUID()}`, fromNumber: customer.phonePrimary, toNumber: '+914842000000', customerId: customer.id, status: 'in_progress', startedAt: new Date(Date.now() - 65_000), conversationState: state },
    });
    await clientA.transcript.createMany({
      data: [
        { callId: call.id, sequence: 1, speaker: 'agent', text: 'Hello, what would you like to order?' },
        { callId: call.id, sequence: 2, speaker: 'customer', text: 'Dolo 650 twenty strips' },
      ],
    });
    const order = orderStatus
      ? await clientA.order.create({ data: { orderNumber: `PO-TERM-${randomUUID().slice(0, 8)}`, callId: call.id, customerId: customer.id, status: orderStatus, createdBy: 'ai' } })
      : null;
    return { call, customer, order };
  }

  /** What the database holds for the call, read through a third client. */
  async function committed(callId: string) {
    const call = await clientC.call.findUniqueOrThrow({ where: { id: callId } });
    const endEvents = await clientC.callEvent.findMany({ where: { callId, type: 'session_ended' } });
    const exceptions = await clientC.exception.findMany({ where: { callId } });
    // every exception.raise audit row, so one left behind by a rolled-back end would show
    const raiseAudits = await clientC.auditLog.count({ where: { action: 'exception.raise' } });
    const transcript = (await clientC.transcript.findMany({ where: { callId }, orderBy: { sequence: 'asc' } })).map((t) => [t.speaker, t.text]);
    return { call, endEvents, exceptions, raiseAudits, transcript };
  }
  const TRANSCRIPT = [
    ['agent', 'Hello, what would you like to order?'],
    ['customer', 'Dolo 650 twenty strips'],
  ];

  it('three processes end the same live call at once: one end commits, every caller gets its state, nothing is written twice', async () => {
    const { call } = await openCall('collecting_items');
    const sessions = [A, B, C].map((p) => p.session(call, 'collecting_items'));
    const reasons: SessionEndReason[] = ['caller_hangup', 'operator', 'idle_timeout'];
    const states = await Promise.all([A, B, C].map((p, i) => p.end(sessions[i]!, reasons[i]!)));
    assert.deepEqual(states, ['completed', 'completed', 'completed']);
    assert.deepEqual(sessions.map((s) => s.state), ['completed', 'completed', 'completed'], 'each session reconciled to the committed state');

    const first = await committed(call.id);
    assert.equal(first.call.conversationState, 'completed');
    assert.equal(first.call.status, 'completed');
    assert.ok(first.call.endedAt);
    assert.ok(first.call.durationSeconds! >= 64 && first.call.durationSeconds! <= 120, `duration ${first.call.durationSeconds}`);
    assert.equal(first.endEvents.length, 1, 'one session_ended event');
    const winner = (first.endEvents[0]!.data as { reason: string }).reason;
    assert.ok(reasons.includes(winner as SessionEndReason));
    assert.match(first.call.aiSummary ?? '', new RegExp(`ended: ${winner}`), 'the summary is the winning end\'s');
    assert.deepEqual(first.exceptions, []);
    assert.deepEqual(first.transcript, TRANSCRIPT);

    // Repeated ends, from every process and with every reason, return the committed state and write nothing.
    for (const [p, reason] of [[B, 'provider_error'], [A, 'caller_hangup'], [C, 'operator'], [B, 'idle_timeout']] as const) {
      assert.equal(await p.end(p.session(call, 'collecting_items'), reason), 'completed');
    }
    const again = await committed(call.id);
    assert.deepEqual(
      [again.call.endedAt, again.call.durationSeconds, again.call.aiSummary, again.call.status, again.call.conversationState, again.call.updatedAt],
      [first.call.endedAt, first.call.durationSeconds, first.call.aiSummary, first.call.status, first.call.conversationState, first.call.updatedAt],
      'not one field rewritten (updated_at unchanged)',
    );
    assert.equal(again.endEvents.length, 1);
    assert.deepEqual(again.transcript, TRANSCRIPT);
  });

  it('a draft left on the call raises exactly one exception, with one audit row, however many ends race', async () => {
    const { call, order } = await openCall('building_order', 'draft');
    const states = await Promise.all([A, B, C].map((p, i) => p.end(p.session(call, 'building_order'), (['caller_hangup', 'provider_error', 'operator'] as const)[i]!)));
    assert.deepEqual(states, ['failed', 'failed', 'failed']);
    await B.end(B.session(call, 'building_order'), 'caller_hangup');
    await A.end(A.session(call, 'building_order'), 'idle_timeout');

    const after = await committed(call.id);
    assert.equal(after.call.conversationState, 'failed');
    assert.equal(after.call.status, 'completed');
    assert.equal(after.exceptions.length, 1, 'exactly one exception');
    assert.deepEqual([after.exceptions[0]!.type, after.exceptions[0]!.orderId], ['call_dropped_with_draft', order!.id]);
    assert.equal(after.raiseAudits, 1, 'exactly one audit row for it');
    assert.equal(after.endEvents.length, 1);
    assert.deepEqual(after.transcript, TRANSCRIPT);
  });

  it('an end waits while another process holds the call, then returns what that process committed', async () => {
    const { call } = await openCall('collecting_items');
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));
    // Process B is mid-end: it holds the row lock its end takes, and then commits a failed end of its own.
    const holder = clientB.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM calls WHERE id = ${call.id}::uuid FOR NO KEY UPDATE`;
      markLocked();
      await released;
      await tx.call.update({ where: { id: call.id }, data: { conversationState: 'failed', status: 'failed', endedAt: new Date(), durationSeconds: 7, aiSummary: 'ended by process B' } });
    });
    await locked;

    const sessionA = A.session(call, 'collecting_items');
    let settled = false;
    const ending = A.end(sessionA, 'caller_hangup').finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(settled, false, 'blocked on the database while B holds the call');
    release();
    await holder;
    assert.equal(await ending, 'failed', 'B\'s committed end, not a completed one of A\'s own');
    assert.equal(sessionA.state, 'failed', 'A\'s session reconciled to it');

    const after = await committed(call.id);
    assert.deepEqual([after.call.conversationState, after.call.status, after.call.durationSeconds, after.call.aiSummary], ['failed', 'failed', 7, 'ended by process B']);
    assert.equal(after.endEvents.length, 0, 'A wrote nothing');
  });

  it('termination triggers in either order: a conversation that completed stays completed', async () => {
    for (const order of [['provider_error', 'caller_hangup', 'operator'], ['caller_hangup', 'operator', 'provider_error']] as const) {
      // The customer confirmed the order before hanging up: the conversation is completed, the call still open.
      const { call } = await openCall('completed', 'customer_confirmed');
      const processes = [B, A, C];
      for (let i = 0; i < order.length; i++) {
        // stale views: these processes last saw the call mid-conversation
        const session = processes[i]!.session(call, 'waiting_customer_confirmation');
        assert.equal(await processes[i]!.end(session, order[i]!), 'completed', `${order.join(' → ')}: end ${i + 1}`);
        assert.equal(session.state, 'completed');
      }
      const after = await committed(call.id);
      assert.deepEqual([after.call.conversationState, after.call.status], ['completed', 'completed'], `${order.join(' → ')}: never failed`);
      assert.ok(after.call.endedAt);
      assert.deepEqual(after.exceptions, [], 'a confirmed order raises nothing');
      assert.deepEqual(after.transcript, TRANSCRIPT);
    }

    // A live call: the first trigger decides, and a later one cannot change it.
    const { call: live } = await openCall('collecting_items');
    assert.equal(await B.end(B.session(live, 'collecting_items'), 'provider_error'), 'failed');
    assert.equal(await A.end(A.session(live, 'collecting_items'), 'caller_hangup'), 'failed');
    const after = await committed(live.id);
    assert.deepEqual([after.call.conversationState, after.call.status, after.endEvents.length], ['failed', 'failed', 1]);
  });

  it('stale updates cannot take an ended or finished call back to an earlier state', async () => {
    const stale = { conversationState: 'collecting_items', status: 'in_progress', language: 'hi', handoverReason: 'stale' } as const;

    // Ended by A; B, still mid-turn, writes its old view.
    const { call: ended } = await openCall('collecting_items');
    await A.end(A.session(ended, 'collecting_items'), 'caller_hangup');
    const before = await committed(ended.id);
    await B.store.updateCall(ended.id, stale);
    const afterEnded = await committed(ended.id);
    assert.deepEqual(afterEnded.call, before.call, 'the ended call is untouched (updated_at too)');

    // Completed but not yet ended (the order was confirmed): no going back either.
    const { call: done } = await openCall('completed', 'customer_confirmed');
    await B.store.updateCall(done.id, stale);
    assert.equal((await committed(done.id)).call.conversationState, 'completed');

    // A stale update racing an end: whichever commits first, the call ends completed.
    const { call: racing } = await openCall('collecting_items');
    const [, state] = await Promise.all([B.store.updateCall(racing.id, { conversationState: 'reading_back' }), A.end(A.session(racing, 'collecting_items'), 'caller_hangup')]);
    assert.equal(state, 'completed');
    const afterRace = await committed(racing.id);
    assert.deepEqual([afterRace.call.conversationState, afterRace.call.status, afterRace.endEvents.length], ['completed', 'completed', 1]);
    await B.store.updateCall(racing.id, stale);
    assert.equal((await committed(racing.id)).call.conversationState, 'completed');
  });

  it('a failed end rolls back completely and can be retried: the end and its side effects happen once', async () => {
    const { call } = await openCall('building_order', 'draft');
    // B's end fails inside its transaction, after the lock and the decision: the exception insert breaks a foreign key.
    const failingStore: SessionStore = {
      ...B.store,
      endCall: (callId, endedAt, decide) =>
        B.store.endCall(callId, endedAt, (snapshot) => {
          const end = decide(snapshot);
          return { ...end, exception: { ...end.exception!, customerId: randomUUID() } };
        }),
    };
    const failing = processOn(clientB, failingStore);
    const session = failing.session(call, 'building_order');
    await assert.rejects(failing.end(session, 'caller_hangup'), /foreign key|Foreign key|P2003/i);
    assert.equal(session.state, 'building_order', 'the session is unchanged by the failed end');

    const rolledBack = await committed(call.id);
    assert.deepEqual([rolledBack.call.conversationState, rolledBack.call.status, rolledBack.call.endedAt, rolledBack.call.aiSummary], ['building_order', 'in_progress', null, null]);
    assert.deepEqual([rolledBack.endEvents.length, rolledBack.exceptions.length, rolledBack.raiseAudits], [0, 0, 0], 'nothing of the failed end remains');

    // The retry (here from the same process, with its same session) ends the call, once.
    assert.equal(await B.end(session, 'caller_hangup'), 'failed');
    assert.equal(await A.end(A.session(call, 'building_order'), 'operator'), 'failed');
    const retried = await committed(call.id);
    assert.equal(retried.call.conversationState, 'failed');
    assert.ok(retried.call.endedAt);
    assert.match(retried.call.aiSummary ?? '', /ended: caller_hangup/);
    assert.deepEqual([retried.endEvents.length, retried.exceptions.length, retried.raiseAudits], [1, 1, 1]);
    assert.deepEqual(retried.transcript, TRANSCRIPT);
  });

  // --- order confirmation against call termination (orders.service.ts confirm locks the call row) ---

  /** A live call whose order has been read back and awaits the customer's answer. Orders go through this process's client. */
  async function readBackCall() {
    const { call, customer } = await openCall('waiting_customer_confirmation');
    const sku = `SKU-${randomUUID().slice(0, 8)}`;
    const product = await createProduct(sku, 100);
    const order = await ordersService.create({ customerId: customer.id, callId: call.id, items: [{ productId: product.id, requestedText: 'Dolo 650', quantity: 2 }] }, AI_ACTOR, NO_META);
    const { revision } = await ordersService.readback(order.id, AI_ACTOR, NO_META);
    return { call, order, revision, sku };
  }
  const confirmByAi = (orderId: string, revision: number) =>
    ordersService.confirm(orderId, { revision, source: 'phone_ai', declinedItemIds: [], idempotencyKey: `confirm:${orderId}:${revision}` }, AI_ACTOR, NO_META);
  const orderState = async (orderId: string) => {
    const order = await clientC.order.findUniqueOrThrow({ where: { id: orderId }, include: { confirmations: true, reservations: true } });
    return { status: order.status, confirmations: order.confirmations.map((c) => c.status), reservations: order.reservations.length };
  };

  it('an end that commits first refuses the confirmation (409 CALL_ENDED): the order stays unconfirmed and no stock is reserved', async () => {
    const { call, order, revision, sku } = await readBackCall();
    const held = holdNextTransaction(clientB);
    const ending = B.end(B.session(call, 'waiting_customer_confirmation'), 'caller_hangup');
    await held.reached; // B's end is written and holds the call row, not yet committed

    let settled = false;
    const confirming = confirmByAi(order.id, revision).finally(() => (settled = true));
    confirming.catch(() => undefined); // asserted below
    await sleep(1500);
    assert.equal(settled, false, 'the confirmation waits on the call row while the end holds it');
    held.release();
    assert.equal(await ending, 'failed');
    await assert.rejects(confirming, { status: 409, code: 'CALL_ENDED' });

    assert.deepEqual(await orderState(order.id), { status: 'pending_customer_confirmation', confirmations: ['pending'], reservations: 0 });
    const after = await committed(call.id);
    assert.deepEqual([after.call.conversationState, after.endEvents.length], ['failed', 1]);
    assert.deepEqual(after.exceptions.map((e) => e.type), ['customer_unconfirmed'], 'the end classified the order as unconfirmed, as it is');

    // The AI's next step after confirming, reserving stock, cannot go ahead either: the order was never confirmed.
    await assert.rejects(reservationsService.reserve(order.id, `call:${call.id}:reserve:${revision}`, AI_ACTOR), { code: 'CUSTOMER_UNCONFIRMED' });
    assert.equal((await orderState(order.id)).reservations, 0);
    assert.equal(await reservedQuantity(sku), 0);
  });

  it('a confirmation that commits first is what the end reads: the call completes with no exception, and the reservation goes ahead', async () => {
    const { call, order, revision, sku } = await readBackCall();
    const held = holdNextTransaction(clientA);
    const confirming = confirmByAi(order.id, revision);
    await held.reached; // the confirmation is written and holds the call row, not yet committed

    let settled = false;
    const ending = B.end(B.session(call, 'waiting_customer_confirmation'), 'provider_error').finally(() => (settled = true));
    await sleep(1500);
    assert.equal(settled, false, 'the end waits on the call row while the confirmation holds it');
    held.release();
    assert.equal((await confirming).status, 'customer_confirmed');
    assert.equal(await ending, 'completed', 'a confirmed order completes the conversation, even when a provider error ended the call');

    const after = await committed(call.id);
    assert.deepEqual([after.call.conversationState, after.call.status, after.endEvents.length], ['completed', 'completed', 1]);
    assert.deepEqual(after.exceptions, [], 'not classified as an unconfirmed draft');
    assert.deepEqual(await orderState(order.id), { status: 'customer_confirmed', confirmations: ['confirmed'], reservations: 0 });

    // The confirmation won, so the order is the customer's: reserving its stock is allowed after the call ended.
    const reserved = await reservationsService.reserve(order.id, `call:${call.id}:reserve:${revision}`, AI_ACTOR);
    assert.equal(reserved.outcome, 'reserved');
    assert.equal(await reservedQuantity(sku), 2);
  });

  it('confirmations racing ends from another client: each pair settles on one consistent outcome, with no deadlock', async () => {
    const winners: string[] = [];
    // Staggered starts (negative: the end starts later; positive: the confirmation does), so that over the rounds
    // each side gets to take the call row first against a remote database's latency.
    const delays = [-1500, -700, -250, 0, 250, 700];
    for (let i = 0; i < delays.length; i++) {
      const { call, order, revision } = await readBackCall();
      await Promise.all([clientA.$queryRaw`SELECT 1`, clientC.$queryRaw`SELECT 1`]); // connections ready, not reconnects
      const ending = sleep(Math.max(0, -delays[i]!)).then(() => C.end(C.session(call, 'waiting_customer_confirmation'), 'caller_hangup'));
      const confirming = sleep(Math.max(0, delays[i]!)).then(() => confirmByAi(order.id, revision));
      const [confirmed, ended] = await Promise.allSettled([confirming, ending]);
      assert.equal(ended.status, 'fulfilled', `round ${i}: the end never fails (${ended.status === 'rejected' ? String(ended.reason) : ''})`);
      const after = await committed(call.id);
      const state = await orderState(order.id);
      assert.equal(after.endEvents.length, 1, `round ${i}: one end`);
      if (confirmed.status === 'fulfilled') {
        winners.push('confirmation');
        assert.equal(ended.value, 'completed', `round ${i}`);
        assert.equal(state.status, 'customer_confirmed', `round ${i}`);
        assert.deepEqual(after.exceptions, [], `round ${i}`);
      } else {
        winners.push('end');
        assert.equal((confirmed.reason as { code?: string }).code, 'CALL_ENDED', `round ${i}: ${String(confirmed.reason)}`);
        assert.equal(ended.value, 'failed', `round ${i}`);
        assert.equal(state.status, 'pending_customer_confirmation', `round ${i}`);
        assert.deepEqual(after.exceptions.map((e) => e.type), ['customer_unconfirmed'], `round ${i}`);
      }
    }
    // Which side wins depends on timing; both outcomes are checked above whenever they occur.
    process.stdout.write(`# race winners: ${winners.join(', ')}\n`);
  });

  // --- recovering calls nobody is ending (calls.service.ts closeAbandonedCalls and closeIdleSessions) ---

  /** A call whose last state change and transcript lines are at `lastSeen`; optionally a transcript line now. */
  async function quietCall(lastSeen: Date, opts: { order?: OrderStatus; talkingNow?: boolean } = {}) {
    const { call } = await openCall('collecting_items', opts.order);
    await clientA.call.update({ where: { id: call.id }, data: { startedAt: lastSeen, lastActivityAt: lastSeen } });
    await clientA.transcript.updateMany({ where: { callId: call.id }, data: { createdAt: lastSeen } });
    if (opts.talkingNow) await clientA.transcript.create({ data: { callId: call.id, sequence: 3, speaker: 'customer', text: 'Still there?' } });
    return call;
  }

  it('the database sweep ends calls no process is driving; one failed end does not stop it, is retried, and ends once', async () => {
    const HOUR = 3_600_000;
    const lastSeen = new Date(Date.now() - 3 * HOUR);
    const failing = await quietCall(lastSeen, { order: 'draft' });
    const abandoned = await quietCall(lastSeen);
    const talking = await quietCall(lastSeen, { talkingNow: true });
    const { call: live } = await openCall('collecting_items');
    const ended = await quietCall(lastSeen);
    await A.end(A.session(ended, 'collecting_items'), 'caller_hangup');
    const endedBefore = await committed(ended.id);

    const orchestrator = getOrchestrator();
    const endSession = orchestrator.endSession;
    let failed = 0;
    orchestrator.endSession = (session, reason, meta) => {
      if (session.callId === failing.id && failed++ === 0) return Promise.reject(new Error('connection lost'));
      return endSession(session, reason, meta);
    };
    try {
      assert.equal(await callsService.closeAbandonedCalls(2 * HOUR), 1, 'the other abandoned call ended despite the failure');
      assert.ok((await committed(abandoned.id)).call.endedAt);
      const afterFailure = await committed(failing.id);
      assert.deepEqual([afterFailure.call.endedAt, afterFailure.endEvents.length, afterFailure.exceptions.length], [null, 0, 0], 'the failed end left nothing');
      assert.ok(sessionRegistry.get(failing.id), 'the failed call keeps a session here, so it stays due for retry');
      for (const untouched of [talking, live]) assert.equal((await committed(untouched.id)).call.endedAt, null, 'recent activity: not abandoned');
      assert.deepEqual((await committed(ended.id)).call, endedBefore.call, 'an ended call is not touched');

      assert.equal(await callsService.closeAbandonedCalls(2 * HOUR), 0, 'a call with a session in this process is left to the idle sweep');
      sessionRegistry.get(failing.id)!.lastActivityAt = 0;
      assert.equal(await callsService.closeIdleSessions(60_000), 1, 'the idle sweep retries it');
      assert.equal(sessionRegistry.get(failing.id), undefined);

      const retried = await committed(failing.id);
      assert.ok(retried.call.endedAt);
      assert.deepEqual([retried.call.conversationState, retried.endEvents.length], ['failed', 1]);
      assert.deepEqual(retried.exceptions.map((e) => e.type), ['call_dropped_with_draft'], 'the side effects happened once');
      assert.equal((await committed(abandoned.id)).endEvents.length, 1);

      assert.equal(await callsService.closeAbandonedCalls(2 * HOUR), 0, 'nothing left to recover');
      assert.equal(await callsService.closeIdleSessions(60_000), 0);
      assert.equal(retried.raiseAudits, 1);
    } finally {
      orchestrator.endSession = endSession;
      for (const id of [failing.id, abandoned.id, talking.id, live.id, ended.id]) sessionRegistry.delete(id);
    }
  });
});
