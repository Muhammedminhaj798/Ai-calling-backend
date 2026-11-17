// Unit tests for the integration-test database guard. Every URL here is fake; nothing connects to a database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkTestDatabase, integrationGate, parseDbIdentity, VERIFIED_IDENTITY_ENV } from '../scripts/db-guard.ts';

const NEON_DIRECT = 'postgresql://app:s3cret@ep-cool-river-123456.c-2.us-east-2.aws.neon.tech/ai_pharmacy?sslmode=require';
const NEON_POOLED = 'postgresql://app:other@ep-cool-river-123456-pooler.c-2.us-east-2.aws.neon.tech:5432/ai_pharmacy?sslmode=require&channel_binding=require';
const NEON_OTHER_ENDPOINT = 'postgresql://app:s3cret@ep-quiet-lake-654321.c-2.us-east-2.aws.neon.tech/ai_pharmacy?sslmode=require';

// A production identity on its own Neon endpoint; every case below runs with it unless it sets its own.
const PROTECTED = 'neon:ep-prod-endpoint-999999/ai_pharmacy';
const withProtected = (env: Record<string, string | undefined>) => ({ PROTECTED_DATABASE_IDENTITIES: PROTECTED, ...env });

const refused = (env: Record<string, string | undefined>, pattern: RegExp) => {
  const r = checkTestDatabase(withProtected(env));
  assert.equal(r.ok, false, 'must refuse');
  if (!r.ok) {
    assert.match(r.reason, pattern);
    assert.doesNotMatch(r.reason, /s3cret|other@|app:/, 'never prints credentials');
  }
};
const allowed = (env: Record<string, string | undefined>) => {
  const r = checkTestDatabase(withProtected(env));
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  return r.ok ? r.identity : '';
};

describe('integration DB guard — refuses the same database', () => {
  it('identical URLs', () => {
    refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: NEON_DIRECT }, /same database as DATABASE_URL/);
  });

  it('Neon pooled versus direct URLs of one endpoint, with different credentials and parameters', () => {
    refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: NEON_POOLED }, /same database as DATABASE_URL \(neon:ep-cool-river-123456\/ai_pharmacy\)/);
    refused({ DATABASE_URL: NEON_POOLED, TEST_DATABASE_URL: NEON_DIRECT }, /same database/);
  });

  it('Neon endpoint given through options=endpoint=… instead of the hostname', () => {
    const viaOptions = 'postgresql://app:x@ep-cool-river-123456.c-2.us-east-2.aws.neon.tech/ai_pharmacy?options=endpoint%3Dep-cool-river-123456';
    refused({ DATABASE_URL: NEON_POOLED, TEST_DATABASE_URL: viaOptions }, /same database/);
  });

  it('hostname case, a trailing dot and the default port do not hide a match', () => {
    refused({ DATABASE_URL: 'postgres://u:p@DB.Example.com./shop', TEST_DATABASE_URL: 'postgresql://u:p@db.example.com:5432/shop' }, /same database/);
    refused({ DATABASE_URL: 'postgresql://u:p@localhost/shop', TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/shop' }, /same database/);
  });

  it('checks DIRECT_DATABASE_URL too, and TEST_DIRECT_DATABASE_URL must be the test database', () => {
    const testDb = NEON_DIRECT.replace('/ai_pharmacy?', '/ai_pharmacy_test?');
    refused({ DATABASE_URL: NEON_OTHER_ENDPOINT, DIRECT_DATABASE_URL: testDb, TEST_DATABASE_URL: testDb }, /same database as DIRECT_DATABASE_URL/);
    refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: testDb, TEST_DIRECT_DATABASE_URL: NEON_DIRECT }, /TEST_DIRECT_DATABASE_URL must point at the same database/);
    allowed({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: testDb.replace('ep-cool-river-123456', 'ep-cool-river-123456-pooler'), TEST_DIRECT_DATABASE_URL: testDb });
  });

  it('a direct URL must not be a Neon pooler, for the test and the application database', () => {
    const testDb = NEON_OTHER_ENDPOINT.replace('/ai_pharmacy', '/ai_pharmacy_test');
    const testPooled = testDb.replace('ep-quiet-lake-654321', 'ep-quiet-lake-654321-pooler');
    refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: testPooled, TEST_DIRECT_DATABASE_URL: testPooled }, /TEST_DIRECT_DATABASE_URL is a Neon "-pooler" host/);
    refused({ DATABASE_URL: NEON_POOLED, DIRECT_DATABASE_URL: NEON_POOLED, TEST_DATABASE_URL: testDb }, /^DIRECT_DATABASE_URL is a Neon "-pooler" host/);
  });

  it('the application pooled and direct URLs must be one database', () => {
    refused({ DATABASE_URL: NEON_DIRECT, DIRECT_DATABASE_URL: NEON_DIRECT.replace('/ai_pharmacy?', '/other?'), TEST_DATABASE_URL: NEON_OTHER_ENDPOINT }, /DIRECT_DATABASE_URL is a different database from DATABASE_URL/);
  });

  it('different logins and parameters on one database are still the same database', () => {
    const otherLogin = NEON_DIRECT.replace('app:s3cret', 'tester:another-password').replace('?sslmode=require', '?sslmode=verify-full&application_name=tests');
    refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: otherLogin }, /same database as DATABASE_URL/);
  });
});

