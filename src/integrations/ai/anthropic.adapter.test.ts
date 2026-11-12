// Contract tests against a local stub of POST /v1/messages: request construction, tool schema conversion,
// history mapping, text / tool-use / usage mapping, refusals, fallbacks, retries and error hygiene. They are
// NOT evidence that the live Anthropic API works: that needs a real ANTHROPIC_API_KEY (see README).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { errorReply, message, startAnthropicStub, TEST_API_KEY, textReply, toolReply } from '../../../tests/fakes/anthropic-stub.ts';
import { AiProviderError, type ChatMessage } from './ai.port.ts';
import { CALL_CONNECTED, createAnthropicProvider } from './anthropic.adapter.ts';

let stub: Awaited<ReturnType<typeof startAnthropicStub>>;
before(async () => {
  stub = await startAnthropicStub();
});
after(() => stub.close());
beforeEach(() => stub.reset());

const provider = (timeoutMs = 2000) => createAnthropicProvider({ apiKey: TEST_API_KEY, model: 'claude-opus-5-5', effort: 'low', timeoutMs, baseUrl: stub.baseUrl });
const searchTool = {
  name: 'search_products',
  description: 'Search the catalogue',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
};
const MIXED = 'Dolo 650 ഇരുപത് സ്ട്രിപ്പ് വേണം';

// The shape the orchestrator builds: caller-ID lookup and greeting come before the customer's first words.
const greeted: ChatMessage[] = [
  { role: 'system', content: 'RULES' },
  { role: 'assistant', content: null, toolCalls: [{ id: 'greet:call-1', name: 'identify_customer', arguments: '{"phone":"+919847012345"}' }] },
  { role: 'tool', toolCallId: 'greet:call-1', name: 'identify_customer', content: '{"ok":true,"result":{"name":"Sample Medicals"}}' },
  { role: 'assistant', content: 'നമസ്കാരം Sample Medicals.' },
  { role: 'user', content: MIXED },
];

const rejectsWith = (p: Promise<unknown>, pattern: RegExp) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AiProviderError, 'always an AiProviderError, so the orchestrator hands over');
    assert.match(e.message, pattern);
    assert.doesNotMatch(e.message, new RegExp(`${TEST_API_KEY}|provider free text`), 'no key or provider free text in the message');
    return true;
  });

