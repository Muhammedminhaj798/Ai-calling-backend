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
// ponytail: static URL identity only. Two Neon endpoints of one branch (a read replica) count as separate;
// that is safe because replicas are read-only, so neither migrations nor TRUNCATE can run through them.

export interface DbIdentity {
  /** neon:<endpoint id> | loopback:<port> | host:<hostname>:<port> */
  server: string;
  database: string;
}

export type Verdict = 'same' | 'separate' | 'unknown';

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0)$/;
// libpq lets query parameters override what the URL appears to say; we cannot reason about those.
const OVERRIDING_PARAMS = ['host', 'hostaddr', 'port', 'dbname', 'service'];

/** Credential-free identity of a PostgreSQL connection URL, or the reason it cannot be determined. */
export function parseDbIdentity(raw: string | undefined): DbIdentity | { error: string } {
  if (!raw?.trim()) return { error: 'not set' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: 'not a valid URL' };
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return { error: 'not a postgres:// or postgresql:// URL' };
  const overriding = OVERRIDING_PARAMS.filter((p) => url.searchParams.has(p));
  if (overriding.length > 0) return { error: `query parameters override the target (${overriding.join(', ')})` };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return { error: 'no host (Unix socket or libpq defaults)' };
  if (host.includes(',')) return { error: 'multiple hosts' };
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return { error: 'database name is not valid percent-encoding' };
  }
  if (!database || database.includes('/')) return { error: 'no single database name in the path' };

  const port = url.port || '5432';
  // Neon routes by endpoint id, not IP: "ep-x-pooler.<region>.neon.tech" and "ep-x.<region>.neon.tech" are one
  // compute. The endpoint may also be named in options=endpoint=<id> for clients without SNI.
  const optionsEndpoint = /(?:^|\s)(?:endpoint|project)=([\w-]+)/.exec(url.searchParams.get('options') ?? '')?.[1];
  const neonEndpoint = host.endsWith('.neon.tech') ? (optionsEndpoint ?? host.split('.')[0]!.replace(/-pooler$/, '')) : undefined;
  if (neonEndpoint?.startsWith('ep-')) return { server: `neon:${neonEndpoint.toLowerCase()}`, database };
  if (LOOPBACK.test(host)) return { server: `loopback:${port}`, database };
  return { server: `host:${host}:${port}`, database };
}

export function compareDbIdentity(a: DbIdentity, b: DbIdentity): Verdict {
  if (a.server === b.server) return a.database === b.database ? 'same' : 'separate';
  if (a.server.startsWith('neon:') && b.server.startsWith('neon:')) return 'separate';
  return 'unknown';
}

export const formatDbIdentity = (id: DbIdentity) => `${id.server}/${id.database}`;

export type GuardResult = { ok: true; identity: string } | { ok: false; reason: string };

/** Decides whether TEST_DATABASE_URL may be migrated and truncated, given the application's database URLs. */
export function checkTestDatabase(env: Record<string, string | undefined>): GuardResult {
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
  return { ok: true, identity };
}

/** Env var the runner sets after checkTestDatabase passes; the test helpers truncate only when it matches. */
export const VERIFIED_IDENTITY_ENV = 'INTEGRATION_TEST_DB_IDENTITY';

/** Gate for tests/integration/setup.ts: inside the runner DATABASE_URL is the verified test database. */
export function integrationGate(env: Record<string, string | undefined>): { available: boolean; reason: string } {
  const testDb = env['TEST_DATABASE_URL'];
  if (!testDb) return { available: false, reason: 'TEST_DATABASE_URL not set — run `npm run test:integration` with a dedicated PostgreSQL test database' };
  const test = parseDbIdentity(testDb);
  const verified = env['DATABASE_URL'] === testDb && !('error' in test) && env[VERIFIED_IDENTITY_ENV] === formatDbIdentity(test);
  return verified
    ? { available: true, reason: '' }
    : { available: false, reason: 'test database not verified by the guard — run through `npm run test:integration`' };
}
