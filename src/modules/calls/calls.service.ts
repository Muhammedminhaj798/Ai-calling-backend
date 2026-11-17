// Conversation session manager: creates the call row and in-memory session for an incoming call (or a
// text simulation), routes utterances to the orchestrator, resumes sessions from the database, ends them,
// and serves the dashboard's call views.
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { ConversationState } from '../../generated/prisma/enums.ts';
import { AppError } from '../../middleware/error-handler.ts';
import type { RequestMeta } from '../../utils/audit.ts';
import type { Lang } from '../../utils/language.ts';
import { logger } from '../../utils/logger.ts';
import { pageResult, parseSort, skipTake, type Page } from '../../utils/pagination.ts';
import { serviceToolBackend } from '../ai/ai.backend.ts';
import { getOrchestrator } from '../ai/ai.service.ts';
import type { ConversationSession, TurnResult } from '../ai/ai.types.ts';
import { isTerminalConversation } from '../ai/conversation.state.ts';
import type { SessionEndReason } from '../ai/conversation.service.ts';
import { LIVEKIT_PROVIDER } from '../voice/voice.validation.ts';
import { callsRepository as repo, type CallDetailRecord } from './calls.repository.ts';
import { sessionRegistry } from './session.registry.ts';
import type { ListCallsQuery } from './calls.validation.ts';

export interface StartSessionInput {
  provider: string;
  providerCallSid: string;
  fromNumber: string;
  toNumber: string;
  language?: Lang;
}

export interface StartedSession {
  callId: string;
  session: ConversationSession;
  greeting: TurnResult;
  resumed: boolean;
}

const SORTABLE = ['startedAt', 'status', 'conversationState'] as const;

/**
 * Call sources that are never a customer's phone call, persisted in calls.provider: the text simulator, the mock
 * telephony protocol and LiveKit browser test calls. A future LiveKit SIP phone call must use its own provider value
 * (e.g. 'livekit_sip'), never 'livekit'. Mirrored by isTestCall in frontend/lib/format.ts.
 */
export const TEST_CALL_PROVIDERS: readonly string[] = ['simulator', 'mock', LIVEKIT_PROVIDER];
export const isTestCall = (provider: string): boolean => TEST_CALL_PROVIDERS.includes(provider);

/**
 * Ends in progress in this process, by call id. A hang-up and the media socket closing (or an operator end) often
 * arrive together; the later caller shares the end already running instead of queueing a second transaction behind
 * it. Only an economy: ends from any process are made safe by the database (calls.store.ts endCall).
 */
const ending = new Map<string, Promise<ConversationState>>();

