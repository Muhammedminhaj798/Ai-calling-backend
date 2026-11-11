import { Router } from 'express';
import { env } from '../../config/env.ts';
import { requireAuth } from '../../middleware/auth.ts';
import { rateLimit } from '../../middleware/rate-limit.ts';
import { validate } from '../../middleware/validate.ts';
import { authController } from './auth.controller.ts';
import { loginSchema, refreshSchema } from './auth.validation.ts';

const FIFTEEN_MINUTES = 15 * 60_000;

// Login is limited per client IP and per target email so neither a single attacker nor a
// distributed guess against one account gets unlimited attempts.
const loginByIp = rateLimit({ windowMs: FIFTEEN_MINUTES, max: env.LOGIN_RATE_LIMIT_PER_IP, key: (req) => req.ip });
const loginByEmail = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  max: env.LOGIN_RATE_LIMIT_PER_EMAIL,
  key: (req) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' ? `email:${email.trim().toLowerCase()}` : undefined;
  },
});
const refreshByIp = rateLimit({ windowMs: FIFTEEN_MINUTES, max: env.REFRESH_RATE_LIMIT_PER_IP, key: (req) => req.ip });

export const authRouter = Router();
authRouter.post('/login', loginByIp, loginByEmail, validate(loginSchema), authController.login);
authRouter.post('/refresh', refreshByIp, validate(refreshSchema), authController.refresh);
authRouter.post('/logout', validate(refreshSchema), authController.logout);
authRouter.get('/me', requireAuth, authController.me);
