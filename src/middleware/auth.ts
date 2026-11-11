// requireAuth: validates the Bearer access token and exposes { id, role } as res.locals.user.
// requireRole: allow-list of roles for a route. Roles come from the token; access tokens live
// ≤ 15 minutes, and refresh re-checks the account, so a deactivated user is locked out within that window.
import type { RequestHandler, Response } from 'express';
import type { StaffRole } from '../generated/prisma/enums.ts';
import { verifyAccessToken, type AccessTokenClaims } from '../modules/auth/auth.tokens.ts';
import { AppError } from './error-handler.ts';

export type AuthUser = AccessTokenClaims;

export const requireAuth: RequestHandler = async (req, res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED', 'Missing bearer token');
  res.locals['user'] = await verifyAccessToken(header.slice('Bearer '.length).trim());
  next();
};

export function requireRole(...roles: StaffRole[]): RequestHandler {
  return (_req, res, next) => {
    const user = res.locals['user'] as AuthUser | undefined;
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    if (!roles.includes(user.role)) throw new AppError(403, 'FORBIDDEN', 'Insufficient role for this action');
    next();
  };
}

export function currentUser(res: Response): AuthUser {
  const user = res.locals['user'] as AuthUser | undefined;
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return user;
}
