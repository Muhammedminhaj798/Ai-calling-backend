// Local stand-in for Anthropic's POST /v1/messages. Tests queue the HTTP replies "Claude" gives and inspect
// every request the adapter sent. Placeholder key only: nothing here reaches Anthropic.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const TEST_API_KEY = 'sk-ant-test-key-not-real';

export interface StubReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface StubBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface StubBody {
  model?: string;
  max_tokens?: number;
  system?: string;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  tool_choice?: unknown;
  output_config?: unknown;
  fallbacks?: unknown;
  messages: Array<{ role: string; content: StubBlock[] }>;
}

export interface StubRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: StubBody;
}

export async function startAnthropicStub() {
  const queue: StubReply[] = [];
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') as StubBody });
      const reply = queue.shift() ?? errorReply(500, 'api_error');
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
        res.end(JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    enqueue: (...replies: StubReply[]) => void queue.push(...replies),
    reset() {
      queue.length = 0;
      requests.length = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let seq = 0;
const THINKING = { type: 'thinking', thinking: '', signature: 'stub-signature' };

/** A Messages API response body. */
export function message(content: unknown[], stopReason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `msg_${++seq}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stopReason, stop_sequence: null, stop_details: null, usage: { input_tokens: 100, output_tokens: 20 }, ...extra };
}

export const textReply = (text: string): StubReply => ({ body: message([THINKING, { type: 'text', text }], 'end_turn') });

export const toolReply = (name: string, input: Record<string, unknown>): StubReply => ({
  body: message([THINKING, { type: 'tool_use', id: `toolu_stub${++seq}`, name, input }], 'tool_use'),
});

/** An API error; `retry-after-ms: 1` keeps the SDK's single retry fast. */
export const errorReply = (status: number, type: string): StubReply => ({
  status,
  body: { type: 'error', error: { type, message: 'provider free text that must not be surfaced' }, request_id: 'req_stub' },
  headers: { 'request-id': 'req_stub', 'retry-after-ms': '1' },
});
