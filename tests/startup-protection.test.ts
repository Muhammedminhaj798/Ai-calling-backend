// Starts the real entry points, the API (src/server.ts) and the LiveKit voice worker (src/voice-worker.ts start), with
// DATABASE_URL set to a protected database, and checks that each exits during startup with the refusal. Both load
// config/env.ts before config/db.ts creates a PrismaClient, so the refusal comes before any connection. Nothing real is
// reachable even if the check broke: the "protected" database is a fake on 127.0.0.1:9 (nothing listens), .env is not
// loaded (DOTENV_CONFIG_PATH points nowhere), every provider is its mock, and LiveKit points at the same dead port.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const PROTECTED_URL = 'postgresql://prod_owner:Pr0dSecret@127.0.0.1:9/protected_production';
const PROTECTED_ID = 'loopback:9/protected_production';

/** Only what Node and tsx need on this machine, then placeholders; no variable of the developer's shell leaks in. */
const childEnv = (overrides: Record<string, string>): Record<string, string> => ({
  ...Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]]))),
  DOTENV_CONFIG_PATH: 'startup-protection-test-no-such-file.env',
  DOTENV_PATH: 'startup-protection-test-no-such-file.env',
  NODE_ENV: 'development',
  DATABASE_URL: PROTECTED_URL,
  DIRECT_DATABASE_URL: '',
  TEST_DATABASE_URL: '',
  PROTECTED_DATABASE_IDENTITIES: PROTECTED_ID,
  JWT_SECRET: 'startup-protection-test-secret-0123456789',
  PORT: '45999',
  RESERVATION_SWEEP_INTERVAL_SECONDS: '0',
  AI_PROVIDER: 'mock',
  STT_PROVIDER: 'mock',
  TTS_PROVIDER: 'mock',
  TELEPHONY_PROVIDER: 'mock',
  INVENTORY_ADAPTER: 'mock',
  LIVEKIT_ENABLED: 'false',
  LIVEKIT_URL: 'ws://127.0.0.1:9',
  LIVEKIT_API_KEY: 'placeholder',
  LIVEKIT_API_SECRET: 'placeholder',
  LIVEKIT_AGENT_NAME: 'startup-protection-test',
  ...overrides,
});

function start(entry: string[], overrides: Record<string, string> = {}): { code: number | null; out: string } {
  // One process (node --import tsx), so a timeout kills everything it started.
  const r = spawnSync(process.execPath, ['--import', 'tsx', ...entry], { env: childEnv(overrides), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.error, undefined, `${entry[0]} must exit by itself (it did not: ${String(r.error)})`);
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function assertRefused(entry: string[], pattern: RegExp, overrides?: Record<string, string>): void {
  const { code, out } = start(entry, overrides);
  assert.equal(code, 1, `${entry[0]} exits with 1`);
  assert.match(out, /Invalid environment configuration/);
  assert.match(out, pattern);
  assert.doesNotMatch(out, /Pr0dSecret|prod_owner|127\.0\.0\.1|postgres(ql)?:\/\//, 'no credentials, host or URL in the output');
  assert.doesNotMatch(out, /server\.listening|registered worker/, 'never got as far as serving');
}

const ENTRY_POINTS = { 'API (src/server.ts)': ['src/server.ts'], 'voice worker (src/voice-worker.ts start)': ['src/voice-worker.ts', 'start'] };

describe('startup protection of the real entry points', () => {
  for (const [name, entry] of Object.entries(ENTRY_POINTS)) {
    it(`${name} refuses to start in development on the protected database`, () => {
      assertRefused(entry, /DATABASE_URL is the protected database loopback:9\/protected_production \(PROTECTED_DATABASE_IDENTITIES\); development never connects to it/);
    });

    it(`${name} refuses to start without protection configured`, () => {
      assertRefused(entry, /production protection is incomplete/, { PROTECTED_DATABASE_IDENTITIES: '' });
    });

    it(`${name} refuses the production authorisation outside production`, () => {
      assertRefused(entry, /ALLOW_PROTECTED_RUNTIME_DATABASE is set but NODE_ENV is development/, { ALLOW_PROTECTED_RUNTIME_DATABASE: PROTECTED_ID });
    });
  }
});
