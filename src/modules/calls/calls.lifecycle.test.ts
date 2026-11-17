// Call lifecycle: the end time and duration (first end wins), how an end is decided from the committed call, the
// guard that keeps live updates off ended or finished calls, and test-call identification. No database: ending
// through the real store (row lock, one transaction, two clients) is covered by
// tests/integration/call-termination.test.ts.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createScriptedAiProvider } from '../../integrations/ai/mock.adapter.ts';
import { logger } from '../../utils/logger.ts';
import { getOrchestrator } from '../ai/ai.service.ts';
import type { CallEndSnapshot } from '../ai/ai.types.ts';
import { createOrchestrator, decideCallEnd } from '../ai/conversation.service.ts';
import { createFakeBackend, createFakeStore } from '../../../tests/fakes/ai-backend.ts';
import { callClosing, callsRepository } from './calls.repository.ts';
import { callsService, isTestCall } from './calls.service.ts';
import { createCallsSessionStore } from './calls.store.ts';
import { sessionRegistry } from './session.registry.ts';

const STARTED = new Date('2026-11-14T10:00:00.000Z');
const at = (seconds: number) => new Date(STARTED.getTime() + seconds * 1000);

afterEach(() => mock.restoreAll());

describe('callClosing', () => {
  it('is startedAt → endedAt in whole seconds', () => {
    assert.deepEqual(callClosing({ startedAt: STARTED, endedAt: null, durationSeconds: null }, at(95.4)), { endedAt: at(95.4), durationSeconds: 95 });
  });
  it('is never negative (clock skew between processes)', () => {
    assert.equal(callClosing({ startedAt: STARTED, endedAt: null, durationSeconds: null }, at(-3))?.durationSeconds, 0);
  });
  it("keeps a duration already recorded (the telephony provider's figure)", () => {
    assert.equal(callClosing({ startedAt: STARTED, endedAt: null, durationSeconds: 120 }, at(95))?.durationSeconds, 120);
  });
  it('is null once the call has ended', () => {
    assert.equal(callClosing({ startedAt: STARTED, endedAt: at(60), durationSeconds: 60 }, at(95)), null);
  });
});

describe('decideCallEnd: how an end closes the call, from the committed call', () => {
  const orchestrator = createOrchestrator({ ai: createScriptedAiProvider(), backend: createFakeBackend(), store: createFakeStore(), defaultLanguage: 'en' });
  const session = orchestrator.createSession({ callId: 'call-1', provider: 'mock', providerCallSid: 'mock-1', fromNumber: '+919847012345' });
  const snapshot = (conversationState: CallEndSnapshot['conversationState'], order: CallEndSnapshot['order'] = null): CallEndSnapshot => ({ conversationState, order });
  const draft = (status: 'draft' | 'pending_customer_confirmation' | 'customer_confirmed') => ({ id: 'order-1', orderNumber: 'PO-1', status, customerId: 'cust-1', lines: 3 });

  it('a live conversation completes: summary and session_ended event, no exception', () => {
    const end = decideCallEnd(snapshot('collecting_items'), session, 'caller_hangup');
    assert.deepEqual([end.conversationState, end.status, end.exception], ['completed', 'completed', undefined]);
    assert.deepEqual(end.event, { fromState: 'collecting_items', toState: 'completed', data: { reason: 'caller_hangup' } });
    assert.match(end.aiSummary!, /ended: caller_hangup/);
  });

  it('a finished conversation keeps its state and writes no summary or event (nothing to overwrite)', () => {
    assert.deepEqual(decideCallEnd(snapshot('completed', draft('customer_confirmed')), session, 'provider_error'), { conversationState: 'completed', status: 'completed' });
    assert.deepEqual(decideCallEnd(snapshot('failed'), session, 'caller_hangup'), { conversationState: 'failed', status: 'failed' });
  });

  it('handover: the conversation completes and the call stays handed_over', () => {
    const end = decideCallEnd(snapshot('handover_required'), session, 'provider_error');
    assert.deepEqual([end.conversationState, end.status], ['completed', 'handed_over']);
  });

  it('an unconfirmed order fails the conversation and raises one exception: incomplete draft or read back', () => {
    const dropped = decideCallEnd(snapshot('collecting_items', draft('draft')), session, 'caller_hangup');
    assert.deepEqual([dropped.conversationState, dropped.status, dropped.exception?.type], ['failed', 'completed', 'call_dropped_with_draft']);
    assert.deepEqual([dropped.exception?.orderId, dropped.exception?.customerId, dropped.exception?.callId], ['order-1', 'cust-1', 'call-1']);
    assert.match(dropped.exception!.description, /PO-1 incomplete; 3 line\(s\) captured/);
    const unconfirmed = decideCallEnd(snapshot('waiting_customer_confirmation', draft('pending_customer_confirmation')), session, 'idle_timeout');
    assert.equal(unconfirmed.exception?.type, 'customer_unconfirmed');
  });

  it('a confirmed order raises nothing; a provider error fails the call', () => {
    assert.equal(decideCallEnd(snapshot('collecting_items', draft('customer_confirmed')), session, 'caller_hangup').exception, undefined);
    const failed = decideCallEnd(snapshot('collecting_items'), session, 'provider_error');
    assert.deepEqual([failed.conversationState, failed.status], ['failed', 'failed']);
  });

  it('an order confirmed before the end (its conversation not yet marked completed) completes the call, whatever ended it', () => {
    for (const reason of ['provider_error', 'caller_hangup', 'idle_timeout'] as const) {
      const end = decideCallEnd(snapshot('waiting_customer_confirmation', draft('customer_confirmed')), session, reason);
      assert.deepEqual([end.conversationState, end.status, end.exception], ['completed', 'completed', undefined], reason);
      assert.deepEqual(end.event, { fromState: 'waiting_customer_confirmation', toState: 'completed', data: { reason } });
    }
    const reserved = decideCallEnd(snapshot('waiting_customer_confirmation', { ...draft('customer_confirmed'), status: 'pending_staff_approval' }), session, 'provider_error');
    assert.deepEqual([reserved.conversationState, reserved.status], ['completed', 'completed']);
    const cancelled = decideCallEnd(snapshot('collecting_items', { ...draft('draft'), status: 'cancelled' }), session, 'provider_error');
    assert.deepEqual([cancelled.conversationState, cancelled.status], ['failed', 'failed'], 'a cancelled order is not a confirmed one');
  });
});

