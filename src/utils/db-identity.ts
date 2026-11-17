// Credential-free identity of PostgreSQL connection URLs, derived from the URL alone — no connection is opened.
// Shared by the application's startup checks (config/env.ts: API and voice worker), the Prisma CLI guard
// (scripts/prisma-guard.ts), the seed guard and the integration-test guard (scripts/db-guard.ts). Messages name variables and identities, never credentials or URLs.
//
//   same      same server and same database (e.g. a Neon pooled and a direct URL of one endpoint)
//   separate  same server with another database name, or two different Neon endpoints
//   unknown   anything else (unparseable URL, socket or parameter-routed host, two different hostnames that
//             could be one server behind a DNS alias, IP, proxy or tunnel)
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

/** Verdict for two URLs; `unknown` when either cannot be parsed. */
function compareUrls(a: string | undefined, b: string | undefined): Verdict {
  const x = parseDbIdentity(a);
  const y = parseDbIdentity(b);
  return 'error' in x || 'error' in y ? 'unknown' : compareDbIdentity(x, y);
}

/** True for Neon's transaction-mode pooler host ("ep-x-pooler.<region>.neon.tech"). */
export function isNeonPooler(raw: string | undefined): boolean {
  try {
    const host = new URL(raw?.trim() ?? '').hostname.toLowerCase().replace(/\.$/, '');
    return host.endsWith('.neon.tech') && host.split('.')[0]!.endsWith('-pooler');
  } catch {
    return false;
  }
}

/** The application must never run on the integration-test database: the tests truncate every table. */
export const appSharesTestDatabase = (env: Record<string, string | undefined>): boolean =>
  Boolean(env['TEST_DATABASE_URL']?.trim()) && compareUrls(env['DATABASE_URL'], env['TEST_DATABASE_URL']) === 'same';

/**
 * Problems with one environment's pooled/direct URL pair — DATABASE_URL + DIRECT_DATABASE_URL (prefix '') or
 * TEST_DATABASE_URL + TEST_DIRECT_DATABASE_URL (prefix 'TEST_'). Both must be identifiable; the direct URL, when set,
 * must not be a Neon pooler and must provably be the same database (an unprovable pair is ambiguous and refused).
 */
export function databaseUrlPairProblems(env: Record<string, string | undefined>, prefix: '' | 'TEST_'): string[] {
  const pooledName = `${prefix}DATABASE_URL`;
  const directName = `${prefix}DIRECT_DATABASE_URL`;
  const pooled = parseDbIdentity(env[pooledName]);
  if ('error' in pooled) return [`${pooledName} cannot be identified: ${pooled.error}`];
  if (!env[directName]?.trim()) return [];
  const direct = parseDbIdentity(env[directName]);
  if ('error' in direct) return [`${directName} cannot be identified: ${direct.error}`];
  const problems: string[] = [];
  if (isNeonPooler(env[directName])) problems.push(`${directName} is a Neon "-pooler" host; it must be the direct (non-pooler) endpoint`);
  const verdict = compareDbIdentity(pooled, direct);
  if (verdict === 'separate') problems.push(`${directName} is a different database from ${pooledName}; migrations would not reach that environment's database`);
  if (verdict === 'unknown') problems.push(`${directName} cannot be proven to be the same database as ${pooledName}`);
  return problems;
}

/**
 * Problems with the URL Prisma Migrate uses (DIRECT_DATABASE_URL, else DATABASE_URL): its session-level advisory lock
 * needs a direct connection, not Neon's transaction-mode pooler, and it must reach the application's own database.
 */
