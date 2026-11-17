// Integration-test database guard. Integration tests truncate every table, so they may only ever touch a
// database that is provably not the application's. Identity is derived from the connection URLs alone — no
// connection is opened — and anything that cannot be proven separate is refused (fail closed).
//
//   same      same server and same database (e.g. a Neon pooled and a direct URL of one endpoint) → refuse
//   separate  same server with another database name, or two different Neon endpoints → allow
//   unknown   anything else (unparseable URL, socket or parameter-routed host, two different hostnames that
//             could be one server behind a DNS alias, IP, proxy or tunnel) → refuse, unless the operator
//             confirms this exact test identity with TEST_DATABASE_CONFIRMED_SEPARATE.
//
// The test database must also not be any identity in PROTECTED_DATABASE_IDENTITIES (production is not in the local
// environment, so the guard cannot otherwise know it). Without that setting nothing runs: production protection is
// incomplete. A protected match is never overridable; an unprovable one needs the same confirmation as above.
//
// URL identity (parseDbIdentity and friends) lives in src/utils/db-identity.ts, shared with the server's startup
// checks and the Prisma Migrate check; it is re-exported here for existing callers.
import {
  compareDbIdentity,
  databaseUrlPairProblems,
  formatDbIdentity,
  parseDbIdentity,
  parseProtectedIdentities,
  PROTECTION_INCOMPLETE,
  protectionVerdict,
} from '../src/utils/db-identity.ts';

export { compareDbIdentity, formatDbIdentity, parseDbIdentity, type DbIdentity, type Verdict } from '../src/utils/db-identity.ts';

export type GuardResult = { ok: true; identity: string } | { ok: false; reason: string };

/** Decides whether TEST_DATABASE_URL may be migrated and truncated, given the application's database URLs. */
export function checkTestDatabase(env: Record<string, string | undefined>): GuardResult {
  const protectedIds = parseProtectedIdentities(env['PROTECTED_DATABASE_IDENTITIES']);
  if (!protectedIds.ok) return { ok: false, reason: protectedIds.reason };
  if (protectedIds.identities.length === 0) return { ok: false, reason: PROTECTION_INCOMPLETE };
  if (!env['TEST_DATABASE_URL']?.trim()) return { ok: false, reason: 'TEST_DATABASE_URL is not set' };
  const test = parseDbIdentity(env['TEST_DATABASE_URL']);
  if ('error' in test) return { ok: false, reason: `TEST_DATABASE_URL identity cannot be verified: ${test.error}` };
  const identity = formatDbIdentity(test);
  const confirmed = env['TEST_DATABASE_CONFIRMED_SEPARATE']?.trim() === identity;

  if (!env['DATABASE_URL']?.trim()) return { ok: false, reason: 'DATABASE_URL is not set, so the test database cannot be proven separate from it' };
  for (const name of ['DATABASE_URL', 'DIRECT_DATABASE_URL']) {
    if (name === 'DIRECT_DATABASE_URL' && !env[name]?.trim()) continue;
    const app = parseDbIdentity(env[name]);
    if ('error' in app) return { ok: false, reason: `${name} identity cannot be verified: ${app.error}` };
    const verdict = compareDbIdentity(test, app);
    if (verdict === 'same') return { ok: false, reason: `TEST_DATABASE_URL is the same database as ${name} (${identity})` };
    if (verdict === 'unknown' && !confirmed) {
      return {
        ok: false,
        reason: `cannot prove TEST_DATABASE_URL (${identity}) is separate from ${name} (${formatDbIdentity(app)}): different hosts may still be one server. ` +
          `If you have verified it is a dedicated test database, set TEST_DATABASE_CONFIRMED_SEPARATE=${identity}`,
      };
    }
  }

  // Migrations use TEST_DIRECT_DATABASE_URL when set; it must be the test database itself, never another one.
  if (env['TEST_DIRECT_DATABASE_URL']?.trim()) {
    const direct = parseDbIdentity(env['TEST_DIRECT_DATABASE_URL']);
    if ('error' in direct || compareDbIdentity(test, direct) !== 'same') {
      return { ok: false, reason: 'TEST_DIRECT_DATABASE_URL must point at the same database as TEST_DATABASE_URL' };
    }
  }

  // Each environment's pooled and direct URLs must be one database, and a direct URL must not be a Neon pooler.
  const pairProblems = [...databaseUrlPairProblems(env, ''), ...databaseUrlPairProblems(env, 'TEST_')];
  if (pairProblems.length > 0) return { ok: false, reason: pairProblems.join('; ') };

  // Never a protected database. TEST_DIRECT_DATABASE_URL is the same database as TEST_DATABASE_URL (checked above).
  const verdict = protectionVerdict(test, protectedIds.identities);
  if (verdict === 'same') return { ok: false, reason: `TEST_DATABASE_URL (${identity}) is a protected database (PROTECTED_DATABASE_IDENTITIES)` };
  if (verdict === 'unknown' && !confirmed) {
    return {
      ok: false,
      reason: `cannot prove TEST_DATABASE_URL (${identity}) is not a protected database: different hosts may still be one server. ` +
        `If you have verified it is a dedicated test database, set TEST_DATABASE_CONFIRMED_SEPARATE=${identity}`,
    };
  }
  return { ok: true, identity };
}

/** Env var the runner sets after checkTestDatabase passes; the test helpers truncate only when it matches. */
export const VERIFIED_IDENTITY_ENV = 'INTEGRATION_TEST_DB_IDENTITY';

/**
 * Gate for tests/integration/setup.ts: inside the runner DATABASE_URL is the verified test database. Re-checks the
 * protected identities, so setting the verified-identity variable by hand never opens a protected database.
 */
export function integrationGate(env: Record<string, string | undefined>): { available: boolean; reason: string } {
  const testDb = env['TEST_DATABASE_URL'];
  if (!testDb) return { available: false, reason: 'TEST_DATABASE_URL not set — run `npm run test:integration` with a dedicated PostgreSQL test database' };
  const protectedIds = parseProtectedIdentities(env['PROTECTED_DATABASE_IDENTITIES']);
  if (!protectedIds.ok || protectedIds.identities.length === 0) return { available: false, reason: protectedIds.ok ? PROTECTION_INCOMPLETE : protectedIds.reason };
  const test = parseDbIdentity(testDb);
  if ('error' in test || protectionVerdict(test, protectedIds.identities) === 'same') return { available: false, reason: 'the test database is not identifiable or is protected' };
  const verified = env['DATABASE_URL'] === testDb && env[VERIFIED_IDENTITY_ENV] === formatDbIdentity(test);
  return verified
    ? { available: true, reason: '' }
    : { available: false, reason: 'test database not verified by the guard — run through `npm run test:integration`' };
}
