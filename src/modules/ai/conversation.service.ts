// Order conversation orchestrator: one customer utterance in, one agent reply out. Between the two it runs
// the model, executes validated tool calls, persists transcript and events, and keeps the session state.
import type { ConversationState } from '../../generated/prisma/enums.ts';
import { AiProviderError, type AiProvider, type ChatMessage } from '../../integrations/ai/ai.port.ts';
import type { RequestMeta } from '../../utils/audit.ts';
import { detectLanguage, resolveSessionLanguage, type Lang } from '../../utils/language.ts';
import { CLOSING_TEXT, ENDED_TEXT, FALLBACK_TEXT, GREETING_TEXT, SPOKE_EARLY_NOTE, buildSystemPrompt } from './ai.prompts.ts';
import { executeTool, toolDefinitionsFor } from './ai.tools.ts';
import { AI_ACTOR, type CallEnd, type CallEndSnapshot, type ConversationSession, type SessionStore, type ToolBackend, type TurnResult } from './ai.types.ts';
import { canTransitionConversation, isTerminalConversation } from './conversation.state.ts';
import { HANDOVER_TEXT, triggerHandover } from './handover.ts';

export interface OrchestratorDeps {
  ai: AiProvider;
  backend: ToolBackend;
  store: SessionStore;
  defaultLanguage: Lang;
  maxToolRounds?: number;
  historyLimit?: number;
  now?: () => number;
}

export interface NewSessionInput {
  callId: string;
  provider: string;
  providerCallSid: string;
  fromNumber: string;
  language?: Lang;
}

export type SessionEndReason = 'caller_hangup' | 'completed' | 'provider_error' | 'idle_timeout' | 'operator';

const NO_META: RequestMeta = { ip: undefined, requestId: undefined };

/** Reads the state through a call so TypeScript does not keep a stale narrowing across tool executions. */
const stateOf = (session: ConversationSession): ConversationState => session.state;

