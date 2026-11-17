// SessionStore backed by the database: transcripts, call events, call state and model usage costs.
//
// Ending a call is coordinated through the database, not process memory: the API server and the LiveKit voice
// worker (and any second instance of either) can end the same call at once. endCall locks the call row, so the
// first end decides and commits everything that belongs to the end in one transaction, and every other end waits
// for that commit and then reads it. updateCall never touches a call that has ended or finished, so a late write
// from another process (a turn still running when the caller hung up) cannot take it back to an earlier state.
import { prisma } from '../../config/db.ts';
import { env } from '../../config/env.ts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import type { ConversationState } from '../../generated/prisma/enums.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { AI_ACTOR, type SessionStore } from '../ai/ai.types.ts';
import { TERMINAL_CONVERSATION_STATES } from '../ai/conversation.state.ts';
import { exceptionsService } from '../exceptions/exceptions.service.ts';
import { callClosing, callsRepository } from './calls.repository.ts';

const toJson = (v: unknown): Prisma.InputJsonValue | undefined => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

interface LockedCall {
  conversationState: ConversationState;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
}

/**
 * The SessionStore over `db`. updateCall and endCall, the two writers of the call row's state, use `db`; the
 * integration tests pass a second client to act as a second process. Transcripts, events and usage go through
 * callsRepository on the process client.
 */
export function createCallsSessionStore(db: PrismaClient = prisma): SessionStore {
  return {
    ...callsSessionStoreRecords,

    async updateCall(callId, patch) {
      const data = {
        ...(patch.conversationState !== undefined ? { conversationState: patch.conversationState } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.language !== undefined ? { language: patch.language } : {}),
        ...(patch.customerId !== undefined ? { customerId: patch.customerId } : {}),
        ...(patch.handoverReason !== undefined ? { handoverReason: patch.handoverReason } : {}),
        lastActivityAt: new Date(),
      };
      // One conditional statement, so it is atomic with any end: an end committed first makes this match nothing
      // (an update racing an end waits for the end's row lock, then re-checks these conditions).
      await db.call.updateMany({ where: { id: callId, endedAt: null, conversationState: { notIn: [...TERMINAL_CONVERSATION_STATES] } }, data });
    },

    endCall(callId, endedAt, decide) {
      return db.$transaction(async (tx) => {
        // FOR NO KEY UPDATE serialises ends of this call across every process and connection: a second end blocks
        // here until the first commits, then sees ended_at set. Transcript and event inserts for the call (foreign
        // keys take only KEY SHARE) are not blocked by it.
        const [call] = await tx.$queryRaw<LockedCall[]>`
          SELECT conversation_state::text AS "conversationState", started_at AS "startedAt", ended_at AS "endedAt", duration_seconds AS "durationSeconds"
          FROM calls WHERE id = ${callId}::uuid FOR NO KEY UPDATE`;
        if (!call) throw new AppError(404, 'CALL_NOT_FOUND', 'Call not found');
        const closing = callClosing(call, endedAt);
        // Ended already (by this process or another): the first end's result stands; nothing is written again.
        if (!closing) return { conversationState: call.conversationState, ended: false };

        const order = await tx.order.findUnique({ where: { callId }, select: { id: true, orderNumber: true, status: true, customerId: true, _count: { select: { items: true } } } });
        const end = decide({
          conversationState: call.conversationState,
          order: order ? { id: order.id, orderNumber: order.orderNumber, status: order.status, customerId: order.customerId, lines: order._count.items } : null,
        });
        // The end's side effects commit with it, or not at all: a retried end after a failure raises them once.
        if (end.exception) await exceptionsService.raise(end.exception, AI_ACTOR, tx);
        if (end.event) {
          await tx.callEvent.create({ data: { callId, type: 'session_ended', fromState: end.event.fromState, toState: end.event.toState, data: toJson(end.event.data) } });
        }
        await tx.call.update({
          where: { id: callId },
          data: { conversationState: end.conversationState, status: end.status, ...(end.aiSummary !== undefined ? { aiSummary: end.aiSummary } : {}), lastActivityAt: new Date(), ...closing },
        });
        return { conversationState: end.conversationState, ended: true };
      });
    },
  };
}

const callsSessionStoreRecords: Pick<SessionStore, 'recordTranscript' | 'recordEvent' | 'recordUsage'> = {
  async recordTranscript(callId, entry) {
    await callsRepository.addTranscript(callId, {
      callId,
      sequence: 0,
      speaker: entry.speaker,
      text: entry.text,
      language: entry.language,
      confidence: entry.confidence ?? null,
      toolCalls: toJson(entry.toolCalls),
    });
  },

  async recordEvent(callId, event) {
    await callsRepository.addEvent({
      callId,
      type: event.type,
      fromState: event.fromState ?? null,
      toState: event.toState ?? null,
      toolName: event.toolName ?? null,
      toolCallId: event.toolCallId ?? null,
      ok: event.ok ?? null,
      data: toJson(event.data),
    });
  },

  async recordUsage(callId, usage) {
    const anthropic = usage.provider === 'anthropic';
    const rows = [
      { units: usage.inputTokens, unitType: 'input_tokens', price: anthropic ? env.ANTHROPIC_PRICE_INPUT_USD_PER_1M : env.OPENAI_PRICE_INPUT_USD_PER_1M },
      { units: usage.outputTokens, unitType: 'output_tokens', price: anthropic ? env.ANTHROPIC_PRICE_OUTPUT_USD_PER_1M : env.OPENAI_PRICE_OUTPUT_USD_PER_1M },
    ].filter((r) => r.units > 0);
    if (rows.length === 0) return;
    await callsRepository.addUsage(
      rows.map((r) => ({
        callId,
        service: 'llm',
        provider: usage.provider,
        units: r.units,
        unitType: r.unitType,
        // USD × 1e6 per token = price per 1M tokens
        costMicroUsd: BigInt(Math.round(r.units * r.price)),
        metadata: { model: usage.model },
      })),
    );
  },
};

/** The process store, on the process client. */
export const callsSessionStore: SessionStore = createCallsSessionStore();
