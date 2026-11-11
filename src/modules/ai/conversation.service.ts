// Order conversation orchestrator: one customer utterance in, one agent reply out. Between the two it runs
// the model, executes validated tool calls, persists transcript and events, and keeps the session state.
import type { ConversationState } from '../../generated/prisma/enums.ts';
import { AiProviderError, type AiProvider, type ChatMessage } from '../../integrations/ai/ai.port.ts';
import type { RequestMeta } from '../../utils/audit.ts';
import { detectLanguage, resolveSessionLanguage, type Lang } from '../../utils/language.ts';
import { CLOSING_TEXT, ENDED_TEXT, FALLBACK_TEXT, GREETING_TEXT, buildSystemPrompt } from './ai.prompts.ts';
import { executeTool, toolDefinitionsFor } from './ai.tools.ts';
import { AI_ACTOR, type ConversationSession, type SessionStore, type ToolBackend, type TurnResult } from './ai.types.ts';
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
    session.state = to;
    await deps.store.recordEvent(session.callId, { type: 'state_changed', fromState: from, toState: to, data });
    await deps.store.updateCall(session.callId, { conversationState: to });
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

    async handleTurn(session: ConversationSession, text: string, opts: { language?: Lang; confidence?: number | null; meta?: RequestMeta } = {}): Promise<TurnResult> {
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
      session.messages.push({ role: 'user', content: text });

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
          const result = await executeTool(call, { session, backend: deps.backend, meta, now });
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

    /** Closes the session: records how it ended, raises an exception when a draft was left unconfirmed. */
    async endSession(session: ConversationSession, reason: SessionEndReason, meta: RequestMeta = NO_META): Promise<ConversationState> {
      if (isTerminalConversation(session.state)) return session.state;
      const before = session.state;
      let next: ConversationState = 'completed';
      let status: 'completed' | 'handed_over' | 'failed' = 'completed';

      if (before === 'handover_required') {
        status = 'handed_over';
      } else if (session.order && (session.order.status === 'draft' || session.order.status === 'pending_customer_confirmation')) {
        next = 'failed';
        const unconfirmedReadback = session.readbackRevision !== null;
        try {
          await deps.backend.raiseException(
            {
              type: unconfirmedReadback ? 'customer_unconfirmed' : 'call_dropped_with_draft',
              description: `Call ended (${reason}) with draft ${session.order.orderNumber} ${unconfirmedReadback ? 'read back but not confirmed' : 'incomplete'}; ${session.order.items.length} line(s) captured`,
              callId: session.callId,
              customerId: session.customer?.id ?? null,
              orderId: session.order.id,
              details: { reason, state: before, lines: session.order.items.length },
            },
            AI_ACTOR,
          );
        } catch {
          /* recorded in the call event below regardless */
        }
      } else if (reason === 'provider_error') {
        next = 'failed';
        status = 'failed';
      }

      session.state = next;
      await deps.store.recordEvent(session.callId, { type: 'session_ended', fromState: before, toState: next, data: { reason } });
      await deps.store.updateCall(session.callId, { conversationState: next, status, endedAt: new Date(now()), aiSummary: summarise(session, reason) });
      void meta;
      return next;
    },

    closingText: (lang: Lang) => CLOSING_TEXT[lang],
  };
}

function summarise(session: ConversationSession, reason: SessionEndReason): string {
  const who = session.customer ? `${session.customer.name} (${session.customer.externalCode})` : `unidentified caller ${session.fromNumber}`;
  const order = session.order ? `order ${session.order.orderNumber} ${session.order.status} with ${session.order.items.length} line(s)` : 'no order';
  return `${who}; ${order}; ended: ${reason}; ${session.turns} turn(s)${session.handover ? `; handover: ${session.handover.reason}` : ''}`;
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
export { AiProviderError };