describe('integration DB guard — protected identities (PROTECTED_DATABASE_IDENTITIES)', () => {
  const PROD_POOLED = 'postgresql://prod_owner:Pr0dSecret@ep-prod-endpoint-999999-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy?sslmode=require';
  const noSecrets = (reason: string) => assert.doesNotMatch(reason, /Pr0dSecret|prod_owner|postgresql:|neon\.tech/);

  it('refuses everything while no protected identity is configured: production protection is incomplete', () => {
    for (const value of [undefined, '', ' , ']) {
      const r = checkTestDatabase({ PROTECTED_DATABASE_IDENTITIES: value, DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: NEON_OTHER_ENDPOINT });
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /PROTECTED_DATABASE_IDENTITIES is not set, so production protection is incomplete/);
    }
  });

  it('refuses the production identity as the test database, pooled or direct, with any login', () => {
    for (const url of [PROD_POOLED, PROD_POOLED.replace('-pooler', ''), PROD_POOLED.replace('prod_owner:Pr0dSecret', 'readonly:x')]) {
      const r = checkTestDatabase(withProtected({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: url }));
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.match(r.reason, /is a protected database/);
        noSecrets(r.reason);
      }
    }
  });

  it('no confirmation unlocks a protected database', () => {
    refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: PROD_POOLED, TEST_DATABASE_CONFIRMED_SEPARATE: 'neon:ep-prod-endpoint-999999/ai_pharmacy' }, /is a protected database/);
  });

  it('matches database names case-insensitively and "/*" protects every database on the endpoint', () => {
    const env = { DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: PROD_POOLED.replace('/ai_pharmacy?', '/scratch?') };
    assert.equal(checkTestDatabase({ ...env, PROTECTED_DATABASE_IDENTITIES: 'neon:ep-prod-endpoint-999999/AI_Pharmacy' }).ok, true, 'another database on that endpoint');
    assert.equal(checkTestDatabase({ ...env, PROTECTED_DATABASE_IDENTITIES: 'NEON:ep-prod-endpoint-999999-pooler/*' }).ok, false);
    assert.equal(checkTestDatabase({ ...env, TEST_DATABASE_URL: PROD_POOLED, PROTECTED_DATABASE_IDENTITIES: 'neon:ep-prod-endpoint-999999/AI_PHARMACY' }).ok, false);
  });

  it('refuses a test database that cannot be proven separate from a protected one, unless confirmed', () => {
    const env = { PROTECTED_DATABASE_IDENTITIES: 'host:db.prod.example.com:5432/shop', DATABASE_URL: 'postgresql://u:p@db.dev.example.com:5432/shop', TEST_DATABASE_URL: 'postgresql://u:p@db.dev.example.com:5432/shop_test' };
    const r = checkTestDatabase(env);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /cannot prove TEST_DATABASE_URL .* is not a protected database/);
    assert.equal(checkTestDatabase({ ...env, TEST_DATABASE_CONFIRMED_SEPARATE: 'host:db.dev.example.com:5432/shop_test' }).ok, true);
  });

  it('refuses a malformed or URL-like entry without repeating it', () => {
    for (const value of [PROD_POOLED, 'ep-prod-endpoint-999999/ai_pharmacy', 'neon:ep-prod-endpoint-999999', 'prod_owner:Pr0dSecret@neon:ep-x/db']) {
      const r = checkTestDatabase({ PROTECTED_DATABASE_IDENTITIES: value, DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: NEON_OTHER_ENDPOINT });
      assert.equal(r.ok, false, value);
      if (!r.ok) {
        assert.match(r.reason, /PROTECTED_DATABASE_IDENTITIES entry 1/);
        noSecrets(r.reason);
        assert.ok(!r.reason.includes('ep-prod-endpoint'), 'the entry is never echoed');
      }
    }
  });
});