export function createOrchestrator(deps: OrchestratorDeps) {
  const now = deps.now ?? Date.now;
  const maxRounds = deps.maxToolRounds ?? 8;
  const historyLimit = deps.historyLimit ?? 60;

  async function setState(session: ConversationSession, to: ConversationState, data?: unknown): Promise<void> {
    if (session.state === to || !canTransitionConversation(session.state, to)) return;
    const from = session.state;
    // Persisted first: if a write fails, the session keeps the state the database has.
    await deps.store.recordEvent(session.callId, { type: 'state_changed', fromState: from, toState: to, data });
    await deps.store.updateCall(session.callId, { conversationState: to });
    session.state = to;
  }

  function trimHistory(session: ConversationSession): void {
    while (session.messages.length > historyLimit) session.messages.shift();
    // never start the visible history on a dangling tool result
    while (session.messages.length > 0 && session.messages[0]!.role === 'tool') session.messages.shift();
  }

  async function persistHandover(session: ConversationSession): Promise<void> {
    if (!session.handover) return;
    await deps.store.recordEvent(session.callId, { type: 'handover_requested', data: session.handover });
    await deps.store.updateCall(session.callId, { status: 'handed_over', handoverReason: session.handover.reason, conversationState: session.state });
  }

  async function say(session: ConversationSession, text: string, toolCalls?: unknown): Promise<void> {
    session.messages.push({ role: 'assistant', content: text });
    await deps.store.recordTranscript(session.callId, { speaker: 'agent', text, language: session.language, toolCalls });
  }

  return {
    createSession(input: NewSessionInput): ConversationSession {
      const t = now();
      return {
        callId: input.callId,
        provider: input.provider,
        providerCallSid: input.providerCallSid,
        fromNumber: input.fromNumber,
        state: 'initializing',
        language: input.language ?? deps.defaultLanguage,
        customer: null,
        deliveryAddressId: null,
        orderId: null,
        order: null,
        candidates: new Map(),
        stockChecks: new Map(),
        executedToolCalls: new Map(),
        readbackRevision: null,
        identificationAttempts: 0,
        handover: null,
        messages: [],
        lastCustomerUtterance: '',
        turns: 0,
        createdAt: t,
        lastActivityAt: t,
      };
    },

    /** Opening line. Also identifies the caller by caller-ID before the customer says anything. */
    async greet(session: ConversationSession, meta: RequestMeta = NO_META): Promise<TurnResult> {
      await deps.store.recordEvent(session.callId, { type: 'session_started', data: { provider: session.provider, fromNumber: session.fromNumber, language: session.language } });
      await setState(session, 'identifying_customer');
      const result = await executeTool({ id: `greet:${session.callId}`, name: 'identify_customer', arguments: JSON.stringify({ phone: session.fromNumber }) }, { session, backend: deps.backend, meta, now });
      await deps.store.recordEvent(session.callId, { type: result.ok ? 'tool_called' : 'tool_failed', toolName: 'identify_customer', toolCallId: `greet:${session.callId}`, ok: result.ok, data: { arguments: { phone: session.fromNumber }, result } });
      if (session.customer) {
        session.language = session.customer.preferredLanguage ?? session.language;
        await deps.store.updateCall(session.callId, { customerId: session.customer.id, language: session.language, conversationState: session.state });
        await deps.store.recordEvent(session.callId, { type: 'state_changed', fromState: 'identifying_customer', toState: session.state });
      }
      // The model sees what caller-ID lookup found, so it can greet by name and confirm the address.
      session.messages.push({ role: 'assistant', content: null, toolCalls: [{ id: `greet:${session.callId}`, name: 'identify_customer', arguments: JSON.stringify({ phone: session.fromNumber }) }] });
      session.messages.push({ role: 'tool', toolCallId: `greet:${session.callId}`, name: 'identify_customer', content: JSON.stringify(result) });
      let greeting = GREETING_TEXT[session.language](session.customer?.name ?? null);
      if (session.handover) {
        await persistHandover(session);
        greeting = (result.ok ? '' : `${greeting} `) + FALLBACK_TEXT[session.language];
      }
      await say(session, greeting);
      return { reply: greeting, language: session.language, state: session.state, toolCalls: [{ name: 'identify_customer', ok: result.ok }], ended: isTerminalConversation(session.state) };
    },

    /**
     * `spokeEarly`: the caller began these words before the previous reply started playing. Set only by the voice
     * loop from its own audio timing (the HTTP turn route never passes it). For this turn only, the model's copy of
     * the words gets SPOKE_EARLY_NOTE (the transcript never does) and record_customer_confirmation is refused.
     */
    async handleTurn(session: ConversationSession, text: string, opts: { language?: Lang; confidence?: number | null; meta?: RequestMeta; spokeEarly?: boolean } = {}): Promise<TurnResult> {
      const meta = opts.meta ?? NO_META;
      if (isTerminalConversation(session.state) || session.state === 'handover_required') {
        const reply = session.state === 'handover_required' ? FALLBACK_TEXT[session.language] : ENDED_TEXT[session.language];
        return { reply, language: session.language, state: session.state, toolCalls: [], ended: true };
      }

      session.turns++;
      session.lastActivityAt = now();
      session.lastCustomerUtterance = text;
      const detected = detectLanguage(text);
      const language = opts.language ?? resolveSessionLanguage(detected, session.language, session.customer?.preferredLanguage ?? null, deps.defaultLanguage);
      if (language !== session.language) {
        session.language = language;
        await deps.store.updateCall(session.callId, { language });
        await deps.store.recordEvent(session.callId, { type: 'language_changed', data: { language, mixed: detected.mixed, shares: detected.shares } });
      }
      await deps.store.recordTranscript(session.callId, { speaker: 'customer', text, language, confidence: opts.confidence ?? null });
      const spokeEarly = opts.spokeEarly === true;
      session.messages.push({ role: 'user', content: spokeEarly ? `${SPOKE_EARLY_NOTE}\n${text}` : text });

      const toolCallsMade: Array<{ name: string; ok: boolean }> = [];
      let reply: string | null = null;

      for (let round = 0; round < maxRounds; round++) {
        const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt(session) }, ...session.messages];
        let completion;
        try {
          completion = await deps.ai.complete(messages, toolDefinitionsFor(session.state));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await deps.store.recordEvent(session.callId, { type: 'provider_error', ok: false, data: { provider: deps.ai.name, message, round } });
          await triggerHandover(session, deps.backend, 'provider_error', message, AI_ACTOR);
          await persistHandover(session);
          reply = FALLBACK_TEXT[session.language];
          break;
        }
        if (completion.usage.inputTokens || completion.usage.outputTokens) {
          await deps.store.recordUsage(session.callId, { provider: deps.ai.name, model: completion.model, ...completion.usage });
        }

        if (completion.toolCalls.length === 0) {
          reply = completion.text?.trim() || FALLBACK_TEXT[session.language];
          break;
        }

        session.messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls });
        for (const call of completion.toolCalls) {
          const before = stateOf(session);
          const result = await executeTool(call, { session, backend: deps.backend, meta, now, customerSpokeEarly: spokeEarly });
          toolCallsMade.push({ name: call.name, ok: result.ok });
          let args: unknown = call.arguments;
          try {
            args = JSON.parse(call.arguments);
          } catch {
            /* keep raw */
          }
          await deps.store.recordEvent(session.callId, { type: result.ok ? 'tool_called' : 'tool_failed', toolName: call.name, toolCallId: call.id, ok: result.ok, data: { arguments: args, result } });
          const after = stateOf(session);
          if (after !== before) {
            await deps.store.recordEvent(session.callId, { type: 'state_changed', fromState: before, toState: after, data: { tool: call.name } });
            await deps.store.updateCall(session.callId, { conversationState: after, customerId: session.customer?.id ?? undefined });
          }
          session.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
        }
        if (stateOf(session) === 'handover_required') {
          await persistHandover(session);
          reply = HANDOVER_TEXT[session.language];
          break;
        }
      }

      if (reply === null) {
        await deps.store.recordEvent(session.callId, { type: 'tool_rounds_exhausted', ok: false, data: { maxRounds } });
        await triggerHandover(session, deps.backend, 'other', `model did not produce a reply within ${maxRounds} tool rounds`, AI_ACTOR);
        await persistHandover(session);
        reply = FALLBACK_TEXT[session.language];
      }

      await say(session, reply, toolCallsMade.length > 0 ? toolCallsMade : undefined);
      trimHistory(session);
      const finalState = stateOf(session);
      if (finalState === 'completed') await deps.store.updateCall(session.callId, { conversationState: 'completed' });
      return { reply, language: session.language, state: finalState, toolCalls: toolCallsMade, ended: isTerminalConversation(finalState) || finalState === 'handover_required' };
    },

    /**
     * Closes the session: records how it ended, raises an exception when a draft was left unconfirmed. Safe to call
     * from any number of processes at once: the store ends the call once (decideCallEnd on the committed call) and
     * every caller gets the committed state. The session takes that state only after the database has it, so a
     * failed end leaves the session as it was and can simply be retried.
     */
    async endSession(session: ConversationSession, reason: SessionEndReason, meta: RequestMeta = NO_META): Promise<ConversationState> {
      const { conversationState } = await deps.store.endCall(session.callId, new Date(now()), (call) => decideCallEnd(call, session, reason));
      session.state = conversationState;
      void meta;
      return conversationState;
    },

    closingText: (lang: Lang) => CLOSING_TEXT[lang],
  };
}

