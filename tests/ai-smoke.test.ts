// Runs scripts/ai-smoke.ts against the local Messages API stub (ANTHROPIC_BASE_URL), never the real API:
// exit codes, what is printed, and that the key never appears in the output.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';
import { errorReply, startAnthropicStub, TEST_API_KEY, textReply } from './fakes/anthropic-stub.ts';

let stub: Awaited<ReturnType<typeof startAnthropicStub>>;
before(async () => {
  stub = await startAnthropicStub();
});
after(() => stub.close());
beforeEach(() => stub.reset());

function runSmoke(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  // ANTHROPIC_BASE_URL always points at the stub, and set (even empty) variables are never replaced by .env.
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/ai-smoke.ts'], {
    env: { ...process.env, ANTHROPIC_BASE_URL: stub.baseUrl, ANTHROPIC_MODEL: 'claude-opus-5-5', ANTHROPIC_EFFORT: 'low', ANTHROPIC_TIMEOUT_MS: '5000', ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

describe('npm run ai:smoke', () => {
  it('sends one text-only request and prints the model and token usage', async () => {
    stub.enqueue(textReply('OK'));
    const r = await runSmoke({ ANTHROPIC_API_KEY: TEST_API_KEY });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PASS {2}Claude API responded/);
    assert.match(r.out, /model: {2}claude-opus-5-5/);
    assert.match(r.out, /tokens: 100 input, 20 output/);
    assert.equal(stub.requests.length, 1);
    const body = stub.requests[0]!.body;
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal('tools' in body, false, 'no pharmacy tools');
    assert.equal(body.messages.length, 1);
    assert.doesNotMatch(r.out, new RegExp(TEST_API_KEY));
  });

  it('exits 1 on an API failure without printing the key or provider details', async () => {
    stub.enqueue(errorReply(401, 'authentication_error'));
    const r = await runSmoke({ ANTHROPIC_API_KEY: TEST_API_KEY });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}Anthropic API error 401 authentication_error/);
    assert.doesNotMatch(r.out, new RegExp(`${TEST_API_KEY}|provider free text|authorization`, 'i'));
  });

  it('exits 2 and sends nothing when the key is not configured', async () => {
    const r = await runSmoke({ ANTHROPIC_API_KEY: '' });
    assert.equal(r.code, 2);
    assert.match(r.out, /ANTHROPIC_API_KEY is not set; no request was sent/);
    assert.equal(stub.requests.length, 0);
  });
});
