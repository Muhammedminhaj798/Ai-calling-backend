// Runs the PostgreSQL-backed integration tests against a dedicated test database.
//   TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/ai_pharmacy_agent_test npm run test:integration
// Applies pending migrations to that database first, then runs tests/**/*.test.ts. Never points at
// the development or production DATABASE_URL.
import { spawnSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';

// TEST_DATABASE_URL (and DATABASE_URL, for the equality guard) may live in .env; the shell wins when both exist.
loadEnv({ quiet: true });

const testDb = process.env.TEST_DATABASE_URL;
if (!testDb) {
  console.error('TEST_DATABASE_URL is not set. Integration tests need a dedicated PostgreSQL test database.');
  console.error('Example: TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/ai_pharmacy_agent_test npm run test:integration');
  process.exit(2);
}
if (testDb === process.env.DATABASE_URL) {
  console.error('TEST_DATABASE_URL must differ from DATABASE_URL: integration tests truncate every table.');
  process.exit(2);
}

/** Neon exposes a pooled host ending in "-pooler"; migrations must use the direct host behind it. */
function directUrl(url) {
  const u = new URL(url);
  if (/-pooler\./.test(u.hostname)) u.hostname = u.hostname.replace('-pooler.', '.');
  return u.toString();
}

const env = {
  ...process.env,
  DATABASE_URL: testDb,
  DIRECT_DATABASE_URL: process.env.TEST_DIRECT_DATABASE_URL ?? directUrl(testDb),
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
  JWT_SECRET: process.env.JWT_SECRET ?? 'integration-test-secret-not-for-production-0123456789',
  // Every test request comes from 127.0.0.1; only the per-email limit is exercised.
  LOGIN_RATE_LIMIT_PER_IP: '1000000',
  REFRESH_RATE_LIMIT_PER_IP: '1000000',
  // Tests call the expiry sweeper directly; no background timer.
  RESERVATION_SWEEP_INTERVAL_SECONDS: '0',
  // Mock telephony records transfers to this number so handover can be asserted.
  HANDOVER_PHONE_NUMBER: process.env.HANDOVER_PHONE_NUMBER ?? '+919000000000',
};
const run = (args) => spawnSync(process.execPath, args, { stdio: 'inherit', env });

let migrate = run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
if (migrate.status !== 0 && env.DIRECT_DATABASE_URL !== testDb) {
  // The direct endpoint is occasionally unreachable; the pooled one still applies migrations correctly.
  console.warn('migrate deploy failed through the direct endpoint; retrying through the pooled connection');
  env.DIRECT_DATABASE_URL = testDb;
  migrate = run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
}
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

// All suites share one test database and truncate it between tests, so files must run one at a time.
// Optional arguments select specific suite files, e.g. `npm run test:integration -- tests/integration/orders.test.ts`.
const suites = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['tests/**/*.test.ts'];
const tests = run(['node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1', ...suites]);
process.exit(tests.status ?? 1);