describe('session store: updateCall', () => {
  it('is one conditional update that never touches an ended or finished call', async () => {
    const updateMany = mock.fn(async () => ({ count: 0 }));
    const store = createCallsSessionStore({ call: { updateMany } } as never);
    await store.updateCall('call-1', { conversationState: 'collecting_items', language: 'ml' });
    const [args] = updateMany.mock.calls[0]!.arguments as unknown as [{ where: unknown; data: Record<string, unknown> }];
    assert.deepEqual(args.where, { id: 'call-1', endedAt: null, conversationState: { notIn: ['completed', 'failed'] } });
    assert.deepEqual([args.data['conversationState'], args.data['language'], 'endedAt' in args.data, 'aiSummary' in args.data], ['collecting_items', 'ml', false, false]);
  });
});

describe('ending through the orchestrator (in-memory store)', () => {
  it('the session takes the committed state only after the end is written; a failed end can be retried', async () => {
    const store = createFakeStore();
    const orchestrator = createOrchestrator({ ai: createScriptedAiProvider(), backend: createFakeBackend(), store, defaultLanguage: 'en' });
    const session = orchestrator.createSession({ callId: 'call-1', provider: 'mock', providerCallSid: 'mock-1', fromNumber: '+919847012345' });
    await store.updateCall('call-1', { conversationState: 'collecting_items' });
    session.state = 'collecting_items';
    const endCall = store.endCall;
    store.endCall = async () => {
      throw new Error('connection lost');
    };
    await assert.rejects(orchestrator.endSession(session, 'caller_hangup'), /connection lost/);
    assert.equal(session.state, 'collecting_items', 'unchanged by the failed end');
    store.endCall = endCall;
    assert.equal(await orchestrator.endSession(session, 'caller_hangup'), 'completed');
    assert.equal(await orchestrator.endSession(session, 'provider_error'), 'completed', 'a later end returns the committed state');
    assert.equal(store.events.filter((e) => e.type === 'session_ended').length, 1);
  });
});