/**
 * How a call ends, decided from the call as committed (`call`, read while no other end runs), not from this
 * process's session, which another process may have moved on from. `session` only supplies the summary text.
 * - The conversation already finished (order confirmed, or failed): it keeps its state; the call just closes.
 * - Handover requested: the conversation completes and the call stays handed_over.
 * - A draft or read-back order left unconfirmed: the conversation fails and an exception is raised for staff.
 * - The order was confirmed (the confirmation committed before this end; orders.service.ts confirm locks the call
 *   row, so it cannot commit after it): the conversation completes, whatever ended the call.
 * - The provider reported an error: failed. Otherwise: completed.
 */
export function decideCallEnd(call: CallEndSnapshot, session: ConversationSession, reason: SessionEndReason): CallEnd {
  const before = call.conversationState;
  if (isTerminalConversation(before)) return { conversationState: before, status: before === 'completed' ? 'completed' : 'failed' };

  const ended = (next: ConversationState, status: CallEnd['status'], exception?: CallEnd['exception']): CallEnd => ({
    conversationState: next,
    status,
    aiSummary: summarise(session, reason),
    event: { fromState: before, toState: next, data: { reason } },
    ...(exception ? { exception } : {}),
  });
  if (before === 'handover_required') return ended('completed', 'handed_over');
  const order = call.order;
  if (order && (order.status === 'draft' || order.status === 'pending_customer_confirmation')) {
    // pending_customer_confirmation: read back and not confirmed (a line change after read-back returns it to draft).
    const unconfirmedReadback = order.status === 'pending_customer_confirmation';
    return ended('failed', 'completed', {
      type: unconfirmedReadback ? 'customer_unconfirmed' : 'call_dropped_with_draft',
      description: `Call ended (${reason}) with draft ${order.orderNumber} ${unconfirmedReadback ? 'read back but not confirmed' : 'incomplete'}; ${order.lines} line(s) captured`,
      callId: session.callId,
      customerId: order.customerId,
      orderId: order.id,
      details: { reason, state: before, lines: order.lines },
    });
  }
  if (order && order.status !== 'cancelled') return ended('completed', 'completed');
  if (reason === 'provider_error') return ended('failed', 'failed');
  return ended('completed', 'completed');
}

function summarise(session: ConversationSession, reason: SessionEndReason): string {
  const who = session.customer ? `${session.customer.name} (${session.customer.externalCode})` : `unidentified caller ${session.fromNumber}`;
  const order = session.order ? `order ${session.order.orderNumber} ${session.order.status} with ${session.order.items.length} line(s)` : 'no order';
  return `${who}; ${order}; ended: ${reason}; ${session.turns} turn(s)${session.handover ? `; handover: ${session.handover.reason}` : ''}`;
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
export { AiProviderError };
