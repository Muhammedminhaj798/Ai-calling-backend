// Prisma CLI guard (scripts/prisma-guard.ts, run by prisma.config.ts): which commands may reach which database.
// Every URL and identity here is fake; nothing runs Prisma and nothing connects.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPrismaCommand, classifyPrismaCommand, prismaDatasourceUrl } from '../scripts/prisma-guard.ts';

const PROD_ID = 'neon:ep-prod-endpoint-999999/ai_pharmacy_agent_test';
const PROD_POOLED = 'postgresql://prod_owner:Pr0dSecret@ep-prod-endpoint-999999-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy_agent_test?sslmode=require';
const PROD_DIRECT = PROD_POOLED.replace('-pooler', '');
const DEV_POOLED = 'postgresql://dev_owner:D3vSecret@ep-dev-branch-111111-pooler.c-2.us-east-2.aws.neon.tech/ai_pharmacy_dev?sslmode=require';
const DEV_DIRECT = DEV_POOLED.replace('-pooler', '');
const LOCAL = 'postgresql://local_owner:L0calSecret@127.0.0.1:5432/ai_pharmacy_dev';

type Env = Record<string, string | undefined>;
const dev: Env = { DATABASE_URL: DEV_POOLED, DIRECT_DATABASE_URL: DEV_DIRECT, PROTECTED_DATABASE_IDENTITIES: PROD_ID };
const prod: Env = { ...dev, DATABASE_URL: PROD_POOLED, DIRECT_DATABASE_URL: PROD_DIRECT };
const authorised: Env = { ...prod, ALLOW_PROTECTED_MIGRATE_DEPLOY: PROD_ID };

/** Every Prisma 7 command that can reach a database, with the arguments it is typically run with. */
const WRITE_COMMANDS = [
  ['migrate', 'dev'],
  ['migrate', 'reset', '--force'],
  ['db', 'push', '--accept-data-loss'],
  ['db', 'execute', '--file', 'fix.sql'],
  ['studio'],
  ['migrate', 'resolve', '--applied', '20261109120000_init'],
  ['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma'],
  ['db', 'pull'],
  ['db', 'seed'],
  ['bootstrap'],
  ['postgres', 'link'],
  ['mcp'],
];
const DEPLOY_COMMANDS = [['migrate', 'deploy'], ['migrate', 'status']];
const NO_DATABASE_COMMANDS = [[], ['generate'], ['validate'], ['format'], ['version'], ['--version'], ['init'], ['debug'], ['dev'], ['platform', 'status'], ['--help']];

/** What must never appear in a message: credentials, logins, hosts or URLs. */
const SECRETS = /Secret|_owner|@|neon\.tech|127\.0\.0\.1|postgres(ql)?:\/\//;
const show = (args: string[]) => `prisma ${args.join(' ')}`;

function refused(args: string[], env: Env, pattern: RegExp): void {
  const r = checkPrismaCommand(args, env);
  assert.equal(r.ok, false, `must refuse: ${show(args)}`);
  if (!r.ok) {
    assert.match(r.reason, pattern, show(args));
    assert.doesNotMatch(r.reason, SECRETS, 'names variables, flags and identities only');
  }
}
const allowed = (args: string[], env: Env) => assert.deepEqual(checkPrismaCommand(args, env), { ok: true }, show(args));