describe('integration DB guard — allows only provably separate databases', () => {
  it('different database names on the same server', () => {
    const id = allowed({ DATABASE_URL: NEON_DIRECT, DIRECT_DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: NEON_POOLED.replace('/ai_pharmacy?', '/ai_pharmacy_test?') });
    assert.equal(id, 'neon:ep-cool-river-123456/ai_pharmacy_test');
    allowed({ PROTECTED_DATABASE_IDENTITIES: 'loopback:5432/production', DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/dev', TEST_DATABASE_URL: 'postgresql://u:p@localhost/dev_test' });
  });

  it('different Neon endpoints (separate branches or projects)', () => {
    allowed({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: NEON_OTHER_ENDPOINT });
  });
});

describe('integration DB guard — fails closed', () => {
  it('missing TEST_DATABASE_URL or DATABASE_URL', () => {
    refused({ DATABASE_URL: NEON_DIRECT }, /TEST_DATABASE_URL is not set/);
    refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: '   ' }, /TEST_DATABASE_URL is not set/);
    refused({ TEST_DATABASE_URL: NEON_OTHER_ENDPOINT }, /DATABASE_URL is not set/);
  });

  it('unparseable or unidentifiable URLs', () => {
    const cases: Array<[string, RegExp]> = [
      ['not a url', /not a valid URL/],
      ['mysql://u:p@db.example.com/shop', /not a postgres/],
      ['postgresql://u:p@db.example.com', /no single database name/],
      ['postgresql:///shop?host=/var/run/postgresql', /query parameters override the target \(host\)/],
      ['postgresql://u:p@db.example.com/shop?dbname=other', /query parameters override the target \(dbname\)/],
      ['postgresql://u:p@a.example.com,b.example.com/shop', /not a valid URL|multiple hosts/],
      ['postgresql://u:p@db.example.com/sh%ZZop', /percent-encoding/],
    ];
    for (const [url, pattern] of cases) {
      refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: url }, pattern);
      refused({ DATABASE_URL: url, TEST_DATABASE_URL: NEON_DIRECT }, pattern);
    }
  });

  it('unknown identity: different hostnames, ports or loopback versus remote may still be one server', () => {
    refused({ DATABASE_URL: 'postgresql://u:p@db.internal/shop', TEST_DATABASE_URL: 'postgresql://u:p@10.0.0.5/shop_test' }, /cannot prove .* separate/);
    refused({ DATABASE_URL: 'postgresql://u:p@db.example.com:5432/shop', TEST_DATABASE_URL: 'postgresql://u:p@db.example.com:6432/shop' }, /cannot prove/);
    refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/ai_pharmacy' }, /TEST_DATABASE_CONFIRMED_SEPARATE=loopback:5433\/ai_pharmacy/);
  });

  it('an explicit confirmation unlocks only an unknown verdict, and only for that exact test identity', () => {
    const env = { DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/ai_pharmacy_test' };
    refused({ ...env, TEST_DATABASE_CONFIRMED_SEPARATE: 'loopback:5433/some_other_db' }, /cannot prove/);
    assert.equal(allowed({ ...env, TEST_DATABASE_CONFIRMED_SEPARATE: 'loopback:5433/ai_pharmacy_test' }), 'loopback:5433/ai_pharmacy_test');
    refused({ DATABASE_URL: NEON_DIRECT, TEST_DATABASE_URL: NEON_POOLED, TEST_DATABASE_CONFIRMED_SEPARATE: 'neon:ep-cool-river-123456/ai_pharmacy' }, /same database/);
  });

  it('identities never contain credentials', () => {
    assert.deepEqual(parseDbIdentity(NEON_POOLED), { server: 'neon:ep-cool-river-123456', database: 'ai_pharmacy' });
  });
});

describe('integration DB gate in the test helpers', () => {
  const testDb = 'postgresql://u:p@ep-quiet-lake-654321-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy_test';
  it('is closed unless the runner verified this exact database', () => {
    assert.equal(integrationGate({}).available, false);
    assert.equal(integrationGate(withProtected({ TEST_DATABASE_URL: testDb, DATABASE_URL: testDb })).available, false, 'equal URLs alone are not enough');
    assert.equal(integrationGate(withProtected({ TEST_DATABASE_URL: testDb, DATABASE_URL: testDb, [VERIFIED_IDENTITY_ENV]: 'neon:ep-other/ai_pharmacy_test' })).available, false);
    assert.equal(integrationGate(withProtected({ TEST_DATABASE_URL: testDb, DATABASE_URL: NEON_DIRECT, [VERIFIED_IDENTITY_ENV]: 'neon:ep-quiet-lake-654321/ai_pharmacy_test' })).available, false);
    assert.equal(integrationGate(withProtected({ TEST_DATABASE_URL: testDb, DATABASE_URL: testDb, [VERIFIED_IDENTITY_ENV]: 'neon:ep-quiet-lake-654321/ai_pharmacy_test' })).available, true);
  });

  it('stays closed for a protected database or without protected identities, even with the verified identity set by hand', () => {
    const verified = { TEST_DATABASE_URL: testDb, DATABASE_URL: testDb, [VERIFIED_IDENTITY_ENV]: 'neon:ep-quiet-lake-654321/ai_pharmacy_test' };
    assert.equal(integrationGate(verified).available, false, 'no PROTECTED_DATABASE_IDENTITIES');
    assert.equal(integrationGate({ ...verified, PROTECTED_DATABASE_IDENTITIES: 'neon:ep-quiet-lake-654321/*' }).available, false, 'protected');
  });
});
