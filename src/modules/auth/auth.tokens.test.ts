import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { AppError } from '../../middleware/error-handler.ts';
import {
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from './auth.tokens.ts';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.match(hash, /^\$argon2id\$/);
    assert.equal(await verifyPassword(hash, 'correct horse battery staple'), true);
    assert.equal(await verifyPassword(hash, 'wrong'), false);
    assert.equal(await verifyPassword('not-a-hash', 'wrong'), false);
  });
});

describe('access tokens', () => {
  const claims = { id: '22222222-2222-4222-8222-222222222222', role: 'approver' as const };

  it('round-trips subject and role', async () => {
    const token = await signAccessToken(claims);
    assert.deepEqual(await verifyAccessToken(token), claims);
  });

  it('rejects expired tokens with TOKEN_EXPIRED', async () => {
    const token = await signAccessToken(claims, -5);
    await assert.rejects(verifyAccessToken(token), (e: unknown) => e instanceof AppError && e.code === 'TOKEN_EXPIRED');
  });

  it('rejects tokens signed with another secret', async () => {
    const other = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.id)
      .setIssuer('ai-pharmacy-agent')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('another-secret-that-is-long-enough-0123456789'));
    await assert.rejects(verifyAccessToken(other), (e: unknown) => e instanceof AppError && e.code === 'UNAUTHORIZED');
  });

  it('rejects tokens carrying an unknown role', async () => {
    const forged = await new SignJWT({ role: 'superuser' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.id)
      .setIssuer('ai-pharmacy-agent')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(process.env['JWT_SECRET']));
    await assert.rejects(verifyAccessToken(forged), (e: unknown) => e instanceof AppError && e.code === 'UNAUTHORIZED');
  });
});

describe('refresh tokens', () => {
  it('generates unpredictable tokens and deterministic hashes', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    assert.notEqual(a.token, b.token);
    assert.equal(a.token.length, 64);
    assert.match(a.hash, /^[0-9a-f]{64}$/);
    assert.equal(hashRefreshToken(a.token), a.hash);
    assert.notEqual(a.hash, b.hash);
  });
});
