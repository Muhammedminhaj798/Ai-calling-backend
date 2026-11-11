// Contract test against a local stub of the Chat Completions endpoint. It proves the adapter sends tools and
// messages in OpenAI's shape and maps replies, tool calls, usage and failures correctly. It is NOT evidence
// that the live OpenAI API works: that needs a real key (see .env.example).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { AiProviderError } from './ai.port.ts';
import { createOpenAiProvider } from './openai.adapter.ts';

interface Captured {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

let server: http.Server;
let baseUrl: string;
const captured: Captured[] = [];
let mode: 'tool' | 'text' | 'error' | 'slow' = 'tool';

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      captured.push({ path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw || '{}') as Record<string, unknown> });
      const reply = (status: number, payload: unknown, delay = 0) =>
        setTimeout(() => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        }, delay);
      if (mode === 'error') return reply(500, { error: { message: 'boom' } });
      if (mode === 'slow') return reply(200, { choices: [] }, 400);
      const message = mode === 'tool'
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_products', arguments: '{"query":"Dolo 650"}' } }] }
        : { role: 'assistant', content: 'Dolo 650 added.' };
      reply(200, { id: 'x', object: 'chat.completion', created: 0, model: 'gpt-stub', choices: [{ index: 0, message, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const provider = () => createOpenAiProvider({ apiKey: 'test-key-not-real', model: 'gpt-stub', timeoutMs: 100, baseUrl });
const tools = [{ name: 'search_products', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];

describe('OpenAI adapter (stub contract)', () => {
  it('sends system/user/assistant/tool messages and function tools in the API shape', async () => {
    mode = 'tool';
    const result = await provider().complete(
      [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'Dolo 650 please' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'call_0', name: 'identify_customer', arguments: '{"phone":"x"}' }] },
        { role: 'tool', toolCallId: 'call_0', name: 'identify_customer', content: '{"ok":true}' },
      ],
      tools,
    );
    const req = captured.at(-1)!;
    assert.equal(req.path, '/v1/chat/completions');
    assert.equal(req.auth, 'Bearer test-key-not-real');
    assert.equal(req.body['model'], 'gpt-stub');
    assert.equal(req.body['parallel_tool_calls'], false);
    assert.equal(req.body['tool_choice'], 'auto');
    const sentTools = req.body['tools'] as Array<{ type: string; function: { name: string; parameters: unknown } }>;
    assert.equal(sentTools[0]?.type, 'function');
    assert.equal(sentTools[0]?.function.name, 'search_products');
    const messages = req.body['messages'] as Array<Record<string, unknown>>;
    assert.deepEqual(messages.map((m) => m['role']), ['system', 'user', 'assistant', 'tool']);
    assert.equal((messages[2]!['tool_calls'] as Array<{ id: string }>)[0]?.id, 'call_0');
    assert.equal(messages[3]!['tool_call_id'], 'call_0');

    assert.equal(result.text, null);
    assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'search_products', arguments: '{"query":"Dolo 650"}' }]);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 9 });
    assert.equal(result.model, 'gpt-stub');
  });

  it('maps a plain text reply', async () => {
    mode = 'text';
    const result = await provider().complete([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.text, 'Dolo 650 added.');
    assert.deepEqual(result.toolCalls, []);
    assert.equal('tools' in captured.at(-1)!.body, false, 'no tools key when none are allowed');
  });

  it('wraps API errors and timeouts in AiProviderError so the orchestrator hands over', async () => {
    mode = 'error';
    await assert.rejects(provider().complete([{ role: 'user', content: 'hi' }], []), (e: unknown) => e instanceof AiProviderError && /boom|500/.test(e.message));
    mode = 'slow';
    await assert.rejects(provider().complete([{ role: 'user', content: 'hi' }], []), (e: unknown) => e instanceof AiProviderError);
  });
});
