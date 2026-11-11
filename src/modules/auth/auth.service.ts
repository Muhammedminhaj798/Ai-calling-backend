// Staff authentication: login, refresh-token rotation with reuse detection, logout, current user.
import { env } from '../../config/env.ts';
import type { StaffUser } from '../../generated/prisma/client.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { audit, type RequestMeta } from '../../utils/audit.ts';
import { authRepository as repo } from './auth.repository.ts';
import {
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  signAccessToken,
  verifyPassword,
} from './auth.tokens.ts';
import type { AuthSession, SafeUser } from './auth.types.ts';
import type { LoginInput } from './auth.validation.ts';

// Verified against when the email is unknown so response time does not reveal whether an account exists.
const dummyHash = hashPassword('dummy-password-for-constant-time-compare');

export function toSafeUser(user: StaffUser): SafeUser {
  const { id, email, name, role, isActive, lastLoginAt, createdAt } = user;
  return { id, email, name, role, isActive, lastLoginAt, createdAt };
}

async function issueSession(user: StaffUser, rotateFromId?: string): Promise<AuthSession> {
  const { token, hash } = generateRefreshToken();
  const refreshTokenExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const next = { userId: user.id, tokenHash: hash, expiresAt: refreshTokenExpiresAt };
  if (rotateFromId) await repo.rotateRefreshToken(rotateFromId, next);
  else await repo.createRefreshToken(next);

  return {
    accessToken: await signAccessToken({ id: user.id, role: user.role }),
    tokenType: 'Bearer',
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: token,
    refreshTokenExpiresAt,
    user: toSafeUser(user),
  };
}

export const authService = {
  async login(input: LoginInput, meta: RequestMeta): Promise<AuthSession> {
    const user = await repo.findUserByEmail(input.email);
    const passwordOk = user ? await verifyPassword(user.passwordHash, input.password) : false;
    if (!user) await verifyPassword(await dummyHash, input.password);

    if (!user || !passwordOk || !user.isActive) {
      await audit({
        actorType: 'anonymous',
        action: 'auth.login_failed',
        entityType: 'staff_user',
        entityId: user?.id ?? null,
        after: { email: input.email, reason: !user ? 'unknown_email' : !passwordOk ? 'bad_password' : 'inactive' },
        ...meta,
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const session = await issueSession(user);
    await repo.touchLastLogin(user.id);
    await audit({ actorType: 'staff', actorId: user.id, action: 'auth.login', entityType: 'staff_user', entityId: user.id, ...meta });
    return session;
  },

  async refresh(presentedToken: string, meta: RequestMeta): Promise<AuthSession> {
    const row = await repo.findRefreshTokenByHash(hashRefreshToken(presentedToken));
    if (!row) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is not valid');

    if (row.revokedAt) {
      // A *rotated* token presented again means it was copied: revoke every session of this user.
      // Tokens revoked by logout or by an earlier family revocation are simply invalid.
      if (row.replacedById) {
        await repo.revokeAllForUser(row.userId);
        await audit({
          actorType: 'anonymous',
          action: 'auth.refresh_reuse_detected',
          entityType: 'staff_user',
          entityId: row.userId,
          ...meta,
        });
      }
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token has been revoked');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new AppError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token expired, log in again');
    }
    if (!row.user.isActive) {
      await repo.revokeAllForUser(row.userId);
      throw new AppError(401, 'ACCOUNT_DISABLED', 'Account is disabled');
    }

    const session = await issueSession(row.user, row.id);
    await audit({ actorType: 'staff', actorId: row.userId, action: 'auth.refresh', entityType: 'staff_user', entityId: row.userId, ...meta });
    return session;
  },

  /** Revokes the presented refresh token if it is still active. Always succeeds so clients can clear state. */
  async logout(presentedToken: string | undefined, meta: RequestMeta): Promise<void> {
    let userId: string | null = null;
    if (presentedToken) {
      const row = await repo.findRefreshTokenByHash(hashRefreshToken(presentedToken));
      if (row) {
        userId = row.userId;
        if (!row.revokedAt) await repo.revokeRefreshToken(row.id);
      }
    }
    await audit({
      actorType: userId ? 'staff' : 'anonymous',
      actorId: userId,
      action: 'auth.logout',
      entityType: 'staff_user',
      entityId: userId,
      ...meta,
    });
  },

  async me(userId: string): Promise<SafeUser> {
    const user = await repo.findUserById(userId);
    if (!user || !user.isActive) throw new AppError(401, 'UNAUTHORIZED', 'Account not found or disabled');
    return toSafeUser(user);
  },
};
