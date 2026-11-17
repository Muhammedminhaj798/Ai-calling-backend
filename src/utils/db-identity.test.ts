// Migration-URL and test-database checks. Every URL is fake; nothing connects to a database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appSharesTestDatabase, databaseUrlPairProblems, isNeonPooler, maskDbIdentity, migrationDatabaseProblems, parseDbIdentity, parseProtectedIdentities, protectionVerdict, type DbIdentity } from './db-identity.ts';

const DIRECT = 'postgresql://app:s3cret@ep-cool-river-123456.c-2.us-east-2.aws.neon.tech/ai_pharmacy?sslmode=require';
const POOLED = 'postgresql://app:s3cret@ep-cool-river-123456-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy?sslmode=require';
const OTHER_ENDPOINT = 'postgresql://app:s3cret@ep-quiet-lake-654321.c-2.us-east-2.aws.neon.tech/ai_pharmacy';
const LOCAL = 'postgresql://u:p@127.0.0.1:5432/ai_pharmacy_agent';

describe('isNeonPooler', () => {
  it('recognises only the Neon "-pooler" host', () => {
    assert.equal(isNeonPooler(POOLED), true);
    assert.equal(isNeonPooler(DIRECT), false);
    assert.equal(isNeonPooler(LOCAL), false);
    assert.equal(isNeonPooler('not a url'), false);
    assert.equal(isNeonPooler(undefined), false);
  });
});

describe('migrationDatabaseProblems', () => {
  it('accepts a direct URL of the application database', () => {
    assert.deepEqual(migrationDatabaseProblems({ DATABASE_URL: POOLED, DIRECT_DATABASE_URL: DIRECT }), []);
    assert.deepEqual(migrationDatabaseProblems({ DATABASE_URL: LOCAL }), []);
  });

  it('refuses a pooler in DIRECT_DATABASE_URL', () => {
    const problems = migrationDatabaseProblems({ DATABASE_URL: POOLED, DIRECT_DATABASE_URL: POOLED });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /DIRECT_DATABASE_URL is a Neon "-pooler" host/);
  });

  it('refuses migrating through a pooled DATABASE_URL when no direct URL is set', () => {
    assert.match(migrationDatabaseProblems({ DATABASE_URL: POOLED })[0]!, /DATABASE_URL .*in DIRECT_DATABASE_URL/);
  });

  it('refuses a direct URL of another database', () => {
    assert.match(migrationDatabaseProblems({ DATABASE_URL: DIRECT, DIRECT_DATABASE_URL: OTHER_ENDPOINT })[0]!, /different database/);
    assert.match(migrationDatabaseProblems({ DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: LOCAL.replace('ai_pharmacy_agent', 'other') })[0]!, /different database/);
  });

  it('never prints credentials or URLs', () => {
    for (const p of migrationDatabaseProblems({ DATABASE_URL: DIRECT, DIRECT_DATABASE_URL: POOLED.replace('ai_pharmacy', 'x') })) {
      assert.doesNotMatch(p, /s3cret|neon\.tech|postgresql:/);
    }
  });
});

describe('appSharesTestDatabase', () => {
  it('is true for one database, pooled or direct', () => {
    assert.equal(appSharesTestDatabase({ DATABASE_URL: POOLED, TEST_DATABASE_URL: DIRECT }), true);
  });
  it('is false for separate databases or no test database', () => {
    assert.equal(appSharesTestDatabase({ DATABASE_URL: DIRECT, TEST_DATABASE_URL: OTHER_ENDPOINT }), false);
    assert.equal(appSharesTestDatabase({ DATABASE_URL: DIRECT }), false);
  });
});