describe('Anthropic adapter — request construction', () => {
  it('sends model, effort, fallback opt-in, auto tool choice and converted tools; no sampling or thinking overrides', async () => {
    stub.enqueue(textReply('ok'));
    await provider().complete(greeted, [searchTool], { temperature: 0.2 });
    const req = stub.requests[0]!;
    assert.match(req.path, /^\/v1\/messages/);
    assert.equal(req.headers['authorization'], `Bearer ${TEST_API_KEY}`, 'SDK 1.x sends the API key as a bearer token');
    assert.ok(req.headers['anthropic-version']);
    assert.match(String(req.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    const body = req.body;
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.max_tokens, 16_000);
    assert.equal(body.system, 'RULES');
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.fallbacks, 'default');
    assert.deepEqual(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    assert.deepEqual(body.tools, [{ name: 'search_products', description: 'Search the catalogue', input_schema: searchTool.parameters }]);
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(key in body, false, `${key} must not be sent`);
  });

  it('maps the neutral history: user first, safe tool ids, tool results as tool_result blocks in one user turn', async () => {
    stub.enqueue(textReply('ok'));
    await provider().complete(
      [
        ...greeted,
        {
          role: 'assistant',
          content: 'Checking.',
          toolCalls: [
            { id: 'toolu_a', name: 'search_products', arguments: '{"query":"Dolo 650"}' },
            { id: 'toolu_b', name: 'check_inventory', arguments: '{"productId":"p1","quantity":20}' },
          ],
        },
        { role: 'tool', toolCallId: 'toolu_a', name: 'search_products', content: '{"ok":true,"result":{}}' },
        { role: 'tool', toolCallId: 'toolu_b', name: 'check_inventory', content: '{"ok":false,"code":"STOCK_CHECK_REQUIRED"}' },
      ],
      [searchTool],
    );
    const m = stub.requests[0]!.body.messages;
    assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    assert.deepEqual(m[0]!.content, [{ type: 'text', text: CALL_CONNECTED }]);
    assert.deepEqual(m[1]!.content, [{ type: 'tool_use', id: 'greet_call-1', name: 'identify_customer', input: { phone: '+919847012345' } }]);
    assert.deepEqual(m[2]!.content, [{ type: 'tool_result', tool_use_id: 'greet_call-1', content: '{"ok":true,"result":{"name":"Sample Medicals"}}' }]);
    assert.deepEqual(m[3]!.content, [{ type: 'text', text: 'നമസ്കാരം Sample Medicals.' }]);
    assert.deepEqual(m[4]!.content, [{ type: 'text', text: MIXED }], 'mixed-language text passes through verbatim');
    assert.deepEqual(m[5]!.content.map((b) => b.type), ['text', 'tool_use', 'tool_use']);
    assert.deepEqual(m[6]!.content.map((b) => [b.type, b.tool_use_id, b.is_error ?? false]), [
      ['tool_result', 'toolu_a', false],
      ['tool_result', 'toolu_b', true],
    ]);
  });

  it('omits tools and tool_choice when no tool is allowed', async () => {
    stub.enqueue(textReply('ok'));
    await provider().complete([{ role: 'user', content: 'hi' }], []);
    assert.equal('tools' in stub.requests[0]!.body, false);
    assert.equal('tool_choice' in stub.requests[0]!.body, false);
  });
});

describe('Anthropic adapter — response mapping', () => {
  it('maps a text reply (thinking blocks ignored) with usage and model', async () => {
    stub.enqueue({
      body: message([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Dolo 650, ' }, { type: 'text', text: 'twenty strips added.' }], 'end_turn', {
        usage: { input_tokens: 321, output_tokens: 45 },
      }),
    });
    const r = await provider().complete([{ role: 'user', content: 'hi' }], [searchTool]);
    assert.equal(r.text, 'Dolo 650, twenty strips added.');
    assert.deepEqual(r.toolCalls, []);
    assert.deepEqual(r.usage, { inputTokens: 321, outputTokens: 45 });
    assert.equal(r.model, 'claude-opus-5-5');
  });

  it('maps a single tool_use block to a ToolCall with JSON arguments', async () => {
    stub.enqueue(toolReply('search_products', { query: 'Dolo 650' }));
    const r = await provider().complete([{ role: 'user', content: 'Dolo 650' }], [searchTool]);
    assert.equal(r.text, null);
    assert.equal(r.toolCalls.length, 1);
    assert.match(r.toolCalls[0]!.id, /^toolu_/);
    assert.equal(r.toolCalls[0]!.name, 'search_products');
    assert.deepEqual(JSON.parse(r.toolCalls[0]!.arguments), { query: 'Dolo 650' });
  });

  it('keeps several tool_use blocks in order and passes unexpected inputs through for the registry to validate', async () => {
    stub.enqueue({
      body: message(
        [
          { type: 'text', text: 'One moment.' },
          { type: 'tool_use', id: 'toolu_1', name: 'search_products', input: { query: 'Dolo' } },
          { type: 'tool_use', id: 'toolu_2', name: 'add_order_item', input: { quantity: 'twenty' } },
        ],
        'tool_use',
      ),
    });
    const r = await provider().complete([{ role: 'user', content: 'x' }], [searchTool]);
    assert.equal(r.text, 'One moment.');
    assert.deepEqual(r.toolCalls, [
      { id: 'toolu_1', name: 'search_products', arguments: '{"query":"Dolo"}' },
      { id: 'toolu_2', name: 'add_order_item', arguments: '{"quantity":"twenty"}' },
    ]);
  });

  it('after a server-side fallback uses only the blocks after the fallback marker and reports the serving model', async () => {
    stub.enqueue({
      body: message(
        [
          { type: 'text', text: 'partial from the declined model' },
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
          { type: 'text', text: 'Served by the fallback.' },
        ],
        'end_turn',
        { model: 'claude-opus-5' },
      ),
    });
    const r = await provider().complete([{ role: 'user', content: 'x' }], []);
    assert.equal(r.text, 'Served by the fallback.');
    assert.equal(r.model, 'claude-opus-5');
  });

  it('a refusal or a cut-off reply is a provider error, never text for the customer', async () => {
    stub.enqueue({ body: message([], 'refusal', { stop_details: { type: 'refusal', category: 'bio', explanation: null } }) });
    await rejectsWith(provider().complete([{ role: 'user', content: 'x' }], []), /refusal: bio/);
    stub.enqueue({ body: message([{ type: 'tool_use', id: 'toolu_x', name: 'search_products', input: {} }], 'max_tokens') });
    await rejectsWith(provider().complete([{ role: 'user', content: 'x' }], [searchTool]), /max_tokens/);
  });
});

describe('Anthropic adapter — failures', () => {
  it('retries a rate limit once and then succeeds', async () => {
    stub.enqueue(errorReply(429, 'rate_limit_error'), textReply('ok after retry'));
    const r = await provider().complete([{ role: 'user', content: 'x' }], []);
    assert.equal(r.text, 'ok after retry');
    assert.equal(stub.requests.length, 2);
  });

  it('a persistent rate limit or overload becomes a controlled AiProviderError after one retry', async () => {
    stub.enqueue(errorReply(429, 'rate_limit_error'), errorReply(429, 'rate_limit_error'));
    await rejectsWith(provider().complete([{ role: 'user', content: 'x' }], []), /429 rate_limit_error \(request req_stub\)/);
    assert.equal(stub.requests.length, 2);
    stub.reset();
    stub.enqueue(errorReply(529, 'overloaded_error'), errorReply(529, 'overloaded_error'));
    await rejectsWith(provider().complete([{ role: 'user', content: 'x' }], []), /529 overloaded_error/);
  });

  it('does not retry an invalid key', async () => {
    stub.enqueue(errorReply(401, 'authentication_error'));
    await rejectsWith(provider().complete([{ role: 'user', content: 'x' }], []), /401 authentication_error/);
    assert.equal(stub.requests.length, 1);
  });

  it('a timeout becomes an AiProviderError', async () => {
    stub.enqueue({ ...textReply('late'), delayMs: 500 }, { ...textReply('late'), delayMs: 500 });
    await rejectsWith(provider(100).complete([{ role: 'user', content: 'x' }], []), /timed out/);
  });
});
