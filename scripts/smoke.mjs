// Startup + health-check smoke test. Boots the server on a random port, probes it, stops it.
//   node scripts/smoke.mjs         → runs the production build (dist/server.js); run `npm run build` first
//   node scripts/smoke.mjs --dev   → runs the TypeScript sources through tsx
import { spawn } from 'node:child_process';

const dev = process.argv.includes('--dev');
const port = 4100 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const args = dev ? ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'] : ['dist/server.js'];

const child = spawn(process.execPath, args, {
  env: { ...process.env, PORT: String(port), LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

const results = [];
const check = (name, ok, info) => results.push({ name, ok, info });

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})\n${output}`);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start within 20s\n${output}`);
}

try {
  await waitForServer();

  const live = await fetch(`${base}/health`);
  const liveBody = await live.json();
  check('GET /health → 200 status=ok', live.status === 200 && liveBody.status === 'ok', `status ${live.status}`);
  check('X-Request-Id header set', Boolean(live.headers.get('x-request-id')));

  const ready = await fetch(`${base}/health/ready`);
  const readyBody = await ready.json();
  check(
    'GET /health/ready → 200 (db up) or 503 (db down)',
    [200, 503].includes(ready.status) && ['up', 'down'].includes(readyBody.checks?.database),
    `status ${ready.status}, database=${readyBody.checks?.database}`,
  );

  const notFound = await fetch(`${base}/does-not-exist`);
  const notFoundBody = await notFound.json();
  check('unknown route → 404 NOT_FOUND', notFound.status === 404 && notFoundBody.error?.code === 'NOT_FOUND', `status ${notFound.status}`);

  const badJson = await fetch(`${base}/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const badJsonBody = await badJson.json();
  check('malformed JSON → 400 BAD_REQUEST', badJson.status === 400 && badJsonBody.error?.code === 'BAD_REQUEST', `status ${badJson.status}`);

  // API wiring that needs no database: auth guard and request validation.
  const unauth = await fetch(`${base}/api/customers`);
  const unauthBody = await unauth.json();
  check('GET /api/customers without token → 401 UNAUTHORIZED', unauth.status === 401 && unauthBody.error?.code === 'UNAUTHORIZED', `status ${unauth.status}`);

  const badLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: 'short' }),
  });
  const badLoginBody = await badLogin.json();
  check('POST /api/auth/login invalid body → 400 VALIDATION_ERROR', badLogin.status === 400 && badLoginBody.error?.code === 'VALIDATION_ERROR', `status ${badLogin.status}`);
} catch (err) {
  check('server startup', false, String(err));
} finally {
  child.kill('SIGTERM');
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.info ? `  [${r.info}]` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\n${results.length} checks passed (${dev ? 'tsx' : 'dist'})` : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
