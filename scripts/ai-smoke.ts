// Live Claude API smoke test: one text-only request through the production Anthropic adapter. No tools, no
// database, no orders, no inventory. Prints the outcome, model and token usage, never the key or any header.
//   npm run ai:smoke          reads ANTHROPIC_API_KEY (+ optional ANTHROPIC_MODEL / _EFFORT / _TIMEOUT_MS)
//                             from the environment or .env; the shell wins
// Exit codes: 0 success · 1 API failure · 2 not configured (no request is sent).
import { config as loadEnv } from 'dotenv';
import { ANTHROPIC_DEFAULTS, ANTHROPIC_EFFORTS, createAnthropicProvider, type AnthropicEffort } from '../src/integrations/ai/anthropic.adapter.ts';

loadEnv({ quiet: true });

function notConfigured(message: string): never {
  console.error(`FAIL  ${message}; no request was sent.`);
  process.exit(2);
}

const apiKey = process.env['ANTHROPIC_API_KEY']?.trim();
const model = process.env['ANTHROPIC_MODEL']?.trim() || ANTHROPIC_DEFAULTS.model;
const effort = (process.env['ANTHROPIC_EFFORT']?.trim() || ANTHROPIC_DEFAULTS.effort) as AnthropicEffort;
const timeoutMs = Number(process.env['ANTHROPIC_TIMEOUT_MS']?.trim() || ANTHROPIC_DEFAULTS.timeoutMs);

if (!apiKey) notConfigured('ANTHROPIC_API_KEY is not set');
if (!ANTHROPIC_EFFORTS.includes(effort)) notConfigured(`ANTHROPIC_EFFORT must be one of ${ANTHROPIC_EFFORTS.join(', ')}`);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) notConfigured('ANTHROPIC_TIMEOUT_MS must be an integer from 1000 to 120000');

console.log(`Claude API smoke test: model ${model}, effort ${effort}, timeout ${timeoutMs} ms`);
const started = Date.now();
try {
  const reply = await createAnthropicProvider({ apiKey, model, effort, timeoutMs }).complete(
    [{ role: 'user', content: 'Connectivity check from a backend smoke test. Reply with the single word OK.' }],
    [],
  );
  if (!reply.text) throw new Error('Claude returned no text');
  console.log(`PASS  Claude API responded in ${Date.now() - started} ms`);
  console.log(`      model:  ${reply.model}`);
  console.log(`      tokens: ${reply.usage.inputTokens} input, ${reply.usage.outputTokens} output`);
  console.log(`      reply:  ${JSON.stringify(reply.text.trim().slice(0, 80))}`);
} catch (err) {
  // AiProviderError messages carry only status, error type and request id; the cause is never printed.
  console.error(`FAIL  ${err instanceof Error ? err.message : 'unknown error'} (after ${Date.now() - started} ms)`);
  process.exit(1);
}
