// Wires the configured model provider and the single orchestrator instance.
import { env } from '../../config/env.ts';
import type { AiProvider } from '../../integrations/ai/ai.port.ts';
import { createAnthropicProvider } from '../../integrations/ai/anthropic.adapter.ts';
import { scriptedAiProvider } from '../../integrations/ai/mock.adapter.ts';
import { createOpenAiProvider } from '../../integrations/ai/openai.adapter.ts';
import { logger } from '../../utils/logger.ts';
import { callsSessionStore } from '../calls/calls.store.ts';
import { serviceToolBackend } from './ai.backend.ts';
import { createOrchestrator, type Orchestrator } from './conversation.service.ts';

/** Logs each model round's latency and token counts (never content): splits a voice turn into model and other time. */
function timed(inner: AiProvider): AiProvider {
  return {
    name: inner.name,
    async complete(messages, tools, opts) {
      const started = Date.now();
      const completion = await inner.complete(messages, tools, opts);
      logger.info('ai.completion', { provider: inner.name, model: completion.model, ms: Date.now() - started, inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, toolCalls: completion.toolCalls.length });
      return completion;
    },
  };
}

let provider: AiProvider | undefined;
let orchestrator: Orchestrator | undefined;

export function getAiProvider(): AiProvider {
  if (!provider) {
    provider = env.AI_PROVIDER === 'anthropic'
      ? timed(createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL, effort: env.ANTHROPIC_EFFORT, timeoutMs: env.ANTHROPIC_TIMEOUT_MS }))
      : env.AI_PROVIDER === 'openai'
        ? timed(createOpenAiProvider({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_MODEL, timeoutMs: env.OPENAI_TIMEOUT_MS }))
        : scriptedAiProvider;
  }
  return provider;
}

export function getOrchestrator(): Orchestrator {
  if (!orchestrator) {
    orchestrator = createOrchestrator({
      ai: getAiProvider(),
      backend: serviceToolBackend,
      store: callsSessionStore,
      defaultLanguage: env.DEFAULT_LANGUAGE,
      maxToolRounds: env.AI_MAX_TOOL_ROUNDS,
      historyLimit: env.AI_HISTORY_MESSAGES,
    });
  }
  return orchestrator;
}
