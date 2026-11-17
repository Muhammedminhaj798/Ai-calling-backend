// Pure checks for scripts/create-staff-user.ts (tested in tests/staff-user-guard.test.ts): which database the
// script may write to, what a valid new account is, the confirmation phrase and operator-safe error text. No I/O here.
import { z } from 'zod';
import { loginSchema } from '../src/modules/auth/auth.validation.ts';
import { checkProtectedTarget, compareDbIdentity, parseDbIdentity, type DbIdentity } from '../src/utils/db-identity.ts';

export const CONFIRMATION_PHRASE = 'CREATE THIS ONE PRODUCTION USER';
/** The highest StaffRole in the schema (admin > approver > staff); there is no super-admin role. */
export const NEW_USER_ROLE = 'admin' as const;

export type TargetCheck = { ok: true; database: string; identity: string; warnings: string[] } | { ok: false; reason: string };

/**
 * Whether the script may write to the database URL the operator typed. It goes through checkProtectedTarget, shared
 * with application startup and the Prisma guard. PROTECTED_DATABASE_IDENTITIES must be configured and the URL
 * identifiable, and a protected database is refused with no override: typing its URL in does not make it acceptable,
 * and neither ALLOW_PROTECTED_RUNTIME_DATABASE nor ALLOW_PROTECTED_MIGRATE_DEPLOY applies here. The integration-test
 * database is refused too. Reports the identity only, never credentials, host or URL.
 */
export function checkTarget(rawUrl: string, env: Record<string, string | undefined>): TargetCheck {
  const target = checkProtectedTarget(env, rawUrl, 'the database URL entered');
  if (!target.ok) return { ok: false, reason: target.reason };
  if (target.isProtected) {
    return {
      ok: false,
      reason: `${target.identity} is a protected database (PROTECTED_DATABASE_IDENTITIES); staff:create never writes to it. Creating staff there needs a separately approved procedure`,
    };
  }
  const id = parseDbIdentity(rawUrl) as DbIdentity; // identifiable: checkProtectedTarget succeeded
  if (env['TEST_DATABASE_URL']?.trim()) {
    const test = parseDbIdentity(env['TEST_DATABASE_URL']);
    if ('error' in test) return { ok: false, reason: `TEST_DATABASE_URL cannot be identified: ${test.error}` };
    if (compareDbIdentity(id, test) === 'same') return { ok: false, reason: `${target.identity} is the database configured as TEST_DATABASE_URL` };
  }
  const warnings = /test/i.test(id.database) ? [`the database name "${id.database}" contains "test"`] : [];
  return { ok: true, database: id.database, identity: target.identity, warnings };
}

/** Error text for the operator: connection strings and database logins removed. */
export function redactedError(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const label = typeof e.code === 'string' ? e.code : typeof e.name === 'string' ? e.name : 'error';
  const message = String(e.message ?? err)
    .replace(/postgres(ql)?:\/\/\S+/gi, '<url>')
    .replace(/\b(user|role)\s+"[^"]*"/gi, '$1 "<redacted>"');
  return `${label}: ${message}`;
}

const newUserSchema = z.object({
  // The login form's own rules, so the account can always sign in.
  email: loginSchema.body.shape.email,
  name: z.string().trim().min(1, 'required').max(100, 'at most 100 characters'),
  password: z.string().min(12, 'at least 12 characters').max(200, 'at most 200 characters'),
});
export type NewStaffUser = z.infer<typeof newUserSchema>;

/** Validates the operator's input. Error messages never contain the values entered. */
export function validateNewUser(input: { email: string; name: string; password: string; confirmPassword: string }):
  | { ok: true; user: NewStaffUser }
  | { ok: false; reason: string } {
  if (input.password !== input.confirmPassword) return { ok: false, reason: 'the two passwords do not match' };
  const parsed = newUserSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, user: parsed.data };
}

export const isConfirmed = (typed: string) => typed === CONFIRMATION_PHRASE;
