// Prisma 7 configuration. The datasource URL lives here, not in schema.prisma.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { checkPrismaCommand, prismaDatasourceUrl } from './scripts/prisma-guard.ts';

// Prisma loads this file before running any command, so the guard sees every invocation. Commands that can reach a
// database (migrate, db, studio, …) refuse unless PROTECTED_DATABASE_IDENTITIES is set and the datasource is provably
// not a protected database; migrate deploy/status alone may run on one, with ALLOW_PROTECTED_MIGRATE_DEPLOY=<identity>.
// URL flags (--url, --from-url, --to-url, …) are refused. Rules: scripts/prisma-guard.ts. Messages never contain URLs.
const guard = checkPrismaCommand(process.argv.slice(2), process.env);
if (!guard.ok) throw new Error(`Refusing to run ${guard.reason}`);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // The CLI (migrations) should use a direct connection; Prisma Migrate's session-level advisory lock
    // misbehaves behind transaction-mode poolers such as Neon's "-pooler" endpoint. The application itself
    // keeps using DATABASE_URL (see src/config/db.ts).
    // The same URL the guard checked.
    url: prismaDatasourceUrl(process.env),
  },
});
