// Safety checks of scripts/create-staff-user.ts: target database refusal, input validation, confirmation phrase and
// operator-safe errors. Every URL is fake; nothing connects and the script is never run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { checkTarget, CONFIRMATION_PHRASE, isConfirmed, NEW_USER_ROLE, redactedError, validateNewUser } from '../scripts/staff-user-guard.ts';

const PROD_ID = 'neon:ep-prod-endpoint-999999/ai_pharmacy_agent_test';
const PROD = 'postgresql://prod_owner:Pr0dSecret@ep-prod-endpoint-999999-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy_agent_test?sslmode=require';
const DEV = 'postgresql://dev_owner:D3vSecret@ep-dev-branch-111111.c-2.us-east-2.aws.neon.tech/ai_pharmacy_dev?sslmode=require';
const TEST_DB = 'postgresql://u:secret-pw@ep-test-1234.us-east-2.aws.neon.tech/app_test?sslmode=require';
const LOCAL = 'postgresql://local_owner:L0calSecret@127.0.0.1:5432/ai_pharmacy_dev';
type Env = Record<string, string | undefined>;
const env: Env = { PROTECTED_DATABASE_IDENTITIES: PROD_ID, TEST_DATABASE_URL: TEST_DB };

/** Never in a message or result: passwords, logins, hosts or URLs (every fixture URL has credentials, so "@"). */
const SECRETS = /Secret|secret-pw|_owner|@|neon\.tech|127\.0\.0\.1/;

function refused(url: string, e: Env, pattern: RegExp): void {
  const r = checkTarget(url, e);
  assert.equal(r.ok, false, `must refuse (${pattern})`);
  if (!r.ok) {
    assert.match(r.reason, pattern);
    assert.doesNotMatch(r.reason, SECRETS);
  }
}