describe('classifyPrismaCommand', () => {
  it('finds the command whatever the argument order, around --schema / --config and their values', () => {
    const cases: Array<[string[], string[]]> = [
      [['migrate', 'dev'], ['migrate dev']],
      [['--schema', 'prisma/schema.prisma', 'migrate', 'reset'], ['migrate reset']],
      [['migrate', '--schema', 'prisma/schema.prisma', 'dev', '--name', 'init'], ['migrate dev']],
      [['--config=prisma.config.ts', 'db', 'push'], ['db push']],
      [['--config', 'prisma.config.ts', 'db', '--file', 'fix.sql', 'execute'], ['db execute']],
      [['studio', '--port', '5555'], ['studio']],
      [['MIGRATE', 'RESET'], ['migrate reset']],
      [['migrate deploy'], ['migrate deploy']],
    ];
    for (const [args, expected] of cases) assert.deepEqual(classifyPrismaCommand(args).map((c) => c.command), expected, show(args));
  });

  it('classifies deploy/status as deploy and every other database command as write', () => {
    for (const args of DEPLOY_COMMANDS) assert.deepEqual(classifyPrismaCommand(args).map((c) => c.access), ['deploy'], show(args));
    for (const args of WRITE_COMMANDS) assert.deepEqual(classifyPrismaCommand(args).map((c) => c.access), ['write'], show(args));
  });

  it('leaves commands that never open the datasource unguarded', () => {
    for (const args of NO_DATABASE_COMMANDS) assert.deepEqual(classifyPrismaCommand(args), [], show(args));
  });

  it('errs towards checking: no known subcommand, or a flag value that is a command word, still counts', () => {
    assert.deepEqual(classifyPrismaCommand(['migrate', '--help']), [{ command: 'migrate (no known subcommand)', access: 'write' }]);
    assert.deepEqual(classifyPrismaCommand(['generate', '--generator', 'db']), [{ command: 'db (no known subcommand)', access: 'write' }]);
    assert.ok(classifyPrismaCommand(['migrate', 'deploy', '--name', 'reset']).some((c) => c.access === 'write'));
  });

  it('guards an unknown or future command until it is classified, but not a known one behind --schema', () => {
    for (const args of [['introspect'], ['some-future-command', '--force'], ['--config', 'other.config.ts']]) {
      assert.deepEqual(classifyPrismaCommand(args), [{ command: '(unrecognised command)', access: 'write' }], show(args));
    }
    assert.deepEqual(classifyPrismaCommand(['--schema', 'prisma/schema.prisma', 'generate']), []);
    refused(['some-future-command'], { ...dev, PROTECTED_DATABASE_IDENTITIES: undefined }, /production protection is incomplete/);
    refused(['some-future-command'], prod, /is a protected database/);
  });
});

describe('checkPrismaCommand — protected identity configuration', () => {
  it('refuses every database command when PROTECTED_DATABASE_IDENTITIES is missing or empty', () => {
    for (const value of [undefined, '', ' , ']) {
      for (const args of [...WRITE_COMMANDS, ...DEPLOY_COMMANDS]) {
        refused(args, { ...dev, PROTECTED_DATABASE_IDENTITIES: value }, /production protection is incomplete/);
      }
    }
  });

  it('refuses an invalid list without repeating its entries', () => {
    refused(['migrate', 'deploy'], { ...dev, PROTECTED_DATABASE_IDENTITIES: PROD_POOLED }, /entry 1 looks like a connection URL/);
    refused(['migrate', 'dev'], { ...dev, PROTECTED_DATABASE_IDENTITIES: `${PROD_ID},neon:ep-broken` }, /entry 2 is not an identity/);
    refused(['studio'], { ...dev, PROTECTED_DATABASE_IDENTITIES: 'ep-prod-endpoint-999999/ai_pharmacy_agent_test' }, /entry 1 is not an identity/);
  });

  it('lets commands that never open the datasource run without any database configuration', () => {
    for (const args of NO_DATABASE_COMMANDS) allowed(args, {});
  });
});