describe('sweeps: one failed end never stops a sweep and stays due for retry', () => {
  const sessionFor = (callId: string, idle: boolean) => {
    const session = getOrchestrator().createSession({ callId, provider: 'mock', providerCallSid: `sid-${callId}`, fromNumber: '+919847012345' });
    if (idle) session.lastActivityAt = 0;
    sessionRegistry.set(session);
    return session;
  };

  it('closeIdleSessions: ends the others, keeps the failed session registered, and the next sweep ends it', async () => {
    const orchestrator = getOrchestrator();
    const endSession = orchestrator.endSession;
    const attempts: string[] = [];
    orchestrator.endSession = async (session) => {
      attempts.push(session.callId);
      if (session.callId === 'idle-b' && attempts.filter((id) => id === 'idle-b').length === 1) throw new Error('connection lost');
      return 'completed';
    };
    const logged = mock.method(logger, 'error', () => undefined);
    const ids = ['idle-a', 'idle-b', 'idle-c', 'busy'];
    try {
      for (const id of ids) sessionFor(id, id !== 'busy');
      assert.equal(await callsService.closeIdleSessions(60_000), 2);
      assert.deepEqual(ids.map((id) => Boolean(sessionRegistry.get(id))), [false, true, false, true], 'only the failed and the busy session remain');
      assert.deepEqual(logged.mock.calls.map((c) => [c.arguments[0], (c.arguments[1] as { callId: string }).callId]), [['conversations.idle_close_failed', 'idle-b']]);

      assert.equal(await callsService.closeIdleSessions(60_000), 1, 'the retry');
      assert.deepEqual(ids.map((id) => Boolean(sessionRegistry.get(id))), [false, false, false, true]);
      assert.deepEqual(attempts, ['idle-a', 'idle-b', 'idle-c', 'idle-b'], 'each success ended once; the busy session never');
      assert.equal(await callsService.closeIdleSessions(60_000), 0);
    } finally {
      orchestrator.endSession = endSession;
      for (const id of ids) sessionRegistry.delete(id);
    }
  });

  it('closeAbandonedCalls: skips calls with a session in this process and keeps going past a failure', async () => {
    mock.method(callsRepository, 'findAbandoned', async () => ['gone-a', 'mine', 'gone-b', 'gone-c']);
    const ended = mock.method(callsService, 'endSession', async (callId: string) => {
      if (callId === 'gone-b') throw new Error('connection lost');
      return 'completed';
    });
    const logged = mock.method(logger, 'error', () => undefined);
    sessionFor('mine', false);
    try {
      assert.equal(await callsService.closeAbandonedCalls(3_600_000, new Date('2026-11-16T12:00:00Z')), 2);
      assert.deepEqual(ended.mock.calls.map((c) => c.arguments[0]), ['gone-a', 'gone-b', 'gone-c'], 'this process\'s own call is left to its idle sweep');
      assert.deepEqual(ended.mock.calls.map((c) => c.arguments[1]), ['idle_timeout', 'idle_timeout', 'idle_timeout']);
      assert.deepEqual(logged.mock.calls.map((c) => c.arguments[0]), ['conversations.abandoned_close_failed']);
      const [before] = (callsRepository.findAbandoned as unknown as { mock: { calls: Array<{ arguments: [Date] }> } }).mock.calls[0]!.arguments;
      assert.equal(before.toISOString(), '2026-11-16T11:00:00.000Z', 'nothing recorded for staleMs');
    } finally {
      sessionRegistry.delete('mine');
    }
  });
});

describe('test calls', () => {
  it('simulator, mock telephony and LiveKit browser calls are test calls; phone providers are not', () => {
    assert.deepEqual(['simulator', 'mock', 'livekit'].map(isTestCall), [true, true, true]);
    assert.deepEqual(['exotel', 'livekit_sip'].map(isTestCall), [false, false]);
  });

  it('the calls list and detail mark them with isTest', async () => {
    mock.method(callsRepository, 'list', async () => [[{ id: 'a', provider: 'livekit' }, { id: 'b', provider: 'exotel' }], 2] as never);
    mock.method(callsRepository, 'findById', async () => ({ id: 'c', provider: 'simulator' }) as never);
    const page = await callsService.list({ page: 1, pageSize: 50 } as never);
    assert.deepEqual(page.data.map((c) => [c.id, c.isTest]), [['a', true], ['b', false]]);
    assert.equal((await callsService.detail('c')).isTest, true);
  });
});
