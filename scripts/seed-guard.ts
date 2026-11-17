// Safety checks and the staff-account write for prisma/seed.ts (tested in tests/seed-guard.test.ts). The seed writes
// only to an isolated development database: never under NODE_ENV=production, never to a protected identity
// (PROTECTED_DATABASE_IDENTITIES) or the integration-test database, and never without a known target. Messages show
// masked identities only, never URLs or credentials.
import type { Prisma } from '../src/generated/prisma/client.ts';
import type { StaffRole } from '../src/generated/prisma/enums.ts';
import {
  compareDbIdentity,
  DATABASE_CONFIRMED_SEPARATE_ENV,
  formatDbIdentity,
  maskDbIdentity,
  parseDbIdentity,
  parseProtectedIdentities,
  PROTECTION_INCOMPLETE,
  protectionVerdict,
} from '../src/utils/db-identity.ts';

export type SeedTarget = { ok: true; masked: string; database: string } | { ok: false; reason: string };

/**
 * Decides whether the seed may write to DATABASE_URL. `--samples` (mock products, customer and staff accounts with a
 * shared password) needs NODE_ENV=development. A target that cannot be proven separate from every protected identity
 * is refused unless DATABASE_CONFIRMED_SEPARATE (shared with application startup and the Prisma guard) holds its exact
 * identity.
 */
export function checkSeedTarget(env: Record<string, string | undefined>, opts: { samples: boolean }): SeedTarget {
  const nodeEnv = env['NODE_ENV']?.trim() || 'development';
  if (nodeEnv === 'production') return { ok: false, reason: 'NODE_ENV=production: the development seed never runs in production' };
  if (opts.samples && nodeEnv !== 'development') return { ok: false, reason: `--samples needs NODE_ENV=development (sample fixtures are for isolated development databases only; NODE_ENV is ${nodeEnv})` };

  const target = parseDbIdentity(env['DATABASE_URL']);
  if ('error' in target) return { ok: false, reason: `DATABASE_URL cannot be identified: ${target.error}` };
  const masked = maskDbIdentity(target);

  const protectedIds = parseProtectedIdentities(env['PROTECTED_DATABASE_IDENTITIES']);
  if (!protectedIds.ok) return { ok: false, reason: protectedIds.reason };
  if (protectedIds.identities.length === 0) return { ok: false, reason: PROTECTION_INCOMPLETE };
  const verdict = protectionVerdict(target, protectedIds.identities);
  if (verdict === 'same') return { ok: false, reason: `${masked} is a protected database (PROTECTED_DATABASE_IDENTITIES)` };
  if (verdict === 'unknown' && env[DATABASE_CONFIRMED_SEPARATE_ENV]?.trim() !== formatDbIdentity(target)) {
    return {
      ok: false,
      reason: `cannot prove ${masked} is not a protected database: different hosts may still be one server. If you have verified ` +
        `it is a development database, set ${DATABASE_CONFIRMED_SEPARATE_ENV} to its identity (<server>/<database>)`,
    };
  }

  if (env['TEST_DATABASE_URL']?.trim()) {
    const test = parseDbIdentity(env['TEST_DATABASE_URL']);
    if ('error' in test) return { ok: false, reason: `TEST_DATABASE_URL cannot be identified: ${test.error}` };
    if (compareDbIdentity(target, test) === 'same') return { ok: false, reason: `${masked} is the integration-test database (TEST_DATABASE_URL), which the tests truncate` };
  }
  return { ok: true, masked, database: target.database };
}

/** The operator confirms by typing the target database name exactly; anything else writes nothing. */
export const seedConfirmed = (typed: string, database: string): boolean => typed.trim() === database;

type StaffUsersDb = { staffUser: Pick<Prisma.TransactionClient['staffUser'], 'findUnique' | 'create' | 'update'> };

/**
 * Creates the staff account if its email is unused. An existing account keeps its password, role and active flag
 * unless `reset` is set (seed --reset-admin, an explicit operator choice).
 */
export async function ensureStaffUser(
  db: StaffUsersDb,
  user: { email: string; name: string; role: StaffRole; passwordHash: string },
  opts: { reset?: boolean } = {},
): Promise<'created' | 'unchanged' | 'reset'> {
  const existing = await db.staffUser.findUnique({ where: { email: user.email }, select: { id: true } });
  if (!existing) {
    await db.staffUser.create({ data: user });
    return 'created';
  }
  if (!opts.reset) return 'unchanged';
  await db.staffUser.update({ where: { id: existing.id }, data: { passwordHash: user.passwordHash, role: user.role, isActive: true } });
  return 'reset';
}
