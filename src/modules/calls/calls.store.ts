// SessionStore backed by the database: transcripts, call events, call state and model usage costs.
import { env } from '../../config/env.ts';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { SessionStore } from '../ai/ai.types.ts';
import { callsRepository } from './calls.repository.ts';

const toJson = (v: unknown): Prisma.InputJsonValue | undefined => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

export const callsSessionStore: SessionStore = {
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

  async updateCall(callId, patch) {
    await callsRepository.update(callId, {
      ...(patch.conversationState !== undefined ? { conversationState: patch.conversationState } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.language !== undefined ? { language: patch.language } : {}),
      ...(patch.customerId !== undefined ? { customerId: patch.customerId } : {}),
      ...(patch.handoverReason !== undefined ? { handoverReason: patch.handoverReason } : {}),
      ...(patch.endedAt !== undefined ? { endedAt: patch.endedAt } : {}),
      ...(patch.aiSummary !== undefined ? { aiSummary: patch.aiSummary } : {}),
      lastActivityAt: new Date(),
    });
  },

  async recordUsage(callId, usage) {
    const rows = [
      { units: usage.inputTokens, unitType: 'input_tokens', price: env.OPENAI_PRICE_INPUT_USD_PER_1M },
      { units: usage.outputTokens, unitType: 'output_tokens', price: env.OPENAI_PRICE_OUTPUT_USD_PER_1M },
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
