// Wires the configured model provider and the single orchestrator instance.
import { env } from '../../config/env.ts';
import type { AiProvider } from '../../integrations/ai/ai.port.ts';
import { scriptedAiProvider } from '../../integrations/ai/mock.adapter.ts';
import { createOpenAiProvider } from '../../integrations/ai/openai.adapter.ts';
import { callsSessionStore } from '../calls/calls.store.ts';
import { serviceToolBackend } from './ai.backend.ts';
import { createOrchestrator, type Orchestrator } from './conversation.service.ts';

let provider: AiProvider | undefined;
let orchestrator: Orchestrator | undefined;

export function getAiProvider(): AiProvider {
  if (!provider) {
    provider = env.AI_PROVIDER === 'openai'
      ? createOpenAiProvider({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_MODEL, timeoutMs: env.OPENAI_TIMEOUT_MS })
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
