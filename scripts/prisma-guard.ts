// Prisma CLI safety guard. prisma.config.ts runs it before every Prisma command: Prisma 7 loads the config in-process,
// with process.argv intact, before it dispatches any command (shell completion excepted). Pure: arguments and environment
// in, verdict out (tests/prisma-guard.test.ts). Fails closed. Messages name variables, flags and database identities,
// never credentials or URLs.
import { checkProtectedTarget, migrationDatabaseProblems } from '../src/utils/db-identity.ts';

/** One-command authorisation for `migrate deploy` / `migrate status` on a protected database: its exact identity. */
export const ALLOW_PROTECTED_DEPLOY_ENV = 'ALLOW_PROTECTED_MIGRATE_DEPLOY';

/**
 * deploy: applies or reads migration history; on a protected database only with ALLOW_PROTECTED_MIGRATE_DEPLOY.
 * write:  everything else that opens the datasource or can change a database; never on a protected database.
 */
export type Access = 'deploy' | 'write';

const SUBCOMMANDS: Record<string, Record<string, Access>> = {
  migrate: { deploy: 'deploy', status: 'deploy', dev: 'write', reset: 'write', resolve: 'write', diff: 'write' },
  db: { push: 'write', execute: 'write', pull: 'write', seed: 'write' },
  // Prisma Postgres linking; like bootstrap it can rewrite the connection settings and run migrations.
  postgres: { link: 'write' },
};
// Commands without subcommands that open the datasource (studio) or can link a database and migrate it (bootstrap,
// mcp).
const STANDALONE: Record<string, Access> = { studio: 'write', bootstrap: 'write', mcp: 'write' };
// Prisma 7.10 commands that never open this project's datasource (dev runs a separate local Prisma Postgres). Any other
// command, e.g. one added by a Prisma upgrade, is guarded as `write` until it is classified here.
const NO_DATABASE = new Set(['generate', 'validate', 'format', 'version', 'init', 'debug', 'telemetry', 'platform', 'dev', 'complete']);

/** Any flag naming a connection URL (--url, --from-url, --to-url, --shadow-database-url, …), as `--x v` or `--x=v`. */
const URL_FLAG = /^--[a-z0-9-]*url(?:=|$)/i;

export interface GuardedCommand {
  command: string;
  access: Access;
}

/**
 * The database-touching commands in a Prisma argument list, whatever the argument order. Every word that is not a flag
 * counts, so a flag value (--schema, --config, --name …) that happens to be a command word makes the call guarded
 * too: that errs on the side of checking. A family word without a known subcommand, and a call naming no known
 * command at all (an unknown or future command), are guarded as `write`. No words at all (help, --version) is free.
 */
export function classifyPrismaCommand(args: readonly string[]): GuardedCommand[] {
  const words = new Set(args.filter((a) => !a.startsWith('-')).flatMap((a) => a.toLowerCase().split(/\s+/)));
  const found: GuardedCommand[] = [];
  for (const [family, subs] of Object.entries(SUBCOMMANDS)) {
    if (!words.has(family)) continue;
    const named = Object.entries(subs).filter(([sub]) => words.has(sub));
    if (named.length === 0) found.push({ command: `${family} (no known subcommand)`, access: 'write' });
    for (const [sub, access] of named) found.push({ command: `${family} ${sub}`, access });
  }
  for (const [command, access] of Object.entries(STANDALONE)) if (words.has(command)) found.push({ command, access });
  if (found.length === 0 && words.size > 0 && ![...words].some((w) => NO_DATABASE.has(w))) {
    found.push({ command: '(unrecognised command)', access: 'write' });
  }
  return found;
}

/** The datasource prisma.config.ts gives Prisma: the direct URL for migrations, else the application URL. */
export function prismaDatasourceUrl(env: Record<string, string | undefined>): string | undefined {
  return env['DIRECT_DATABASE_URL']?.trim() || env['DATABASE_URL'];
}

export type PrismaGuardResult = { ok: true } | { ok: false; reason: string };

export function checkPrismaCommand(args: readonly string[], env: Record<string, string | undefined>): PrismaGuardResult {
  // A URL on the command line would bypass the datasource checked below, so it is refused for every command.
  const urlFlags = [...new Set(args.filter((a) => URL_FLAG.test(a)).map((a) => a.split('=')[0]!))];
  if (urlFlags.length > 0) {
    return { ok: false, reason: `prisma: ${urlFlags.join(', ')} is not allowed. Prisma must use the datasource in prisma.config.ts (DIRECT_DATABASE_URL, else DATABASE_URL), which this guard checks; set those instead` };
  }

  const commands = classifyPrismaCommand(args);
  if (commands.length === 0) return { ok: true };
  const fail = (why: string): PrismaGuardResult => ({ ok: false, reason: `prisma ${commands.map((c) => c.command).join(', ')}: ${why}` });

  // Shared with application startup: protection configured, datasource identifiable, compared with the protected list.
  const sourceName = env['DIRECT_DATABASE_URL']?.trim() ? 'DIRECT_DATABASE_URL' : 'DATABASE_URL';
  const target = checkProtectedTarget(env, prismaDatasourceUrl(env), sourceName);
  if (!target.ok) return fail(target.reason);

  // DIRECT_DATABASE_URL must be a non-pooler URL of the DATABASE_URL database, so one identity covers both.
  const problems = migrationDatabaseProblems(env);
  if (problems.length > 0) return fail(problems.join('; '));

  if (target.isProtected) {
    const { identity } = target;
    const writes = commands.filter((c) => c.access === 'write').map((c) => c.command);
    if (writes.length > 0) {
      return fail(`${identity} is a protected database (PROTECTED_DATABASE_IDENTITIES). ${writes.join(', ')} never runs against it; ${ALLOW_PROTECTED_DEPLOY_ENV} does not apply`);
    }
    if (env[ALLOW_PROTECTED_DEPLOY_ENV]?.trim() !== identity) {
      return fail(`${identity} is a protected database (PROTECTED_DATABASE_IDENTITIES). To run migrate deploy/status against it, set ${ALLOW_PROTECTED_DEPLOY_ENV}=${identity} for that one command`);
    }
  }
  return { ok: true };
}
