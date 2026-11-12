// Port for the conversation model provider. The orchestrator only ever sees these shapes; the Anthropic
// adapter maps them to the Claude Messages API, the OpenAI adapter to Chat Completions, and the mock replays
// scripted responses for tests and local runs.

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments exactly as the model produced them; validated by the tool registry. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object */
  parameters: Record<string, unknown>;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiCompletion {
  text: string | null;
  toolCalls: ToolCall[];
  usage: AiUsage;
  model: string;
}

export class AiProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AiProviderError';
  }
}

export interface AiProvider {
  readonly name: 'mock' | 'openai' | 'anthropic';
  complete(messages: ChatMessage[], tools: ToolDefinition[], opts?: { temperature?: number }): Promise<AiCompletion>;
}
