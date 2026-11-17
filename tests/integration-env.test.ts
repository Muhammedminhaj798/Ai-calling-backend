// The integration runner's child environment: the verified test database, every provider forced to its mock and no
// real key, even when .env or the shell select real providers. Nothing is spawned and nothing connects.
import '../tests/env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import dotenv from 'dotenv';
import { integrationTestEnv, NO_REAL_KEY } from '../scripts/integration-env.ts';
import { VERIFIED_IDENTITY_ENV } from '../scripts/db-guard.ts';
import { checkPrismaCommand } from '../scripts/prisma-guard.ts';
import { parseEnv } from '../src/config/env.ts';
import { isNeonPooler, migrationDatabaseProblems } from '../src/utils/db-identity.ts';

const TEST_POOLED = 'postgresql://t:p@ep-test-branch-222222-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy_test?sslmode=require';
const REAL = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://d:p@ep-dev-branch-111111-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy_dev?sslmode=require',
  JWT_SECRET: 'x'.repeat(40),
  AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-ant-REAL-KEY',
  OPENAI_API_KEY: 'sk-REAL-OPENAI',
  STT_PROVIDER: 'sarvam',
  TTS_PROVIDER: 'sarvam',
  SARVAM_API_KEY: 'REAL-SARVAM',
  TELEPHONY_PROVIDER: 'none',
  INVENTORY_ADAPTER: 'client_api',
  LIVEKIT_ENABLED: 'true',
  LIVEKIT_API_SECRET: 'REAL-LIVEKIT-SECRET',
  TEST_DATABASE_URL: TEST_POOLED,
  PROTECTED_DATABASE_IDENTITIES: 'neon:ep-prod-endpoint-999999/*',
};
const env = integrationTestEnv(REAL, TEST_POOLED, 'neon:ep-test-branch-222222/ai_pharmacy_test');

describe('integration runner environment', () => {
  it('forces AI_PROVIDER=mock and every other provider to its mock', () => {
    assert.deepEqual(
      [env['AI_PROVIDER'], env['STT_PROVIDER'], env['TTS_PROVIDER'], env['TELEPHONY_PROVIDER'], env['INVENTORY_ADAPTER'], env['LIVEKIT_ENABLED'], env['NODE_ENV']],
      ['mock', 'mock', 'mock', 'mock', 'mock', 'false', 'test'],
    );
  });

  it('carries no real provider key', () => {
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SARVAM_API_KEY', 'GOOGLE_SPEECH_API_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) assert.equal(env[name], NO_REAL_KEY, name);
    assert.ok(!Object.values(env).some((v) => typeof v === 'string' && /REAL/.test(v)), 'no real value survives');
  });

  it('.env cannot bring a real key or provider back (dotenv never overrides a set variable)', () => {
    const child = { ...env };
    dotenv.populate(child as Record<string, string>, dotenv.parse('AI_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-REAL-KEY\nSTT_PROVIDER=sarvam\n'));
    assert.deepEqual([child['AI_PROVIDER'], child['ANTHROPIC_API_KEY'], child['STT_PROVIDER']], ['mock', NO_REAL_KEY, 'mock']);
  });

  it('the child configuration validates with mock providers only', () => {
    const r = parseEnv(env);
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    if (r.ok) assert.deepEqual([r.env.AI_PROVIDER, r.env.STT_PROVIDER, r.env.TTS_PROVIDER, r.env.TELEPHONY_PROVIDER, r.env.LIVEKIT_ENABLED], ['mock', 'mock', 'mock', 'mock', false]);
  });

  it('points DATABASE_URL at the verified test database and migrations at its direct endpoint', () => {
    assert.equal(env['DATABASE_URL'], TEST_POOLED);
    assert.equal(env[VERIFIED_IDENTITY_ENV], 'neon:ep-test-branch-222222/ai_pharmacy_test');
    assert.equal(isNeonPooler(env['DIRECT_DATABASE_URL']), false);
    assert.deepEqual(migrationDatabaseProblems(env), [], 'prisma.config.ts accepts it');
  });

  it('passes the Prisma command guard and the startup check, without ever unlocking a protected database', () => {
    assert.deepEqual(checkPrismaCommand(['migrate', 'deploy'], env), { ok: true });
    const local = integrationTestEnv(REAL, 'postgresql://u:p@127.0.0.1:5432/ai_pharmacy_test', 'loopback:5432/ai_pharmacy_test');
    assert.deepEqual(checkPrismaCommand(['migrate', 'deploy'], local), { ok: true }, 'a localhost test database the runner verified');
    assert.equal(parseEnv(local).ok, true, 'and its test processes start');
    const prod = integrationTestEnv(REAL, 'postgresql://u:p@ep-prod-endpoint-999999-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy', 'neon:ep-prod-endpoint-999999/ai_pharmacy');
    assert.equal(checkPrismaCommand(['migrate', 'deploy'], prod).ok, false);
    assert.equal(parseEnv(prod).ok, false, 'a protected database is refused at startup too');
  });
});
