// One-time creation of ONE admin staff user in the database behind a deployed API (PRODUCTION_API_URL).
//   npm run staff:create        interactive terminal only (PowerShell / Windows Terminal; not Git Bash/mintty)
//
// Never writes to a protected database (PROTECTED_DATABASE_IDENTITIES): the production database is refused before any
// connection, with no override. Typing its URL in does not make it acceptable, and neither ALLOW_PROTECTED_RUNTIME_DATABASE
// nor ALLOW_PROTECTED_MIGRATE_DEPLOY applies. Creating staff in production needs a separately approved procedure.
//
// 1. Asks for the database URL (hidden). The DATABASE_URL in .env is ignored. checkTarget (scripts/staff-user-guard.ts)
//    refuses it unless protection is configured, the URL is identifiable, and it is neither protected nor the
//    TEST_DATABASE_URL database. Only then is the database module loaded, so nothing connects before the check.
// 2. Proves the URL is the database the API writes to: sends ONE failed login with a random probe address
//    (identity-probe-…@example.com) to the production API, which records auth.login_failed in audit_logs, and looks
//    for that record in the target database. Not found → stop: it is not Render's database.
// 3. Asks for email, name and password (hidden, twice); refuses an email that already exists.
// 4. Requires typing CREATE THIS ONE PRODUCTION USER, then inserts the user (role admin) and one staff_user.create
//    audit record in one transaction, and verifies it. Never updates or deletes anything; never prints the
//    password, its hash or the database credentials.
// Exit codes: 0 created · 1 error · 2 stopped or refused (nothing written).
import { config as loadEnv } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { checkTarget, CONFIRMATION_PHRASE, isConfirmed, NEW_USER_ROLE, redactedError, validateNewUser } from './staff-user-guard.ts';

loadEnv({ quiet: true }); // JWT_SECRET etc. for the app config; PROTECTED_DATABASE_IDENTITIES and TEST_DATABASE_URL for checkTarget
const PRODUCTION_API = (process.env['PRODUCTION_API_URL']?.trim() || 'https://ai-calling-backend-1kmy.onrender.com').replace(/\/$/, '');

function stop(code: 1 | 2, message: string): never {
  console.error(`\nSTOP  ${message}\n      Nothing was written to the users table.`);
  process.exit(code);
}
const errorText = redactedError;

async function ask(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  rl.on('SIGINT', () => {
    rl.close();
    stop(2, 'cancelled.');
  });
  try {
    const answer = rl.question(question);
    muted = hidden; // the prompt is already written; from here on, typed characters are not echoed
    return await answer;
  } finally {
    rl.close();
    if (hidden) process.stdout.write('\n');
  }
}

if (!process.stdin.isTTY || !process.stdout.isTTY) stop(2, 'run this in an interactive terminal (PowerShell or Windows Terminal).');
console.log(`Creates exactly ONE admin user in the database behind ${PRODUCTION_API}; never in a protected database.\n`);

// 1. Target database. Checked before src/config/db.ts is loaded: nothing connects until it passes.
const databaseUrl = (await ask(`DATABASE_URL of the API at ${PRODUCTION_API} (input hidden): `, true)).trim();
const target = checkTarget(databaseUrl, process.env);
if (!target.ok) stop(2, target.reason);
console.log(`Target: database ${target.database} (${target.identity})`);
for (const w of target.warnings) console.log(`WARN  ${w}`);
process.env['DATABASE_URL'] = databaseUrl; // read by src/config/db.ts below; .env never overrides a set variable

const { prisma } = await import('../src/config/db.ts');
const { hashPassword, verifyPassword } = await import('../src/modules/auth/auth.tokens.ts');

