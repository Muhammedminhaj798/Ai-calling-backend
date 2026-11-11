// Prisma queries for staff users and refresh tokens. No business rules here.
import { prisma } from '../../config/db.ts';

export interface NewRefreshToken {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export const authRepository = {
  findUserByEmail: (email: string) => prisma.staffUser.findUnique({ where: { email } }),
  findUserById: (id: string) => prisma.staffUser.findUnique({ where: { id } }),
  touchLastLogin: (id: string) => prisma.staffUser.update({ where: { id }, data: { lastLoginAt: new Date() } }),

  createRefreshToken: (data: NewRefreshToken) => prisma.refreshToken.create({ data }),
  findRefreshTokenByHash: (tokenHash: string) =>
    prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } }),

  /** Creates the replacement and revokes the old token in one transaction. */
  rotateRefreshToken: (oldId: string, next: NewRefreshToken) =>
    prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({ data: next });
      await tx.refreshToken.update({ where: { id: oldId }, data: { revokedAt: new Date(), replacedById: created.id } });
      return created;
    }),

  revokeRefreshToken: (id: string) => prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } }),
  revokeAllForUser: (userId: string) =>
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
};
