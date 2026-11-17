// Startup configuration rules: production refuses simulated or unset providers and the test database; development
// and tests keep the mocks. parseEnv is pure, so every case passes its own variables; nothing reads .env here.
import '../../tests/env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnv } from './env.ts';

const SECRET_URL = 'postgresql://app:Sup3rSecretPw@ep-cool-river-123456-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy';
/** The (fake) protected production database and its identity. */
const PROD_URL = 'postgresql://prod_owner:Pr0dSecret@ep-prod-endpoint-999999-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy_agent_test?sslmode=require';
const PROD_ID = 'neon:ep-prod-endpoint-999999/ai_pharmacy_agent_test';
const base = { DATABASE_URL: SECRET_URL, JWT_SECRET: 'x'.repeat(40), PROTECTED_DATABASE_IDENTITIES: PROD_ID };
/** A production configuration with every provider real and inventory set explicitly. */
const production = {
  ...base,
  NODE_ENV: 'production',
  AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-ant-test-key',
  STT_PROVIDER: 'sarvam',
  TTS_PROVIDER: 'sarvam',
  SARVAM_API_KEY: 'sarvam-test-key',
  TELEPHONY_PROVIDER: 'none',
  INVENTORY_ADAPTER: 'mock',
};

function refused(raw: Record<string, string | undefined>, pattern: RegExp): string {
  const r = parseEnv(raw);
  assert.equal(r.ok, false, 'must refuse');
  const error = r.ok ? '' : r.error;
  assert.match(error, pattern);
  for (const secret of ['Sup3rSecretPw', 'sk-ant-test-key', 'sarvam-test-key', SECRET_URL, 'Pr0dSecret', 'prod_owner', 'L0calSecret', '.neon.tech', '127.0.0.1']) {
    assert.ok(!error.includes(secret), `never prints a secret, login, host or URL (${secret})`);
  }
  return error;
}

describe('parseEnv — production providers', () => {
  it('accepts real providers with telephony "none" and explicit mock inventory, warning about the inventory', () => {
    const r = parseEnv(production);
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    if (r.ok) {
      assert.equal(r.env.TELEPHONY_PROVIDER, 'none');
      assert.ok(r.warnings.some((w) => /INVENTORY_ADAPTER=mock/.test(w)));
    }
  });

  for (const name of ['AI_PROVIDER', 'STT_PROVIDER', 'TTS_PROVIDER', 'TELEPHONY_PROVIDER'] as const) {
    it(`refuses ${name}=mock`, () => {
      refused({ ...production, [name]: 'mock' }, new RegExp(`${name} is "mock" or not set`));
    });
    it(`refuses an unset ${name} instead of defaulting to mock`, () => {
      refused({ ...production, [name]: undefined }, new RegExp(`${name} is "mock" or not set`));
    });
  }

  it('names every unsafe provider at once', () => {
    const error = refused({ ...base, NODE_ENV: 'production', INVENTORY_ADAPTER: 'mock' }, /AI_PROVIDER/);
    for (const name of ['STT_PROVIDER', 'TTS_PROVIDER', 'TELEPHONY_PROVIDER']) assert.match(error, new RegExp(name));
  });

  it('refuses an unset INVENTORY_ADAPTER: no silent default in production', () => {
    refused({ ...production, INVENTORY_ADAPTER: undefined }, /INVENTORY_ADAPTER must be set explicitly/);
    refused({ ...production, INVENTORY_ADAPTER: '  ' }, /INVENTORY_ADAPTER/);
  });

  it('still requires the key of a real provider', () => {
    refused({ ...production, ANTHROPIC_API_KEY: undefined }, /ANTHROPIC_API_KEY is required/);
  });

  it('refuses running on the integration-test database, without printing either URL', () => {
    const pooledAndDirect = SECRET_URL.replace('-pooler', '');
    refused({ ...production, TEST_DATABASE_URL: pooledAndDirect }, /same database as TEST_DATABASE_URL/);
  });

  it('refuses a pooler DIRECT_DATABASE_URL or one of another database', () => {
    refused({ ...production, DIRECT_DATABASE_URL: SECRET_URL }, /DIRECT_DATABASE_URL is a Neon "-pooler" host/);
    refused({ ...production, DIRECT_DATABASE_URL: SECRET_URL.replace('-pooler', '').replace('/ai_pharmacy', '/other') }, /DIRECT_DATABASE_URL is a different database/);
    assert.equal(parseEnv({ ...production, DIRECT_DATABASE_URL: SECRET_URL.replace('-pooler', '') }).ok, true, 'the direct URL of the same database');
  });

  it('lets an invalid value fail without echoing it', () => {
    refused({ ...production, DATABASE_URL: 'mysql://root:Sup3rSecretPw@db/x' }, /DATABASE_URL/);
  });
});