/** A sweep's end of one call: true once ended, false (logged) when it failed, so one failure never stops a sweep. */
async function endLogged(callId: string, event: string): Promise<boolean> {
  try {
    await callsService.endSession(callId, 'idle_timeout');
    return true;
  } catch (err) {
    logger.error(event, { callId, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function loadCall(id: string): Promise<CallDetailRecord> {
  const call = await repo.findById(id);
  if (!call) throw new AppError(404, 'NOT_FOUND', 'Call not found');
  return call;
}

/** Rebuilds the in-memory session from the database after a restart: state, customer, order, recent transcript. */
async function resumeSession(call: CallDetailRecord): Promise<ConversationSession> {
  const orchestrator = getOrchestrator();
  const session = orchestrator.createSession({ callId: call.id, provider: call.provider, providerCallSid: call.providerCallSid, fromNumber: call.fromNumber, language: call.language ?? undefined });
  session.state = call.conversationState;
  session.customer = call.customerId ? await serviceToolBackend.findCustomerByPhone(call.customer?.phonePrimary ?? '') : null;
  session.order = await serviceToolBackend.findOrderByCall(call.id);
  session.orderId = session.order?.id ?? null;
  session.deliveryAddressId = call.order?.deliveryAddressId ?? null;
  session.handover = call.handoverReason ? { reason: call.handoverReason, exceptionId: null } : null;
  for (const t of await repo.transcripts(call.id)) {
    if (t.speaker === 'customer') session.messages.push({ role: 'user', content: t.text });
    else if (t.speaker === 'agent') session.messages.push({ role: 'assistant', content: t.text });
    if (t.speaker === 'customer') session.lastCustomerUtterance = t.text;
  }
  session.turns = session.messages.filter((m) => m.role === 'user').length;
  await repo.addEvent({ callId: call.id, type: 'session_resumed', data: { state: session.state, messages: session.messages.length } });
  sessionRegistry.set(session);
  return session;
}

export const callsService = {
  /** Creates (or resumes, for a repeated provider call id) the session and returns the greeting to play. */
  async startSession(input: StartSessionInput, meta?: RequestMeta): Promise<StartedSession> {
    const existing = await repo.findByProviderSid(input.providerCallSid);
    if (existing) {
      const session = sessionRegistry.get(existing.id) ?? (await resumeSession(existing));
      const reply = session.messages.filter((m) => m.role === 'assistant' && m.content).at(-1)?.content ?? '';
      return { callId: existing.id, session, greeting: { reply: reply ?? '', language: session.language, state: session.state, toolCalls: [], ended: isTerminalConversation(session.state) }, resumed: true };
    }
    const now = new Date();
    const call = await repo.create({
      provider: input.provider,
      providerCallSid: input.providerCallSid,
      direction: 'inbound',
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      status: 'in_progress',
      language: input.language ?? null,
      startedAt: now,
      answeredAt: now,
      lastActivityAt: now,
    });
    const orchestrator = getOrchestrator();
    const session = orchestrator.createSession({ callId: call.id, provider: input.provider, providerCallSid: input.providerCallSid, fromNumber: input.fromNumber, language: input.language });
    sessionRegistry.set(session);
    const greeting = await orchestrator.greet(session, meta);
    return { callId: call.id, session, greeting, resumed: false };
  },

  /**
   * Text turns and operator ends drive a session in this process. A LiveKit call's session lives in the voice
   * worker; resuming it here would run a second copy of the same conversation.
   */
  async assertNotVoiceWorkerCall(callId: string): Promise<void> {
    if ((await loadCall(callId)).provider === LIVEKIT_PROVIDER) {
      throw new AppError(409, 'CALL_HANDLED_BY_VOICE_WORKER', 'This call is handled by the LiveKit voice worker');
    }
  },

  async getSession(callId: string): Promise<ConversationSession> {
    const live = sessionRegistry.get(callId);
    if (live) return live;
    return resumeSession(await loadCall(callId));
  },

  /** `opts.spokeEarly` is server-side only: set by the voice loop, never from a request (see the orchestrator's handleTurn). */
  async turn(callId: string, text: string, opts: { language?: Lang; confidence?: number | null; meta?: RequestMeta; spokeEarly?: boolean } = {}): Promise<TurnResult> {
    const session = await this.getSession(callId);
    return getOrchestrator().handleTurn(session, text, opts);
  },

  endSession(callId: string, reason: SessionEndReason, meta?: RequestMeta): Promise<ConversationState> {
    const running = ending.get(callId);
    if (running) return running;
    const end = (async () => {
      const session = await this.getSession(callId);
      const state = await getOrchestrator().endSession(session, reason, meta);
      sessionRegistry.delete(callId);
      return state;
    })().finally(() => ending.delete(callId));
    ending.set(callId, end);
    return end;
  },

  /** Text simulation: same engine, no telephony. */
  startSimulation(input: { fromNumber: string; language?: Lang }, meta?: RequestMeta): Promise<StartedSession> {
    return this.startSession({ provider: 'simulator', providerCallSid: `sim-${randomUUID()}`, fromNumber: input.fromNumber, toNumber: 'simulator', language: input.language }, meta);
  },

  /**
   * Closes the sessions in this process that nobody has spoken to for `idleMs`; returns how many it ended. Each end
   * is on its own: one that fails is logged, keeps its session registered and is retried by the next sweep.
   * Called by the server timer.
   */
  async closeIdleSessions(idleMs: number): Promise<number> {
    let closed = 0;
    for (const session of sessionRegistry.idle(idleMs)) {
      if (await endLogged(session.callId, 'conversations.idle_close_failed')) closed++;
    }
    return closed;
  },

  /**
   * Recovery for calls that no process is driving any more: one that crashed or restarted mid-call, or a voice worker
   * job whose end failed (the job's process exits with the call, so nothing there retries it). A call with no end and
   * nothing recorded for `staleMs` (no state change, no transcript line) and no session in this process is resumed
   * here and ended as idle. Ends are idempotent across processes (calls.store.ts endCall), so a call another process
   * ends meanwhile is not ended twice. A failed one stays registered here and the idle sweep retries it.
   * ponytail: endedAt is the sweep time, so a recovered call's duration includes the stale wait; pass the last
   * activity time through endSession if those durations matter.
   */
  async closeAbandonedCalls(staleMs: number, now = new Date()): Promise<number> {
    let closed = 0;
    for (const callId of await repo.findAbandoned(new Date(now.getTime() - staleMs))) {
      if (sessionRegistry.get(callId)) continue; // this process's own session: the idle sweep closes it
      if (await endLogged(callId, 'conversations.abandoned_close_failed')) closed++;
    }
    return closed;
  },

  // --- dashboard ---
  async list(query: ListCallsQuery): Promise<Page<Awaited<ReturnType<typeof repo.list>>[0][number] & { isTest: boolean }>> {
    const where: Prisma.CallWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.conversationState ? { conversationState: query.conversationState } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.from || query.to ? { startedAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    };
    const sort = parseSort(query.sort, SORTABLE, 'startedAt');
    const { skip, take } = skipTake(query);
    const [data, total] = await repo.list(where, { [sort.field]: sort.direction }, skip, take);
    return pageResult(data.map((c) => ({ ...c, isTest: isTestCall(c.provider) })), total, query);
  },

  async detail(id: string) {
    const call = await loadCall(id);
    const live = sessionRegistry.get(id);
    return { ...call, isTest: isTestCall(call.provider), live: live ?{ state: live.state, language: live.language, turns: live.turns, candidates: live.candidates.size } : null };
  },

  async transcript(id: string) {
    await loadCall(id);
    return repo.transcripts(id);
  },

  async events(id: string, type: string | undefined, limit: number) {
    await loadCall(id);
    return repo.events(id, type, limit);
  },
};
