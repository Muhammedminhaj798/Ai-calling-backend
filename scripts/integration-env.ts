// Environment of the integration-test child processes (scripts/test-integration.ts). DATABASE_URL becomes the verified
// test database, and every external provider is forced to its mock, with placeholder keys in place of real ones: a run
// never bills Claude, OpenAI, Sarvam, Google or LiveKit, whatever .env or the shell select. The application loads .env
// through dotenv, which never replaces a variable that is already set, so these values reach the tests unchanged.
import { VERIFIED_IDENTITY_ENV } from './db-guard.ts';
import { DATABASE_CONFIRMED_SEPARATE_ENV } from '../src/utils/db-identity.ts';

/** Placeholder for every provider key in integration runs. Not a credential. */
export const NO_REAL_KEY = 'integration-tests-no-real-key';

/** Neon exposes a pooled host ending in "-pooler"; migrations must use the direct host behind it. */
export function directUrl(url: string): string {
  const u = new URL(url);
  if (/-pooler\./.test(u.hostname)) u.hostname = u.hostname.replace('-pooler.', '.');
  return u.toString();
}

export function integrationTestEnv(base: Record<string, string | undefined>, testDb: string, identity: string): Record<string, string | undefined> {
  return {
    ...base,
    DATABASE_URL: testDb,
    DIRECT_DATABASE_URL: base['TEST_DIRECT_DATABASE_URL']?.trim() || directUrl(testDb),
    // tests/integration/setup.ts truncates only when this matches the database it is connected to
    [VERIFIED_IDENTITY_ENV]: identity,
    // `prisma migrate deploy` (prisma.config.ts) and the test processes' startup check (config/env.ts) check this database
    // again. checkTestDatabase already proved this identity is not protected, or the user confirmed it
    // (TEST_DATABASE_CONFIRMED_SEPARATE); pass that on so a test database on another host (e.g. localhost) is not
    // refused again. It never unlocks a protected database.
    [DATABASE_CONFIRMED_SEPARATE_ENV]: identity,
    NODE_ENV: 'test',
    LOG_LEVEL: base['LOG_LEVEL'] ?? 'error',
    JWT_SECRET: base['JWT_SECRET'] ?? 'integration-test-secret-not-for-production-0123456789',
    // Every test request comes from 127.0.0.1; only the per-email limit is exercised.
    LOGIN_RATE_LIMIT_PER_IP: '1000000',
    REFRESH_RATE_LIMIT_PER_IP: '1000000',
    // Tests call the expiry sweeper directly; no background timer.
    RESERVATION_SWEEP_INTERVAL_SECONDS: '0',
    // Mock telephony records transfers to this number so handover can be asserted.
    HANDOVER_PHONE_NUMBER: base['HANDOVER_PHONE_NUMBER'] ?? '+919000000000',
    // The suites script the model (scriptedAiProvider) and the recogniser, inspect the synthesiser, drive the mock
    // telephony protocol and seed mock inventory rows: every provider is its mock, never a billed real one.
    AI_PROVIDER: 'mock',
    STT_PROVIDER: 'mock',
    TTS_PROVIDER: 'mock',
    TELEPHONY_PROVIDER: 'mock',
    INVENTORY_ADAPTER: 'mock',
    LIVEKIT_ENABLED: 'false',
    ANTHROPIC_API_KEY: NO_REAL_KEY,
    OPENAI_API_KEY: NO_REAL_KEY,
    SARVAM_API_KEY: NO_REAL_KEY,
    GOOGLE_SPEECH_API_KEY: NO_REAL_KEY,
    LIVEKIT_API_KEY: NO_REAL_KEY,
    LIVEKIT_API_SECRET: NO_REAL_KEY,
  };
}