describe('databaseUrlPairProblems', () => {
  it('treats different logins and parameters on one database as the same database', () => {
    const otherLogin = DIRECT.replace('app:s3cret', 'migrator:x').replace('?sslmode=require', '?sslmode=verify-full');
    assert.deepEqual(databaseUrlPairProblems({ DATABASE_URL: POOLED, DIRECT_DATABASE_URL: otherLogin }, ''), []);
  });

  it('checks the TEST_ pair the same way', () => {
    assert.match(databaseUrlPairProblems({ TEST_DATABASE_URL: POOLED, TEST_DIRECT_DATABASE_URL: POOLED }, 'TEST_')[0]!, /TEST_DIRECT_DATABASE_URL is a Neon "-pooler" host/);
    assert.match(databaseUrlPairProblems({ TEST_DATABASE_URL: 'nope' }, 'TEST_')[0]!, /TEST_DATABASE_URL cannot be identified/);
  });

  it('refuses a pair that cannot be proven to be one database (ambiguous)', () => {
    const problems = databaseUrlPairProblems({ DATABASE_URL: 'postgresql://u:p@pgbouncer.internal:6432/app', DIRECT_DATABASE_URL: 'postgresql://u:p@db.internal:5432/app' }, '');
    assert.match(problems[0]!, /cannot be proven to be the same database/);
  });
});

describe('parseProtectedIdentities', () => {
  it('normalises case and a -pooler suffix, keeps the database name, accepts "*" and several entries', () => {
    const r = parseProtectedIdentities(' NEON:EP-Prod-999999-pooler/ai_pharmacy , host:DB.Example.com:5432/*,loopback:5432/prod ');
    assert.deepEqual(r, {
      ok: true,
      identities: [
        { server: 'neon:ep-prod-999999', database: 'ai_pharmacy' },
        { server: 'host:db.example.com:5432', database: '*' },
        { server: 'loopback:5432', database: 'prod' },
      ],
    });
  });

  it('is empty when unset', () => {
    assert.deepEqual(parseProtectedIdentities(undefined), { ok: true, identities: [] });
  });

  it('refuses URLs, credentials and malformed entries without repeating them', () => {
    for (const bad of [POOLED, 'user:pw@neon:ep-x/db', 'neon:ep-x', 'ep-x/db', 'neon:ep-x/db/extra', 'host:db.example.com/db', 'neon:ep-x/db?sslmode=require']) {
      const r = parseProtectedIdentities(`neon:ep-ok-1/db,${bad}`);
      assert.equal(r.ok, false, bad);
      if (!r.ok) {
        assert.match(r.reason, /entry 2/);
        assert.doesNotMatch(r.reason, /s3cret|pw@|ep-x|ep-cool/);
      }
    }
  });
});

describe('protectionVerdict', () => {
  const id = (url: string) => parseDbIdentity(url) as DbIdentity;
  const prod = parseProtectedIdentities('neon:ep-cool-river-123456/ai_pharmacy');
  const ids = prod.ok ? prod.identities : [];

  it('is same for the protected database through any login, pooled or direct', () => {
    assert.equal(protectionVerdict(id(POOLED), ids), 'same');
    assert.equal(protectionVerdict(id(DIRECT.replace('app:s3cret', 'readonly:x')), ids), 'same');
  });
  it('is separate for another Neon endpoint or another database on it', () => {
    assert.equal(protectionVerdict(id(OTHER_ENDPOINT), ids), 'separate');
    assert.equal(protectionVerdict(id(DIRECT.replace('/ai_pharmacy?', '/scratch?')), ids), 'separate');
  });
  it('is unknown (callers fail closed) when a different host could be the same server', () => {
    assert.equal(protectionVerdict(id(LOCAL), ids), 'unknown');
  });
});

describe('maskDbIdentity', () => {
  it('shortens the endpoint or hostname and keeps the database name', () => {
    assert.equal(maskDbIdentity({ server: 'neon:ep-cool-river-123456', database: 'ai_pharmacy' }), 'neon:ep-cool…56/ai_pharmacy');
    assert.equal(maskDbIdentity({ server: 'host:db.internal.example.com:5432', database: 'app' }), 'host:db.inte…om:5432/app');
    assert.equal(maskDbIdentity({ server: 'loopback:5432', database: 'dev' }), 'loopback:5432/dev');
  });
});
