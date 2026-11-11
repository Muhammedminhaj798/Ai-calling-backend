// HTTP handlers for /api/auth. The refresh token travels in an HTTP-only cookie scoped to /api/auth
// (and is echoed in the JSON body for non-browser clients).
import type { Request, RequestHandler, Response } from 'express';
import { env } from '../../config/env.ts';
import { currentUser } from '../../middleware/auth.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { requestMeta } from '../../utils/audit.ts';
import { parseCookies } from '../../utils/cookies.ts';
import { authService } from './auth.service.ts';
import type { AuthSession } from './auth.types.ts';
import type { LoginInput } from './auth.validation.ts';

export const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/auth';

function presentedRefreshToken(req: Request): string | undefined {
  const fromCookie = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
  const fromBody = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
  return fromCookie ?? fromBody;
}

function sendSession(res: Response, session: AuthSession): void {
  res.cookie(REFRESH_COOKIE, session.refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.NODE_ENV === 'production',
    path: COOKIE_PATH,
    expires: session.refreshTokenExpiresAt,
  });
  res.json(session);
}

const login: RequestHandler = async (req, res) => {
  const session = await authService.login(req.body as LoginInput, requestMeta(req, res));
  sendSession(res, session);
};

const refresh: RequestHandler = async (req, res) => {
  const token = presentedRefreshToken(req);
  if (!token) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'No refresh token provided');
  sendSession(res, await authService.refresh(token, requestMeta(req, res)));
};

const logout: RequestHandler = async (req, res) => {
  await authService.logout(presentedRefreshToken(req), requestMeta(req, res));
  res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  res.status(204).end();
};

const me: RequestHandler = async (_req, res) => {
  res.json({ user: await authService.me(currentUser(res).id) });
};

export const authController = { login, refresh, logout, me };
