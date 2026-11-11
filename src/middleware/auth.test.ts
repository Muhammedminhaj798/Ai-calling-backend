import '../../tests/env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { signAccessToken } from '../modules/auth/auth.tokens.ts';
import { currentUser, requireAuth, requireRole, type AuthUser } from './auth.ts';
import { AppError } from './error-handler.ts';

const USER: AuthUser = { id: '11111111-1111-4111-8111-111111111111', role: 'staff' };

function fakeReq(authorization?: string): Request {
  return { header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined) } as unknown as Request;
}
const fakeRes = (locals: Record<string, unknown> = {}): Response => ({ locals }) as unknown as Response;

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof AppError && err.status === status && err.code === code);
}

describe('requireAuth', () => {
  it('accepts a valid bearer token and exposes the user', async () => {
    const token = await signAccessToken(USER);
    const res = fakeRes();
    let called = false;
    await requireAuth(fakeReq(`Bearer ${token}`), res, (() => (called = true)) as NextFunction);
    assert.equal(called, true);
    assert.deepEqual(res.locals['user'], USER);
    assert.deepEqual(currentUser(res), USER);
  });

  it('rejects a missing or malformed header', async () => {
    await rejectsWith(requireAuth(fakeReq(), fakeRes(), () => {}) as Promise<void>, 401, 'UNAUTHORIZED');
    await rejectsWith(requireAuth(fakeReq('Basic abc'), fakeRes(), () => {}) as Promise<void>, 401, 'UNAUTHORIZED');
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const expired = await signAccessToken(USER, -30);
    await rejectsWith(requireAuth(fakeReq(`Bearer ${expired}`), fakeRes(), () => {}) as Promise<void>, 401, 'TOKEN_EXPIRED');
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken(USER);
    const tampered = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await rejectsWith(requireAuth(fakeReq(`Bearer ${tampered}`), fakeRes(), () => {}) as Promise<void>, 401, 'UNAUTHORIZED');
  });
});

describe('requireRole', () => {
  it('allows listed roles and forbids others', () => {
    let called = 0;
    requireRole('admin', 'staff')(fakeReq(), fakeRes({ user: USER }), (() => called++) as NextFunction);
    assert.equal(called, 1);
    assert.throws(
      () => requireRole('admin')(fakeReq(), fakeRes({ user: USER }), () => {}),
      (err: unknown) => err instanceof AppError && err.status === 403 && err.code === 'FORBIDDEN',
    );
  });

  it('returns 401 when no user was authenticated', () => {
    assert.throws(
      () => requireRole('admin')(fakeReq(), fakeRes(), () => {}),
      (err: unknown) => err instanceof AppError && err.status === 401,
    );
    assert.throws(() => currentUser(fakeRes()), (err: unknown) => err instanceof AppError && err.status === 401);
  });
});
