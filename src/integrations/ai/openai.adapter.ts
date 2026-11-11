// OpenAI Chat Completions adapter with function tools. Fully implemented against the installed SDK but
// NOT exercised against the live API in this repository (no key available at build time) — the first real
// call must be verified with a sample conversation before any production route is enabled.
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { AiProviderError, type AiCompletion, type AiProvider, type ChatMessage, type ToolDefinition } from './ai.port.ts';

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Override the API base URL (contract tests point it at a local stub). */
  baseUrl?: string;
}

function toOpenAiMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return { role: 'user', content: m.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls && m.toolCalls.length > 0
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

function toOpenAiTools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function createOpenAiProvider(config: OpenAiConfig): AiProvider {
  const client = new OpenAI({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 1, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
  return {
    name: 'openai',
    async complete(messages, tools, opts): Promise<AiCompletion> {
      try {
        const response = await client.chat.completions.create({
          model: config.model,
          messages: toOpenAiMessages(messages),
          ...(tools.length > 0 ? { tools: toOpenAiTools(tools), tool_choice: 'auto' as const, parallel_tool_calls: false } : {}),
          temperature: opts?.temperature ?? 0.2,
        });
        const choice = response.choices[0];
        if (!choice) throw new AiProviderError('OpenAI returned no choices');
        const toolCalls = (choice.message.tool_calls ?? []).flatMap((c) =>
          c.type === 'function' ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : [],
        );
        return {
          text: choice.message.content ?? null,
          toolCalls,
          usage: { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 },
          model: response.model,
        };
      } catch (err) {
        if (err instanceof AiProviderError) throw err;
        throw new AiProviderError(`OpenAI request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    },
  };
}
