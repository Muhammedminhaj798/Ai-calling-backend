// Staff authentication: login, refresh-token rotation with reuse detection, logout, current user.
import { env } from '../../config/env.ts';
import type { RefreshToken, StaffUser } from '../../generated/prisma/client.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { audit as writeAudit, type AuditEvent, type RequestMeta } from '../../utils/audit.ts';
import { authRepository, type AuthRepository, type NewRefreshToken } from './auth.repository.ts';
import {
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  signAccessToken,
  verifyPassword,
} from './auth.tokens.ts';
import type { AuthSession, SafeUser } from './auth.types.ts';
import type { LoginInput } from './auth.validation.ts';

/**
 * How long after a rotation the immediately previous refresh token may be presented again without counting as
 * theft. A browser can legitimately do that when the refresh response never arrived (page reload, aborted request)
 * or when two requests refresh with one cookie at once. Within the window, and only while that token's successor is
 * still the live token, it is refused with REFRESH_TOKEN_SUPERSEDED: nothing is revoked and nothing is issued.
 * Outside it, or once the successor was itself rotated or revoked, reuse revokes every session of the user.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;

// Verified against when the email is unknown so response time does not reveal whether an account exists.
const dummyHash = hashPassword('dummy-password-for-constant-time-compare');

export function toSafeUser(user: StaffUser): SafeUser {
  const { id, email, name, role, isActive, lastLoginAt, createdAt } = user;
  return { id, email, name, role, isActive, lastLoginAt, createdAt };
}

export interface AuthServiceDeps {
  repo: AuthRepository;
  audit: (event: AuditEvent) => Promise<void>;
}

export function createAuthService({ repo, audit }: AuthServiceDeps) {
  function newRefreshToken(userId: string): { token: string; row: NewRefreshToken } {
    const { token, hash } = generateRefreshToken();
    return { token, row: { userId, tokenHash: hash, expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000) } };
  }

  async function toSession(user: StaffUser, refresh: { token: string; row: NewRefreshToken }): Promise<AuthSession> {
    return {
      accessToken: await signAccessToken({ id: user.id, role: user.role }),
      tokenType: 'Bearer',
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.row.expiresAt,
      user: toSafeUser(user),
    };
  }

  /** Refuses a token that is no longer active, telling a benign repeat (grace window) from a copied token. */
  async function rejectRevoked(row: RefreshToken, meta: RequestMeta): Promise<never> {
    if (row.replacedById) {
      const withinGrace = row.revokedAt !== null && Date.now() - row.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
      const successor = withinGrace ? await repo.findRefreshTokenById(row.replacedById) : null;
      if (successor && !successor.revokedAt) {
        await audit({ actorType: 'anonymous', action: 'auth.refresh_superseded', entityType: 'staff_user', entityId: row.userId, ...meta });
        throw new AppError(401, 'REFRESH_TOKEN_SUPERSEDED', 'Refresh token was already rotated');
      }
      // A rotated token presented again outside the grace window was copied: revoke every session of this user.
      await repo.revokeAllForUser(row.userId);
      await audit({ actorType: 'anonymous', action: 'auth.refresh_reuse_detected', entityType: 'staff_user', entityId: row.userId, ...meta });
    }
    // Tokens revoked by logout or by an earlier family revocation are simply invalid.
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token has been revoked');
  }

  return {
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

      const refresh = newRefreshToken(user.id);
      await repo.createRefreshToken(refresh.row);
      const session = await toSession(user, refresh);
      await repo.touchLastLogin(user.id);
      await audit({ actorType: 'staff', actorId: user.id, action: 'auth.login', entityType: 'staff_user', entityId: user.id, ...meta });
      return session;
    },

    async refresh(presentedToken: string, meta: RequestMeta): Promise<AuthSession> {
      const tokenHash = hashRefreshToken(presentedToken);
      const row = await repo.findRefreshTokenByHash(tokenHash);
      if (!row) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is not valid');
      if (row.revokedAt) return rejectRevoked(row, meta);
      if (row.expiresAt.getTime() <= Date.now()) {
        throw new AppError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token expired, log in again');
      }
      if (!row.user.isActive) {
        await repo.revokeAllForUser(row.userId);
        throw new AppError(401, 'ACCOUNT_DISABLED', 'Account is disabled');
      }

      const next = newRefreshToken(row.userId);
      if (!(await repo.rotateRefreshToken(row.id, next.row))) {
        // Another request rotated (or a logout revoked) this token between our read and our claim: judge it as such.
        return rejectRevoked((await repo.findRefreshTokenByHash(tokenHash)) ?? row, meta);
      }
      const session = await toSession(row.user, next);
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
          await repo.revokeRefreshToken(row.id);
          // A rotated token here means this client never received its successor (aborted refresh, see
          // REFRESH_REUSE_GRACE_MS). End that successor too rather than leave it valid until it expires.
          if (row.replacedById) await repo.revokeRefreshToken(row.replacedById);
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
}

export const authService = createAuthService({ repo: authRepository, audit: writeAudit });
