// Anthropic Claude Messages API adapter with client tools. It only translates: the orchestrator still owns the
// tool loop, state-based permissions, validation (every tool input goes through the Zod registry) and
// persistence. Contract-tested against a local HTTP stub; the first live call must be verified with a real key.
//
// Thinking blocks are deliberately not replayed. The orchestrator rebuilds the system prompt and the
// state-filtered tool list every round, which would invalidate replayed blocks; sending none is valid.
import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { AiProviderError, type AiCompletion, type AiProvider, type ChatMessage, type ToolDefinition } from './ai.port.ts';

export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

/** Defaults shared by the env schema and scripts/ai-smoke.ts, so both always exercise the same model. */
export const ANTHROPIC_DEFAULTS = { model: 'claude-opus-5-5', effort: 'low', timeoutMs: 20_000 } as const satisfies {
  model: string;
  effort: AnthropicEffort;
  timeoutMs: number;
};

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  /** Thinking depth (always on for current models): the main latency / cost / quality control. */
  effort: AnthropicEffort;
  timeoutMs: number;
  /** Override the API base URL (contract tests point it at a local stub). */
  baseUrl?: string;
}

// Thinking counts toward max_tokens; phone replies are short, so this leaves ample room for both.
const MAX_TOKENS = 16_000;
// The Messages API requires the first message to be the user's. The orchestrator's history opens with the
// agent's caller-ID lookup and greeting, so a neutral marker stands in for the call being answered.
export const CALL_CONNECTED = '[Call connected]';

/** Tool-use ids allow only [a-zA-Z0-9_-]; the orchestrator's synthetic ids (greet:<callId>) contain ':'. */
const toolUseId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}

/** Tool results are the registry's JSON ToolResult; ok:false is reported to Claude as a tool error. */
function isFailedResult(content: string): boolean {
  try {
    return (JSON.parse(content) as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}

function toAnthropicTools(tools: ToolDefinition[]): BetaTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as BetaTool['input_schema'] }));
}

/** Neutral history → top-level system prompt plus alternating user/assistant messages. */
function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: BetaMessageParam[] } {
  const system: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: BetaContentBlockParam[] }> = [];
  // Consecutive same-role entries (several tool results, or a tool result then customer text) share one message.
  const push = (role: 'user' | 'assistant', blocks: BetaContentBlockParam[]) => {
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else if (blocks.length > 0) out.push({ role, content: blocks });
  };
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        system.push(m.content);
        break;
      case 'user':
        push('user', [{ type: 'text', text: m.content }]);
        break;
      case 'assistant':
        push('assistant', [
          ...(m.content?.trim() ? [{ type: 'text' as const, text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({ type: 'tool_use' as const, id: toolUseId(c.id), name: c.name, input: parseArgs(c.arguments) })),
        ]);
        break;
      case 'tool':
        push('user', [{ type: 'tool_result', tool_use_id: toolUseId(m.toolCallId), content: m.content, ...(isFailedResult(m.content) ? { is_error: true } : {}) }]);
        break;
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: CALL_CONNECTED }] });
  return { system: system.join('\n\n'), messages: out };
}

function fromAnthropicMessage(response: BetaMessage): AiCompletion {
  switch (response.stop_reason) {
    case 'end_turn':
    case 'tool_use':
    case 'stop_sequence':
      break;
    case 'refusal':
      throw new AiProviderError(`Claude declined the request (refusal${response.stop_details?.category ? `: ${response.stop_details.category}` : ''})`);
    default:
      // max_tokens / context window: a cut-off reply or tool input must not reach the customer or the tools
      throw new AiProviderError(`Claude stopped without a usable reply (${response.stop_reason ?? 'no stop reason'})`);
  }
  // After a server-side fallback only the blocks following the last fallback marker belong to the reply.
  const blocks = response.content.slice(response.content.map((b) => b.type).lastIndexOf('fallback') + 1);
  const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return {
    text: text.trim() ? text : null,
    toolCalls: blocks.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }] : [])),
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    model: response.model,
  };
}

/** Status, error type and request id only — never the request, the key or the provider's free-text message. */
function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'Anthropic request timed out';
  if (err instanceof Anthropic.APIConnectionError) return 'Anthropic API unreachable';
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status ?? '?'}${err.type ? ` ${err.type}` : ''}${err.requestID ? ` (request ${err.requestID})` : ''}`;
  }
  return 'Anthropic request failed';
}

export function createAnthropicProvider(config: AnthropicConfig): AiProvider {
  // maxRetries: one retry on 408/409/429/5xx/connection errors, honouring retry-after; a caller is waiting.
  const client = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 1, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
  return {
    name: 'anthropic',
    async complete(messages, tools): Promise<AiCompletion> {
      // opts.temperature is ignored: current Claude models reject sampling parameters.
      const request = toAnthropicMessages(messages);
      let response: BetaMessage;
      try {
        response = await client.beta.messages.create({
          model: config.model,
          max_tokens: MAX_TOKENS,
          ...(request.system ? { system: request.system } : {}),
          messages: request.messages,
          // One call per round, like the OpenAI adapter: each tool can change the state and with it the tool set.
          ...(tools.length > 0 ? { tools: toAnthropicTools(tools), tool_choice: { type: 'auto' as const, disable_parallel_tool_use: true } } : {}),
          output_config: { effort: config.effort },
          // On a safety-classifier decline the API retries on Anthropic's recommended fallback model.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
      } catch (err) {
        throw new AiProviderError(describeError(err), { cause: err });
      }
      return fromAnthropicMessage(response);
    },
  };
}
