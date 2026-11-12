// Refresh-token rotation, reuse detection and the grace window for the immediately previous token, against an
// in-memory repository with PostgreSQL's semantics (snapshot reads, atomic conditional claim). The SQL itself is
// covered by tests/integration/auth.test.ts.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../tests/fakes/auth-repository.ts';
import { AppError } from '../../middleware/error-handler.ts';
import type { AuditEvent } from '../../utils/audit.ts';
import { createAuthService, REFRESH_REUSE_GRACE_MS } from './auth.service.ts';
import { hashRefreshToken } from './auth.tokens.ts';

const meta = { ip: '203.0.113.7', requestId: 'unit-test' };
const code = (expected: string) => (err: unknown) => err instanceof AppError && err.status === 401 && err.code === expected;
const rowOf = (repo: FakeAuthRepository, token: string) => [...repo.tokens.values()].find((t) => t.tokenHash === hashRefreshToken(token))!;

async function setup() {
  const repo = createFakeAuthRepository();
  const events: AuditEvent[] = [];
  const service = createAuthService({ repo, audit: async (e) => void events.push(e) });
  const user = await repo.addUser();
  const login = async () => (await service.login({ email: user.email, password: user.password }, meta)).refreshToken;
  const count = (action: string) => events.filter((e) => e.action === action).length;
  return { repo, service, user, login, count, events };
}

describe('refresh token rotation', () => {
  it('rotates: the old token is revoked and points to its single successor', async () => {
    const { repo, service, user, login, count } = await setup();
    const t1 = await login();
    const t2 = (await service.refresh(t1, meta)).refreshToken;
    assert.notEqual(t2, t1);
    assert.equal(rowOf(repo, t1).replacedById, rowOf(repo, t2).id);
    assert.ok(rowOf(repo, t1).revokedAt);
    assert.deepEqual(repo.activeTokens(user.id).map((t) => t.id), [rowOf(repo, t2).id]);
    assert.equal(count('auth.refresh'), 1);
  });

  it('aborted refresh: the response was lost, so the browser presents the previous token again within the grace window', async () => {
    const { repo, service, user, login, count } = await setup();
    const t1 = await login();
    const otherDevice = await login();
    const lost = (await service.refresh(t1, meta)).refreshToken; // rotated server-side, never reached the browser
    const tokensBefore = repo.tokens.size;

    await assert.rejects(service.refresh(t1, meta), code('REFRESH_TOKEN_SUPERSEDED'));
    assert.equal(repo.tokens.size, tokensBefore, 'the previous token never issues a new refresh token');
    assert.equal(count('auth.refresh_reuse_detected'), 0);
    assert.equal(count('auth.refresh_superseded'), 1);
    assert.equal(repo.activeTokens(user.id).length, 2, 'no session was revoked: the successor and the other device stay valid');
    assert.ok(await service.refresh(otherDevice, meta));
    assert.ok(await service.refresh(lost, meta), 'the chain itself is intact');
  });

  it('concurrent refreshes with one token: exactly one succeeds and no second chain is created', async () => {
    const { repo, service, user, login, count } = await setup();
    const t1 = await login();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.refresh(t1, meta)));

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(won.length, 1);
    assert.equal(lost.length, 4);
    for (const r of lost) assert.ok(code('REFRESH_TOKEN_SUPERSEDED')(r.reason), String(r.reason));
    assert.equal(repo.tokens.size, 2, 'the original token and one successor, nothing else');
    assert.equal(repo.activeTokens(user.id).length, 1);
    assert.equal(rowOf(repo, t1).replacedById, repo.activeTokens(user.id)[0]!.id);
    assert.equal(count('auth.refresh_reuse_detected'), 0);
  });

  it('retry within the grace window: the loser is refused until it presents the successor, then continues the chain', async () => {
    const { repo, service, user, login } = await setup();
    const t1 = await login();
    const results = await Promise.allSettled([service.refresh(t1, meta), service.refresh(t1, meta)]);
    const winner = results.find((r) => r.status === 'fulfilled');
    assert.ok(winner);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    const t2 = winner.value.refreshToken;

    // The retry may still carry the old cookie (the winner's Set-Cookie has not landed yet): refused again, no harm.
    await assert.rejects(service.refresh(t1, meta), code('REFRESH_TOKEN_SUPERSEDED'));
    // Once the browser holds the successor, the retry succeeds and the session continues as one chain.
    const t3 = (await service.refresh(t2, meta)).refreshToken;
    assert.deepEqual(repo.activeTokens(user.id).map((t) => t.id), [rowOf(repo, t3).id]);
  });

  it('the grace window covers only the immediately previous token: an older one is reuse even within 30 s', async () => {
    const { repo, service, user, login, count } = await setup();
    const t1 = await login();
    const t2 = (await service.refresh(t1, meta)).refreshToken;
    await service.refresh(t2, meta);

    await assert.rejects(service.refresh(t1, meta), code('INVALID_REFRESH_TOKEN'));
    assert.equal(count('auth.refresh_reuse_detected'), 1);
    assert.equal(repo.activeTokens(user.id).length, 0, 'every session of the user is revoked');
  });

  it('reuse after the grace window revokes every session of the user, as before', async () => {
    const { repo, service, user, login, count } = await setup();
    const t1 = await login();
    const otherDevice = await login();
    await service.refresh(t1, meta);
    repo.backdateRevocation(rowOf(repo, t1).id, REFRESH_REUSE_GRACE_MS + 1);

    await assert.rejects(service.refresh(t1, meta), code('INVALID_REFRESH_TOKEN'));
    assert.equal(count('auth.refresh_reuse_detected'), 1);
    assert.equal(repo.activeTokens(user.id).length, 0);
    await assert.rejects(service.refresh(otherDevice, meta), code('INVALID_REFRESH_TOKEN'));
  });

  it('a token revoked by logout gets no grace, and expired tokens are still refused', async () => {
    const { repo, service, user, login, count } = await setup();
    const t1 = await login();
    await service.logout(t1, meta);
    await assert.rejects(service.refresh(t1, meta), code('INVALID_REFRESH_TOKEN'));
    assert.equal(count('auth.refresh_superseded'), 0);

    const t2 = await login();
    rowOf(repo, t2).expiresAt = new Date(Date.now() - 1);
    await assert.rejects(service.refresh(t2, meta), code('REFRESH_TOKEN_EXPIRED'));
    assert.equal(repo.activeTokens(user.id).length, 1, 'the expired row is left as is; nothing new was issued');
  });

  it('logout with the superseded token (aborted refresh) also ends the successor it never received', async () => {
    const { repo, service, user, login } = await setup();
    const t1 = await login();
    const otherDevice = await login();
    const lost = (await service.refresh(t1, meta)).refreshToken;

    await service.logout(t1, meta);
    await assert.rejects(service.refresh(lost, meta), code('INVALID_REFRESH_TOKEN'));
    assert.deepEqual(repo.activeTokens(user.id).map((t) => t.id), [rowOf(repo, otherDevice).id], 'other sessions are untouched');
  });

  it('never writes a refresh token into the audit trail', async () => {
    const { service, login, events } = await setup();
    const t1 = await login();
    const t2 = (await service.refresh(t1, meta)).refreshToken;
    await assert.rejects(service.refresh(t1, meta));
    await service.logout(t2, meta);
    const trail = JSON.stringify(events);
    for (const token of [t1, t2]) {
      assert.ok(!trail.includes(token));
      assert.ok(!trail.includes(hashRefreshToken(token)));
    }
  });
});
