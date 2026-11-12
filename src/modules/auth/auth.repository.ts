// Prisma queries for staff users and refresh tokens. No business rules here.
import { randomUUID } from 'node:crypto';
import { prisma } from '../../config/db.ts';
import type { RefreshToken, StaffUser } from '../../generated/prisma/client.ts';

export interface NewRefreshToken {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

/** The queries the auth service relies on (unit tests substitute an in-memory implementation). */
export interface AuthRepository {
  findUserByEmail(email: string): Promise<StaffUser | null>;
  findUserById(id: string): Promise<StaffUser | null>;
  touchLastLogin(id: string): Promise<unknown>;
  createRefreshToken(data: NewRefreshToken): Promise<unknown>;
  findRefreshTokenByHash(tokenHash: string): Promise<(RefreshToken & { user: StaffUser }) | null>;
  findRefreshTokenById(id: string): Promise<RefreshToken | null>;
  /** Replaces an active token; null when it was no longer active (another request rotated or revoked it). */
  rotateRefreshToken(oldId: string, next: NewRefreshToken): Promise<RefreshToken | null>;
  /** Revokes a token if it is still active; a no-op otherwise, so an existing revocation time is never moved. */
  revokeRefreshToken(id: string): Promise<unknown>;
  revokeAllForUser(userId: string): Promise<unknown>;
}

export const authRepository: AuthRepository = {
  findUserByEmail: (email) => prisma.staffUser.findUnique({ where: { email } }),
  findUserById: (id) => prisma.staffUser.findUnique({ where: { id } }),
  touchLastLogin: (id) => prisma.staffUser.update({ where: { id }, data: { lastLoginAt: new Date() } }),

  createRefreshToken: (data) => prisma.refreshToken.create({ data }),
  findRefreshTokenByHash: (tokenHash) => prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } }),
  findRefreshTokenById: (id) => prisma.refreshToken.findUnique({ where: { id } }),

  // Claim first, then create, in one transaction. The claim is a conditional UPDATE (revoked_at IS NULL): when
  // several requests rotate the same token at once, PostgreSQL row-locks it, the first commit wins and every later
  // UPDATE re-checks the condition against the committed row and matches 0 rows. So a token has at most one
  // successor and concurrent refreshes cannot fork the session into two valid chains.
  rotateRefreshToken: (oldId, next) =>
    prisma.$transaction(async (tx) => {
      const id = randomUUID();
      const claimed = await tx.refreshToken.updateMany({
        where: { id: oldId, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: id },
      });
      if (claimed.count !== 1) return null;
      return tx.refreshToken.create({ data: { id, ...next } });
    }),

  revokeRefreshToken: (id) => prisma.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } }),
  revokeAllForUser: (userId) =>
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
};