describe('checkPrismaCommand — protected production database', () => {
  for (const args of WRITE_COMMANDS) {
    it(`refuses ${show(args)}, even with ALLOW_PROTECTED_MIGRATE_DEPLOY set`, () => {
      refused(args, prod, /neon:ep-prod-endpoint-999999\/ai_pharmacy_agent_test is a protected database/);
      refused(args, authorised, /does not apply/);
    });
  }

  it('matches the exact identity through any login, the direct URL alone, or a differently written entry', () => {
    refused(['migrate', 'reset'], { ...prod, DIRECT_DATABASE_URL: PROD_DIRECT.replace('prod_owner:Pr0dSecret', 'migrator:x') }, /is a protected database/);
    refused(['db', 'push'], { ...prod, DATABASE_URL: PROD_DIRECT, DIRECT_DATABASE_URL: undefined }, /is a protected database/);
    refused(['migrate', 'dev'], { ...prod, PROTECTED_DATABASE_IDENTITIES: 'NEON:EP-PROD-ENDPOINT-999999-pooler/AI_PHARMACY_AGENT_TEST' }, /is a protected database/);
  });

  it('matches every database on a wildcard endpoint', () => {
    const wildcard = { ...prod, PROTECTED_DATABASE_IDENTITIES: 'neon:ep-prod-endpoint-999999/*' };
    refused(['migrate', 'dev'], wildcard, /is a protected database/);
    const otherDb = (url: string) => url.replace('/ai_pharmacy_agent_test?', '/scratch?');
    refused(['db', 'execute', '--stdin'], { ...wildcard, DATABASE_URL: otherDb(PROD_POOLED), DIRECT_DATABASE_URL: otherDb(PROD_DIRECT) }, /neon:ep-prod-endpoint-999999\/scratch is a protected database/);
  });

  it('refuses a production pooler URL, or a mix of production and development URLs', () => {
    refused(['migrate', 'deploy'], { ...authorised, DIRECT_DATABASE_URL: undefined }, /DATABASE_URL is a Neon "-pooler" host/);
    refused(['migrate', 'dev'], { ...dev, DIRECT_DATABASE_URL: PROD_DIRECT }, /different database/);
    refused(['migrate', 'dev'], { ...prod, DIRECT_DATABASE_URL: DEV_DIRECT }, /different database/);
  });
});

describe('checkPrismaCommand — URL overrides', () => {
  const FLAGS = ['--url', '--from-url', '--to-url', '--shadow-database-url', '--URL'];

  it('refuses every URL flag, in both forms, on any command and any database', () => {
    for (const flag of FLAGS) {
      for (const args of [['migrate', 'deploy', flag, DEV_DIRECT], ['db', 'push', `${flag}=${DEV_DIRECT}`], ['migrate', 'diff', flag, PROD_DIRECT], ['studio', flag, LOCAL], ['generate', flag, PROD_DIRECT]]) {
        refused(args, dev, new RegExp(`${flag} is not allowed`));
      }
    }
  });

  it('refuses them even where the production migration is authorised', () => {
    refused(['migrate', 'deploy', '--url', PROD_DIRECT], authorised, /--url is not allowed/);
    refused(['migrate', 'diff', '--from-url', DEV_DIRECT, '--to-url', PROD_DIRECT], authorised, /--from-url, --to-url is not allowed/);
  });
});

describe('checkPrismaCommand — argument-order bypass attempts', () => {
  const attempts = [
    ['--schema', 'prisma/schema.prisma', 'migrate', 'reset', '--force'],
    ['--config', 'prisma.config.ts', 'db', 'execute', '--file', 'fix.sql'],
    ['migrate', '--schema', 'prisma/schema.prisma', 'dev'],
    ['db', '--accept-data-loss', 'push'],
    ['--schema=prisma/schema.prisma', 'studio'],
    ['MIGRATE', 'RESET'],
    ['migrate reset'],
    ['migrate', 'deploy', 'dev'],
  ];
  it('refuses each on the protected database, even with the deploy authorisation', () => {
    for (const args of attempts) refused(args, authorised, /is a protected database/);
  });
});