describe('checkTarget', () => {
  it('refuses the protected production database, pooled or direct, with any login or a wildcard entry', () => {
    for (const url of [PROD, PROD.replace('-pooler', ''), PROD.replace('prod_owner:Pr0dSecret', 'other:x')]) {
      refused(url, env, /neon:ep-prod-endpoint-999999\/ai_pharmacy_agent_test is a protected database .*staff:create never writes to it/);
    }
    refused(PROD, { ...env, PROTECTED_DATABASE_IDENTITIES: 'neon:ep-prod-endpoint-999999/*' }, /is a protected database/);
  });

  it('has no override: no runtime, migration or separation setting unlocks a protected database', () => {
    const everything = { ...env, NODE_ENV: 'production', ALLOW_PROTECTED_RUNTIME_DATABASE: PROD_ID, ALLOW_PROTECTED_MIGRATE_DEPLOY: PROD_ID, DATABASE_CONFIRMED_SEPARATE: PROD_ID };
    refused(PROD, everything, /is a protected database/);
  });

  it('refuses every target while protection is missing or invalid', () => {
    for (const value of [undefined, '', ' , ']) refused(DEV, { ...env, PROTECTED_DATABASE_IDENTITIES: value }, /production protection is incomplete/);
    refused(DEV, { ...env, PROTECTED_DATABASE_IDENTITIES: PROD }, /entry 1 looks like a connection URL/);
    refused(DEV, { ...env, PROTECTED_DATABASE_IDENTITIES: 'ep-prod-endpoint-999999' }, /entry 1 is not an identity/);
  });

  it('refuses a malformed or unidentifiable URL', () => {
    for (const url of ['', 'not a url', 'mysql://u:Secret@db/app', 'postgresql://u:Secret@db.internal/app?host=/tmp', 'postgresql://u:Secret@/app']) {
      refused(url, env, /the database URL entered cannot be identified/);
    }
  });

  it('refuses the TEST_DATABASE_URL database through its pooled host or other credentials, and an unidentifiable one', () => {
    refused('postgresql://other:pw2@ep-test-1234-pooler.us-east-2.aws.neon.tech/app_test?sslmode=require', env, /is the database configured as TEST_DATABASE_URL/);
    refused(DEV, { ...env, TEST_DATABASE_URL: 'not a url' }, /TEST_DATABASE_URL cannot be identified/);
  });

  it('accepts a provably separate development database, reporting its identity and name only', () => {
    const r = checkTarget(DEV, env);
    assert.deepEqual(r, { ok: true, database: 'ai_pharmacy_dev', identity: 'neon:ep-dev-branch-111111/ai_pharmacy_dev', warnings: [] });
    assert.doesNotMatch(JSON.stringify(r), SECRETS);
  });

  it('accepts a database on another host only once DATABASE_CONFIRMED_SEPARATE names it', () => {
    refused(LOCAL, env, /cannot prove loopback:5432\/ai_pharmacy_dev is not a protected database/);
    assert.equal(checkTarget(LOCAL, { ...env, DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/ai_pharmacy_dev' }).ok, true);
  });

  it('warns when a database outside TEST_DATABASE_URL is named like a test database', () => {
    const r = checkTarget('postgresql://u:p@ep-other-9999.us-east-2.aws.neon.tech/app_test', env);
    assert.ok(r.ok);
    assert.equal(r.warnings.length, 1);
  });
});

describe('redactedError', () => {
  it('removes connection strings and database logins', () => {
    const err = Object.assign(new Error(`password authentication failed for user "neondb_owner" at ${PROD}`), { code: 'P1000' });
    const text = redactedError(err);
    assert.equal(text, 'P1000: password authentication failed for user "<redacted>" at <url>');
    assert.equal(redactedError('boom'), 'error: boom');
  });
});

it('create-staff-user.ts refuses before it loads the database module, and has no other database client', () => {
  const src = readFileSync(new URL('../scripts/create-staff-user.ts', import.meta.url), 'utf8');
  const check = src.indexOf('checkTarget(databaseUrl, process.env)');
  const refusal = src.indexOf('if (!target.ok) stop(2', check);
  const database = src.indexOf("await import('../src/config/db.ts')");
  assert.ok(check > 0 && refusal > check && database > refusal, 'checkTarget, then stop on refusal, then src/config/db.ts');
  assert.doesNotMatch(src, /^import .*config\/db/m, 'no static import of the database module');
  assert.doesNotMatch(src, /new PrismaClient|PrismaPg|from 'pg'/, 'no other database client');
});

describe('validateNewUser', () => {
  const ok = { email: '  Admin@Pharmacy.Example ', name: ' Jane Admin ', password: 'correct horse battery', confirmPassword: 'correct horse battery' };

  it('normalises like the login form and keeps the password as typed', () => {
    const r = validateNewUser(ok);
    assert.ok(r.ok);
    assert.deepEqual(r.user, { email: 'admin@pharmacy.example', name: 'Jane Admin', password: 'correct horse battery' });
  });

  it('rejects mismatched, short or overlong passwords, bad emails and empty names without echoing values', () => {
    const cases = [
      { ...ok, confirmPassword: 'something else entirely' },
      { ...ok, password: 'short-pw', confirmPassword: 'short-pw' },
      { ...ok, password: 'x'.repeat(201), confirmPassword: 'x'.repeat(201) },
      { ...ok, email: 'not-an-email' },
      { ...ok, name: '   ' },
    ];
    for (const input of cases) {
      const r = validateNewUser(input);
      assert.equal(r.ok, false);
      const reason = (r as { reason: string }).reason;
      assert.ok(!reason.includes(input.password) && !reason.includes('not-an-email'), reason);
    }
  });
});

it('creates role admin and needs the exact confirmation phrase', () => {
  assert.equal(NEW_USER_ROLE, 'admin');
  assert.equal(isConfirmed(CONFIRMATION_PHRASE), true);
  for (const typed of ['create this one production user', 'CREATE THIS ONE PRODUCTION USER ', 'yes', '']) assert.equal(isConfirmed(typed), false);
});