export function migrationDatabaseProblems(env: Record<string, string | undefined>): string[] {
  const problems = databaseUrlPairProblems(env, '');
  if (!env['DIRECT_DATABASE_URL']?.trim() && isNeonPooler(env['DATABASE_URL'])) {
    problems.push('DATABASE_URL is a Neon "-pooler" host; Prisma Migrate needs the direct (non-pooler) endpoint in DIRECT_DATABASE_URL');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Protected identities (PROTECTED_DATABASE_IDENTITIES)
// ---------------------------------------------------------------------------

/** A database no tool may truncate or seed: one server and one database, or `*` for every database on that server. */
export interface ProtectedIdentity {
  server: string;
  database: string;
}

export const PROTECTION_INCOMPLETE =
  'PROTECTED_DATABASE_IDENTITIES is not set, so production protection is incomplete: add the production database identity ' +
  '(e.g. neon:<endpoint-id>/<database>) first';

const PROTECTED_ENTRY = /^(neon:ep-[a-z0-9-]+|loopback:\d{1,5}|host:[a-z0-9.-]+:\d{1,5})\/([^\s/,:@?#]+)$/;

/**
 * Parses PROTECTED_DATABASE_IDENTITIES: comma-separated identities in the format the guards print —
 * `neon:<endpoint-id>/<database>` (endpoint id without "-pooler"), `host:<hostname>:<port>/<database>` or
 * `loopback:<port>/<database>`; `<server>/*` protects every database on that server. Server parts are lowercased and a
 * "-pooler" suffix is dropped, as for URLs. Identities only: an entry that looks like a URL or holds credentials is
 * refused, and no message ever repeats an entry.
 */
export function parseProtectedIdentities(raw: string | undefined): { ok: true; identities: ProtectedIdentity[] } | { ok: false; reason: string } {
  const identities: ProtectedIdentity[] = [];
  const entries = (raw ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  for (const [i, entry] of entries.entries()) {
    if (/[@?#]|:\/\//.test(entry)) {
      return { ok: false, reason: `PROTECTED_DATABASE_IDENTITIES entry ${i + 1} looks like a connection URL; store only its identity, e.g. neon:<endpoint-id>/<database>` };
    }
    const slash = entry.lastIndexOf('/');
    const server = entry.slice(0, Math.max(slash, 0)).toLowerCase().replace(/^(neon:ep-[a-z0-9-]+?)-pooler$/, '$1');
    const database = entry.slice(slash + 1);
    if (slash < 0 || !PROTECTED_ENTRY.test(`${server}/${database}`)) {
      return { ok: false, reason: `PROTECTED_DATABASE_IDENTITIES entry ${i + 1} is not an identity (neon:<endpoint-id>/<database>, host:<hostname>:<port>/<database> or loopback:<port>/<database>)` };
    }
    identities.push({ server, database });
  }
  return { ok: true, identities };
}

/**
 * Whether `target` is one of the protected databases: `same` if it is (database names compared case-insensitively, so
 * a differently cased entry still protects), `separate` if provably not, `unknown` when different hosts could be one
 * server. Callers fail closed on `unknown`.
 */
export function protectionVerdict(target: DbIdentity, identities: ProtectedIdentity[]): Verdict {
  const verdicts = identities.map((p): Verdict => {
    if (p.server === target.server) return p.database === '*' || p.database.toLowerCase() === target.database.toLowerCase() ? 'same' : 'separate';
    return p.server.startsWith('neon:') && target.server.startsWith('neon:') ? 'separate' : 'unknown';
  });
  return verdicts.includes('same') ? 'same' : verdicts.includes('unknown') ? 'unknown' : 'separate';
}

/**
 * Vouches, after a manual check, that the application database (DATABASE_URL, which DIRECT_DATABASE_URL must match) is
 * not protected when no guard can prove it (different hosts, e.g. localhost against Neon): its exact identity. Read by
 * application startup, the Prisma guard and the seed; it never unlocks a protected database.
 */
export const DATABASE_CONFIRMED_SEPARATE_ENV = 'DATABASE_CONFIRMED_SEPARATE';

export type ProtectedTargetCheck = { ok: true; identity: string; isProtected: boolean } | { ok: false; reason: string };

/**
 * What every guard checks before a database is used, failing closed: PROTECTED_DATABASE_IDENTITIES set and valid, the
 * target identifiable, and whether it is protected. A target that cannot be compared with the protected identities is
 * refused unless DATABASE_CONFIRMED_SEPARATE holds its exact identity. Callers decide what a protected target may do.
 * `urlName` names the variable(s) the URL came from; reasons never contain credentials or URLs.
 */
export function checkProtectedTarget(env: Record<string, string | undefined>, url: string | undefined, urlName: string): ProtectedTargetCheck {
  const protectedIds = parseProtectedIdentities(env['PROTECTED_DATABASE_IDENTITIES']);
  if (!protectedIds.ok) return { ok: false, reason: protectedIds.reason };
  if (protectedIds.identities.length === 0) return { ok: false, reason: PROTECTION_INCOMPLETE };
  const target = parseDbIdentity(url);
  if ('error' in target) return { ok: false, reason: `${urlName} cannot be identified: ${target.error}` };
  const identity = formatDbIdentity(target);
  const verdict = protectionVerdict(target, protectedIds.identities);
  if (verdict === 'unknown' && env[DATABASE_CONFIRMED_SEPARATE_ENV]?.trim() !== identity) {
    return {
      ok: false,
      reason: `cannot prove ${identity} is not a protected database (${urlName}): the hosts differ, and a DNS alias, IP, proxy or tunnel could still reach one. After verifying it yourself, set ${DATABASE_CONFIRMED_SEPARATE_ENV}=${identity}`,
    };
  }
  return { ok: true, identity, isProtected: verdict === 'same' };
}

/** Production-only authorisation for the API and voice worker to use a protected database: its exact identity. */
export const ALLOW_PROTECTED_RUNTIME_ENV = 'ALLOW_PROTECTED_RUNTIME_DATABASE';

/**
 * Startup check of the database the application connects to (API, voice worker and its job processes, and any script
 * that loads the app config), in every NODE_ENV and before any connection. A protected DATABASE_URL is refused unless
 * NODE_ENV=production and ALLOW_PROTECTED_RUNTIME_DATABASE holds its exact identity (no wildcard can equal one).
 * Outside production that variable is refused outright, so a production setting copied into development unlocks
 * nothing; when set, it must name DATABASE_URL's database, so production cannot start on an unexpected one either.
 * Separate from ALLOW_PROTECTED_MIGRATE_DEPLOY, which only the Prisma CLI reads.
 */
export function runtimeDatabaseProblem(env: Record<string, string | undefined>, nodeEnv: string): string | undefined {
  const allow = env[ALLOW_PROTECTED_RUNTIME_ENV]?.trim() || undefined;
  if (allow && nodeEnv !== 'production') {
    return `${ALLOW_PROTECTED_RUNTIME_ENV} is set but NODE_ENV is ${nodeEnv}; it is honoured only in production. Remove it`;
  }
  const target = checkProtectedTarget(env, env['DATABASE_URL'], 'DATABASE_URL');
  if (!target.ok) return target.reason;
  if (allow && allow !== target.identity) {
    return `${ALLOW_PROTECTED_RUNTIME_ENV} does not name DATABASE_URL's database (${target.identity}); it must be exactly that identity`;
  }
  if (target.isProtected && !allow) {
    return nodeEnv === 'production'
      ? `DATABASE_URL is the protected database ${target.identity} (PROTECTED_DATABASE_IDENTITIES); production may use it only with ${ALLOW_PROTECTED_RUNTIME_ENV}=${target.identity}`
      : `DATABASE_URL is the protected database ${target.identity} (PROTECTED_DATABASE_IDENTITIES); ${nodeEnv} never connects to it`;
  }
  return undefined;
}

/** An identity safe to print anywhere: the Neon endpoint id or hostname shortened, the database name kept. */
export function maskDbIdentity(id: DbIdentity): string {
  const short = (s: string) => (s.length > 10 ? `${s.slice(0, 7)}…${s.slice(-2)}` : s);
  if (id.server.startsWith('neon:')) return `neon:${short(id.server.slice(5))}/${id.database}`;
  if (id.server.startsWith('host:')) {
    const hostPort = id.server.slice(5);
    const colon = hostPort.lastIndexOf(':');
    return `host:${short(hostPort.slice(0, colon))}${hostPort.slice(colon)}/${id.database}`;
  }
  return formatDbIdentity(id);
}