try {
  // 2. Proof that the production API writes to this database
  console.log(`\nVerifying: one failed login with a random probe address goes to ${PRODUCTION_API}; the API records it in audit_logs.`);
  const probeEmail = `identity-probe-${randomBytes(8).toString('hex')}@example.com`;
  const since = new Date(Date.now() - 10 * 60_000);
  let status: number;
  try {
    const res = await fetch(`${PRODUCTION_API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: probeEmail, password: randomBytes(18).toString('base64url') }),
      signal: AbortSignal.timeout(90_000), // Render may need to wake up
    });
    status = res.status;
  } catch (err) {
    stop(1, `the production API is unreachable (${errorText(err)}); the target cannot be verified.`);
  }
  if (status === 429) stop(1, 'the production API rate-limited the probe (login attempts per 15 minutes); try again later.');
  if (status !== 401) stop(1, `unexpected status ${status} from the production API; the target cannot be verified.`);
  let proof: { id: string } | null;
  try {
    proof = await prisma.auditLog.findFirst({
      where: { action: 'auth.login_failed', createdAt: { gte: since }, after: { path: ['email'], equals: probeEmail } },
      select: { id: true },
    });
  } catch (err) {
    stop(1, `cannot query the target database (${errorText(err)}).`);
  }
  if (!proof) stop(2, `NOT VERIFIED: ${PRODUCTION_API} did not record the probe in ${target.identity}, so it is not the database Render uses.`);
  console.log(`PASS  ${target.identity} is the database the production API writes to.`);

  const before = await prisma.staffUser.count();
  const admins = await prisma.staffUser.count({ where: { role: 'admin', isActive: true } });
  const seedAccounts = await prisma.staffUser.count({ where: { email: { in: ['staff@example.com', 'approver@example.com'] } } });
  console.log(`      staff users: ${before} (active admins: ${admins})`);
  if (seedAccounts > 0) console.log(`WARN  ${seedAccounts} development seed account(s) (staff@/approver@example.com) exist in this database.`);

  // 3. The new account
  console.log(`\nNew user (role ${NEW_USER_ROLE}):`);
  const email = await ask('Email: ');
  const name = (await ask('Full name [Administrator]: ')).trim() || 'Administrator';
  const password = await ask('Password, at least 12 characters (hidden): ', true);
  const confirmPassword = await ask('Repeat the password (hidden): ', true);
  const input = validateNewUser({ email, name, password, confirmPassword });
  if (!input.ok) stop(2, input.reason);
  const user = input.user;
  if (await prisma.staffUser.findUnique({ where: { email: user.email }, select: { id: true } })) {
    stop(2, `a staff user with the email ${user.email} already exists; it was not changed.`);
  }

  // 4. Confirm, insert, verify
  console.log(`\nAbout to insert ONE user into ${target.identity}:`);
  console.log(`  email ${user.email} · name ${user.name} · role ${NEW_USER_ROLE} · active`);
  if (!isConfirmed(await ask(`Type ${CONFIRMATION_PHRASE} to continue: `))) stop(2, 'not confirmed.');

  const passwordHash = await hashPassword(user.password);
  let created: { id: string; email: string; role: string };
  try {
    created = await prisma.$transaction(async (tx) => {
      const row = await tx.staffUser.create({
        data: { email: user.email, name: user.name, role: NEW_USER_ROLE, passwordHash },
        select: { id: true, email: true, role: true },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'system',
          action: 'staff_user.create',
          entityType: 'staff_user',
          entityId: row.id,
          after: { email: row.email, name: user.name, role: row.role, source: 'scripts/create-staff-user.ts' },
        },
      });
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') stop(2, `a staff user with the email ${user.email} already exists; it was not changed.`);
    throw err;
  }

  const stored = await prisma.staffUser.findUnique({ where: { email: user.email } });
  const after = await prisma.staffUser.count();
  const verified =
    stored !== null &&
    stored.id === created.id &&
    stored.role === NEW_USER_ROLE &&
    stored.isActive &&
    (await verifyPassword(stored.passwordHash, user.password)) &&
    after === before + 1;
  console.log(`\n${verified ? 'PASS' : 'FAIL'}  created ${created.email} · role ${created.role} · active · id ${created.id}`);
  console.log(`      staff users: ${before} → ${after}; the stored argon2id hash matches the password (neither is shown).`);
  if (!verified) process.exitCode = 1;
} catch (err) {
  console.error(`\nFAIL  ${errorText(err)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