describe('parseEnv — development and tests keep the mocks', () => {
  it('development defaults every provider to mock', () => {
    const r = parseEnv({ ...base, NODE_ENV: 'development' });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual([r.env.AI_PROVIDER, r.env.STT_PROVIDER, r.env.TTS_PROVIDER, r.env.TELEPHONY_PROVIDER, r.env.INVENTORY_ADAPTER], ['mock', 'mock', 'mock', 'mock', 'mock']);
      assert.deepEqual(r.warnings, []);
    }
  });

  it('test accepts explicit mocks', () => {
    assert.equal(parseEnv({ ...base, NODE_ENV: 'test', AI_PROVIDER: 'mock', TELEPHONY_PROVIDER: 'mock' }).ok, true);
  });

  it('development on the test database starts with a warning, not an error', () => {
    const r = parseEnv({ ...base, NODE_ENV: 'development', TEST_DATABASE_URL: SECRET_URL });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.warnings.some((w) => /same database as TEST_DATABASE_URL/.test(w)));
      assert.ok(r.warnings.every((w) => !w.includes('Sup3rSecretPw')));
    }
  });

  it('development with a pooler DIRECT_DATABASE_URL starts with a warning', () => {
    const r = parseEnv({ ...base, NODE_ENV: 'development', DIRECT_DATABASE_URL: SECRET_URL });
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(r.warnings.some((w) => /DIRECT_DATABASE_URL is a Neon "-pooler" host/.test(w) && !w.includes('Sup3rSecretPw')));
  });

  it('the integration runner (NODE_ENV=test, DATABASE_URL = TEST_DATABASE_URL) is not warned', () => {
    const r = parseEnv({ ...base, NODE_ENV: 'test', TEST_DATABASE_URL: SECRET_URL });
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.warnings, []);
  });

  it('rejects an unknown telephony provider', () => {
    refused({ ...base, NODE_ENV: 'development', TELEPHONY_PROVIDER: 'twilio' }, /TELEPHONY_PROVIDER/);
  });
});

