// Runs the PostgreSQL-backed integration tests against a dedicated test database.
//   TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/ai_pharmacy_agent_test npm run test:integration
// Applies pending migrations to that database first, then runs tests/**/*.test.ts. Before anything connects,
// scripts/db-guard.ts must prove the test database is not DATABASE_URL / DIRECT_DATABASE_URL and not a protected
// identity (PROTECTED_DATABASE_IDENTITIES), fail closed. The children get scripts/integration-env.ts: every provider
// is its mock (AI included) with placeholder keys.
import { spawnSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { checkTestDatabase } from './db-guard.ts';
import { integrationTestEnv } from './integration-env.ts';

// TEST_DATABASE_URL (and the application URLs it is checked against) may live in .env; the shell wins.
loadEnv({ quiet: true });

// 1. The guard, before anything else: no migration and no truncating suite runs unless it passes.
const guard = checkTestDatabase(process.env);
if (!guard.ok) {
  console.error(`Refusing to run integration tests (they truncate every table): ${guard.reason}`);
  process.exit(2);
}
const testDb = process.env['TEST_DATABASE_URL']!;
console.log(`Test database verified separate: ${guard.identity}`);

const env = integrationTestEnv(process.env, testDb, guard.identity);
const run = (args: string[]) => spawnSync(process.execPath, args, { stdio: 'inherit', env });

// Direct endpoint only: prisma.config.ts refuses Migrate through a Neon pooler, so there is no pooled retry.
const migrate = run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

// All suites share one test database and truncate it between tests, so files must run one at a time.
// Optional arguments select specific suite files, e.g. `npm run test:integration -- tests/integration/orders.test.ts`.
const suites = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['tests/**/*.test.ts'];
const tests = run(['node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1', ...suites]);
process.exit(tests.status ?? 1);
