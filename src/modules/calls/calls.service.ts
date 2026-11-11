// Conversation session manager: creates the call row and in-memory session for an incoming call (or a
// text simulation), routes utterances to the orchestrator, resumes sessions from the database, ends them,
// and serves the dashboard's call views.
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { ConversationState } from '../../generated/prisma/enums.ts';
import { AppError } from '../../middleware/error-handler.ts';
import type { RequestMeta } from '../../utils/audit.ts';
import type { Lang } from '../../utils/language.ts';
import { pageResult, parseSort, skipTake, type Page } from '../../utils/pagination.ts';
import { serviceToolBackend } from '../ai/ai.backend.ts';
import { getOrchestrator } from '../ai/ai.service.ts';
import type { ConversationSession, TurnResult } from '../ai/ai.types.ts';
import { isTerminalConversation } from '../ai/conversation.state.ts';
import type { SessionEndReason } from '../ai/conversation.service.ts';
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

  async getSession(callId: string): Promise<ConversationSession> {
    const live = sessionRegistry.get(callId);
    if (live) return live;
    return resumeSession(await loadCall(callId));
  },

  async turn(callId: string, text: string, opts: { language?: Lang; confidence?: number | null; meta?: RequestMeta } = {}): Promise<TurnResult> {
    const session = await this.getSession(callId);
    return getOrchestrator().handleTurn(session, text, opts);
  },

  async endSession(callId: string, reason: SessionEndReason, meta?: RequestMeta): Promise<ConversationState> {
    const session = await this.getSession(callId);
    const state = await getOrchestrator().endSession(session, reason, meta);
    sessionRegistry.delete(callId);
    return state;
  },

  /** Text simulation: same engine, no telephony. */
  startSimulation(input: { fromNumber: string; language?: Lang }, meta?: RequestMeta): Promise<StartedSession> {
    return this.startSession({ provider: 'simulator', providerCallSid: `sim-${randomUUID()}`, fromNumber: input.fromNumber, toNumber: 'simulator', language: input.language }, meta);
  },

  /** Closes sessions nobody has spoken to for `idleMs`. Called by the server timer. */
  async closeIdleSessions(idleMs: number): Promise<number> {
    const idle = sessionRegistry.takeIdle(idleMs);
    for (const session of idle) await getOrchestrator().endSession(session, 'idle_timeout');
    return idle.length;
  },

  // --- dashboard ---
  async list(query: ListCallsQuery): Promise<Page<Awaited<ReturnType<typeof repo.list>>[0][number]>> {
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
    return pageResult(data, total, query);
  },

  async detail(id: string) {
    const call = await loadCall(id);
    const live = sessionRegistry.get(id);
    return { ...call, live: live ? { state: live.state, language: live.language, turns: live.turns, candidates: live.candidates.size } : null };
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
