// Scripted model provider. Tests (and local runs without an API key) enqueue the responses the "model"
// should give; every request is recorded so tests can assert what the orchestrator sent.
import type { AiCompletion, AiProvider, ChatMessage, ToolDefinition } from './ai.port.ts';

export interface ScriptedResponse {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
}

export interface RecordedRequest {
  messages: ChatMessage[];
  toolNames: string[];
}

export interface ScriptedAiProvider extends AiProvider {
  enqueue(...responses: ScriptedResponse[]): void;
  clear(): void;
  readonly requests: RecordedRequest[];
  readonly pending: number;
}

export function createScriptedAiProvider(): ScriptedAiProvider {
  const queue: ScriptedResponse[] = [];
  const requests: RecordedRequest[] = [];
  let counter = 0;
  return {
    name: 'mock',
    requests,
    get pending() {
      return queue.length;
    },
    enqueue(...responses) {
      queue.push(...responses);
    },
    clear() {
      queue.length = 0;
      requests.length = 0;
    },
    async complete(messages, tools): Promise<AiCompletion> {
      requests.push({ messages: [...messages], toolNames: tools.map((t) => t.name) });
      const next = queue.shift();
      if (!next) {
        return { text: 'Mock AI provider: no scripted response is queued. Set AI_PROVIDER=openai for real conversations.', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, model: 'mock' };
      }
      return {
        text: next.text ?? null,
        toolCalls: (next.toolCalls ?? []).map((c) => ({ id: c.id ?? `mock-call-${++counter}`, name: c.name, arguments: JSON.stringify(c.args) })),
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'mock',
      };
    },
  };
}

/** Shared instance so integration tests can script the provider the running app uses. */
export const scriptedAiProvider = createScriptedAiProvider();

export { createScriptedAiProvider as createMockAiProvider };
export type { ToolDefinition };
