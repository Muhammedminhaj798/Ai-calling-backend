// Seed safety: which databases the development seed may write to, the typed confirmation, and that an existing staff
// account is never silently reset. Every URL is fake and the database is an in-memory fake; nothing connects.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { checkSeedTarget, ensureStaffUser, seedConfirmed } from '../scripts/seed-guard.ts';

const DEV = 'postgresql://dev_owner:D3vSecret@ep-dev-branch-111111-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy_dev?sslmode=require';
const TEST = 'postgresql://test_owner:T3stSecret@ep-test-branch-222222.c-2.us-east-2.aws.neon.tech/ai_pharmacy_test?sslmode=require';
const PROD = 'postgresql://prod_owner:Pr0dSecret@ep-prod-endpoint-999999-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy?sslmode=require';
const PROTECTED = 'neon:ep-prod-endpoint-999999/ai_pharmacy';
const dev = { NODE_ENV: 'development', DATABASE_URL: DEV, TEST_DATABASE_URL: TEST, PROTECTED_DATABASE_IDENTITIES: PROTECTED };

function refused(env: Record<string, string | undefined>, pattern: RegExp, samples = false): void {
  const r = checkSeedTarget(env, { samples });
  assert.equal(r.ok, false, 'must refuse');
  if (!r.ok) {
    assert.match(r.reason, pattern);
    assert.doesNotMatch(r.reason, /Secret|_owner|@|neon\.tech|ep-prod-endpoint-999999|ep-dev-branch-111111/, 'only masked identities, never credentials or hosts');
  }
}

describe('checkSeedTarget', () => {
  it('allows an isolated development database and shows only its masked identity', () => {
    const r = checkSeedTarget(dev, { samples: true });
    assert.deepEqual(r, { ok: true, masked: 'neon:ep-dev-…11/ai_pharmacy_dev', database: 'ai_pharmacy_dev' });
  });

  it('refuses NODE_ENV=production', () => {
    refused({ ...dev, NODE_ENV: 'production' }, /never runs in production/);
  });

  it('refuses sample fixtures outside development', () => {
    refused({ ...dev, NODE_ENV: 'test' }, /--samples needs NODE_ENV=development/, true);
    assert.equal(checkSeedTarget({ ...dev, NODE_ENV: 'test' }, { samples: false }).ok, true, 'the admin-only seed is not a sample fixture');
  });

  it('refuses every protected identity, pooled or direct, with any login', () => {
    for (const url of [PROD, PROD.replace('-pooler', ''), PROD.replace('prod_owner:Pr0dSecret', 'other:x')]) {
      refused({ ...dev, DATABASE_URL: url }, /is a protected database/);
    }
    refused({ ...dev, DATABASE_URL: DEV, PROTECTED_DATABASE_IDENTITIES: `${PROTECTED},neon:ep-dev-branch-111111/*` }, /is a protected database/);
  });

  it('refuses to run without protected identities: production protection is incomplete', () => {
    refused({ ...dev, PROTECTED_DATABASE_IDENTITIES: undefined }, /production protection is incomplete/);
    refused({ ...dev, PROTECTED_DATABASE_IDENTITIES: PROD }, /looks like a connection URL/);
  });

  it('refuses the integration-test database', () => {
    refused({ ...dev, DATABASE_URL: TEST.replace('ep-test-branch-222222', 'ep-test-branch-222222-pooler') }, /integration-test database/);
  });

  it('fails closed on an unidentifiable target or test URL', () => {
    refused({ ...dev, DATABASE_URL: 'not a url' }, /DATABASE_URL cannot be identified/);
    refused({ ...dev, DATABASE_URL: undefined }, /DATABASE_URL cannot be identified: not set/);
    refused({ ...dev, TEST_DATABASE_URL: 'mysql://x@y/z' }, /TEST_DATABASE_URL cannot be identified/);
  });

  it('a target that cannot be proven separate from a protected one needs DATABASE_CONFIRMED_SEPARATE', () => {
    const local = { ...dev, DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/ai_pharmacy_dev' };
    refused(local, /cannot prove .* is not a protected database.*DATABASE_CONFIRMED_SEPARATE/);
    assert.equal(checkSeedTarget({ ...local, DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/other' }, { samples: false }).ok, false);
    assert.equal(checkSeedTarget({ ...local, DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/ai_pharmacy_dev' }, { samples: false }).ok, true);
    assert.equal(checkSeedTarget({ ...local, SEED_DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/ai_pharmacy_dev' }, { samples: false }).ok, false, 'the old name no longer unlocks anything');
  });
});

describe('seedConfirmed', () => {
  it('needs the exact database name', () => {
    assert.equal(seedConfirmed(' ai_pharmacy_dev\n', 'ai_pharmacy_dev'), true);
    for (const typed of ['', 'y', 'yes', 'AI_PHARMACY_DEV', 'ai_pharmacy']) assert.equal(seedConfirmed(typed, 'ai_pharmacy_dev'), false, typed);
  });
});

describe('ensureStaffUser', () => {
  function fakeDb(existing: boolean) {
    return {
      staffUser: {
        findUnique: mock.fn(async () => (existing ? { id: 'user-1' } : null)),
        create: mock.fn(async () => ({})),
        update: mock.fn(async () => ({})),
      },
    };
  }
  const admin = { email: 'admin@example.com', name: 'Administrator', role: 'admin' as const, passwordHash: 'new-hash' };

  it('creates a missing account', async () => {
    const db = fakeDb(false);
    assert.equal(await ensureStaffUser(db as never, admin), 'created');
    assert.deepEqual(db.staffUser.create.mock.calls[0]?.arguments, [{ data: admin }]);
  });

  it('leaves an existing account untouched: no password, role or active-flag reset', async () => {
    const db = fakeDb(true);
    assert.equal(await ensureStaffUser(db as never, admin), 'unchanged');
    assert.equal(db.staffUser.update.mock.callCount() + db.staffUser.create.mock.callCount(), 0);
  });

  it('resets an existing account only when explicitly asked (--reset-admin)', async () => {
    const db = fakeDb(true);
    assert.equal(await ensureStaffUser(db as never, admin, { reset: true }), 'reset');
    assert.deepEqual(db.staffUser.update.mock.calls[0]?.arguments, [{ where: { id: 'user-1' }, data: { passwordHash: 'new-hash', role: 'admin', isActive: true } }]);
  });
});