// parseEnv runs in env.ts before any PrismaClient exists (config/db.ts imports env.ts), so these are the startup rules of
// the API, the voice worker and its job processes. tests/startup-protection.test.ts starts both entry points for real.
describe('parseEnv — protected database at startup', () => {
  const dev = { ...base, NODE_ENV: 'development' };
  const prodDb = { DATABASE_URL: PROD_URL };
  const LOCAL = 'postgresql://local_owner:L0calSecret@127.0.0.1:5432/ai_pharmacy_dev';
  const ok = (raw: Record<string, string | undefined>) => {
    const r = parseEnv(raw);
    assert.equal(r.ok, true, r.ok ? '' : r.error);
  };

  it('development and test refuse the protected production database, through any URL form or login', () => {
    const forms = [PROD_URL, PROD_URL.replace('-pooler', ''), PROD_URL.replace('prod_owner:Pr0dSecret', 'readonly:x')];
    for (const NODE_ENV of ['development', 'test']) {
      for (const DATABASE_URL of forms) {
        refused({ ...dev, NODE_ENV, DATABASE_URL }, new RegExp(`DATABASE_URL is the protected database neon:ep-prod-endpoint-999999/ai_pharmacy_agent_test .*${NODE_ENV} never connects to it`));
      }
    }
    refused({ ...dev, ...prodDb, PROTECTED_DATABASE_IDENTITIES: 'neon:ep-prod-endpoint-999999/*' }, /is the protected database/);
  });

  it('refuses to start without protection configured, in every environment', () => {
    for (const env of [dev, { ...dev, NODE_ENV: 'test' }, production]) {
      for (const value of [undefined, '', ' , ']) refused({ ...env, PROTECTED_DATABASE_IDENTITIES: value }, /production protection is incomplete/);
    }
  });

  it('refuses an invalid protection list without repeating it', () => {
    refused({ ...dev, PROTECTED_DATABASE_IDENTITIES: PROD_URL }, /entry 1 looks like a connection URL/);
    refused({ ...dev, PROTECTED_DATABASE_IDENTITIES: `${PROD_ID},ep-prod-endpoint-999999` }, /entry 2 is not an identity/);
  });

  it('refuses a DATABASE_URL whose target cannot be identified', () => {
    refused({ ...dev, DATABASE_URL: 'postgresql://u:Sup3rSecretPw@db.internal:5432/app?host=/var/run/postgresql' }, /DATABASE_URL cannot be identified: query parameters override the target/);
    refused({ ...dev, DATABASE_URL: 'postgresql://u:Sup3rSecretPw@/app' }, /DATABASE_URL cannot be identified/);
  });

  it('starts on a provably separate development database, and on localhost only once confirmed', () => {
    ok(dev);
    refused({ ...dev, DATABASE_URL: LOCAL }, /cannot prove loopback:5432\/ai_pharmacy_dev is not a protected database \(DATABASE_URL\)/);
    refused({ ...dev, DATABASE_URL: LOCAL, DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/other' }, /cannot prove/);
    ok({ ...dev, DATABASE_URL: LOCAL, DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/ai_pharmacy_dev' });
    refused({ ...dev, DATABASE_URL: LOCAL, PROTECTED_DATABASE_IDENTITIES: 'loopback:5432/ai_pharmacy_dev', DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/ai_pharmacy_dev' }, /is the protected database/);
  });

  it('production uses the protected database only with ALLOW_PROTECTED_RUNTIME_DATABASE set to its exact identity', () => {
    refused({ ...production, ...prodDb }, new RegExp(`production may use it only with ALLOW_PROTECTED_RUNTIME_DATABASE=${PROD_ID}`));
    ok({ ...production, ...prodDb, ALLOW_PROTECTED_RUNTIME_DATABASE: PROD_ID });
    ok({ ...production, ...prodDb, ALLOW_PROTECTED_RUNTIME_DATABASE: ` ${PROD_ID} ` });
  });

  it('accepts no wildcard, other identity, URL or the migration authorisation in its place', () => {
    for (const value of ['*', 'true', '1', 'neon:ep-prod-endpoint-999999/*', 'neon:ep-prod-endpoint-999999-pooler/ai_pharmacy_agent_test', PROD_ID.toUpperCase(), 'neon:ep-cool-river-123456/ai_pharmacy', PROD_URL]) {
      refused({ ...production, ...prodDb, ALLOW_PROTECTED_RUNTIME_DATABASE: value }, /ALLOW_PROTECTED_RUNTIME_DATABASE does not name DATABASE_URL's database/);
    }
    refused({ ...production, ...prodDb, ALLOW_PROTECTED_MIGRATE_DEPLOY: PROD_ID }, /production may use it only with ALLOW_PROTECTED_RUNTIME_DATABASE=/);
  });

  it('pins production to the authorised database: set for production, it refuses any other DATABASE_URL', () => {
    ok(production);
    refused({ ...production, ALLOW_PROTECTED_RUNTIME_DATABASE: PROD_ID }, /does not name DATABASE_URL's database \(neon:ep-cool-river-123456\/ai_pharmacy\)/);
  });

  it('cannot be enabled outside production, even with the exact identity', () => {
    for (const NODE_ENV of ['development', 'test']) {
      refused({ ...dev, ...prodDb, NODE_ENV, ALLOW_PROTECTED_RUNTIME_DATABASE: PROD_ID }, new RegExp(`ALLOW_PROTECTED_RUNTIME_DATABASE is set but NODE_ENV is ${NODE_ENV}; it is honoured only in production`));
      refused({ ...dev, NODE_ENV, ALLOW_PROTECTED_RUNTIME_DATABASE: PROD_ID }, /honoured only in production/);
    }
    refused({ ...dev, ...prodDb, NODE_ENV: undefined, ALLOW_PROTECTED_RUNTIME_DATABASE: PROD_ID }, /NODE_ENV is development; it is honoured only in production/);
  });
});