describe('checkPrismaCommand — development database', () => {
  it('allows every database command on a provably separate database', () => {
    for (const args of [...WRITE_COMMANDS, ...DEPLOY_COMMANDS]) allowed(args, dev);
  });

  it('treats another database on a protected endpoint as separate unless the entry is a wildcard', () => {
    const scratch = { ...prod, DATABASE_URL: PROD_POOLED.replace('/ai_pharmacy_agent_test?', '/scratch?'), DIRECT_DATABASE_URL: PROD_DIRECT.replace('/ai_pharmacy_agent_test?', '/scratch?') };
    allowed(['migrate', 'dev'], scratch);
  });

  it('still refuses a pooler direct URL or an unidentifiable datasource', () => {
    refused(['migrate', 'dev'], { ...dev, DIRECT_DATABASE_URL: DEV_POOLED }, /DIRECT_DATABASE_URL is a Neon "-pooler" host/);
    refused(['migrate', 'dev'], { ...dev, DATABASE_URL: 'not a url', DIRECT_DATABASE_URL: undefined }, /DATABASE_URL cannot be identified/);
    refused(['migrate', 'dev'], { ...dev, DATABASE_URL: undefined, DIRECT_DATABASE_URL: undefined }, /cannot be identified: not set/);
  });

  it('needs DATABASE_CONFIRMED_SEPARATE for a host it cannot compare (localhost against Neon), and never for a protected one', () => {
    const local = { ...dev, DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: undefined };
    refused(['migrate', 'dev'], local, /cannot prove loopback:5432\/ai_pharmacy_dev is not a protected database \(DATABASE_URL\).*DATABASE_CONFIRMED_SEPARATE=/);
    refused(['migrate', 'dev'], { ...local, DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/other' }, /cannot prove/);
    allowed(['migrate', 'dev'], { ...local, DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/ai_pharmacy_dev' });
    refused(['migrate', 'dev'], { ...local, PROTECTED_DATABASE_IDENTITIES: 'loopback:5432/ai_pharmacy_dev', DATABASE_CONFIRMED_SEPARATE: 'loopback:5432/ai_pharmacy_dev' }, /is a protected database/);
  });

  it('gives Prisma the direct URL, else the application URL', () => {
    assert.equal(prismaDatasourceUrl(dev), DEV_DIRECT);
    assert.equal(prismaDatasourceUrl({ ...dev, DIRECT_DATABASE_URL: '  ' }), DEV_POOLED);
  });
});

describe('checkPrismaCommand — production migration authorisation', () => {
  it('refuses migrate deploy and status on the protected database without ALLOW_PROTECTED_MIGRATE_DEPLOY, naming the identity to set', () => {
    for (const args of DEPLOY_COMMANDS) refused(args, prod, /set ALLOW_PROTECTED_MIGRATE_DEPLOY=neon:ep-prod-endpoint-999999\/ai_pharmacy_agent_test/);
  });

  it('allows them with the exact identity', () => {
    for (const args of DEPLOY_COMMANDS) {
      allowed(args, authorised);
      allowed(['--schema', 'prisma/schema.prisma', ...args], { ...authorised, ALLOW_PROTECTED_MIGRATE_DEPLOY: ` ${PROD_ID} ` });
    }
  });

  it('accepts nothing but the exact identity of the target', () => {
    const wrong = ['true', '1', 'yes', '*', 'neon:ep-prod-endpoint-999999/*', 'neon:ep-prod-endpoint-999999-pooler/ai_pharmacy_agent_test', PROD_ID.toUpperCase(), 'neon:ep-dev-branch-111111/ai_pharmacy_dev', PROD_DIRECT, ''];
    for (const value of wrong) refused(['migrate', 'deploy'], { ...prod, ALLOW_PROTECTED_MIGRATE_DEPLOY: value }, /set ALLOW_PROTECTED_MIGRATE_DEPLOY=/);
  });

  it('authorises only the database it names, not another protected one', () => {
    const second = 'postgresql://x:y@ep-other-prod-888888.c-2.us-east-2.aws.neon.tech/app';
    const env = { ...authorised, PROTECTED_DATABASE_IDENTITIES: `${PROD_ID},neon:ep-other-prod-888888/app`, DATABASE_URL: second, DIRECT_DATABASE_URL: undefined };
    refused(['migrate', 'deploy'], env, /set ALLOW_PROTECTED_MIGRATE_DEPLOY=neon:ep-other-prod-888888\/app/);
  });

  it('never extends to migrate dev, migrate reset, db push, db execute or studio', () => {
    for (const args of [['migrate', 'dev'], ['migrate', 'reset'], ['db', 'push'], ['db', 'execute', '--stdin'], ['studio']]) refused(args, authorised, /does not apply/);
  });
});
