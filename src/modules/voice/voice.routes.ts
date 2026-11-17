// POST /api/voice/sessions → a LiveKit room with the voice worker dispatched into it, plus the browser's join
// token. 404 unless LIVEKIT_ENABLED; 403 for any role but admin. Mounted at /api/voice by routes.ts.
import { Router } from 'express';
import { currentUser, requireAuth, requireRole, type AuthUser } from '../../middleware/auth.ts';
import { rateLimit } from '../../middleware/rate-limit.ts';
import { validate } from '../../middleware/validate.ts';
import { requestMeta } from '../../utils/audit.ts';
import { voiceService } from './voice.service.ts';
import { startVoiceSessionSchema, type StartVoiceSessionInput } from './voice.validation.ts';

// Admin only, in every environment: a browser call is a test call placed as any customer number, and its draft
// order is real. The call is persisted with calls.provider = 'livekit', which marks it as a test call.
const adminOnly = requireRole('admin');
// Each call spends LiveKit, model and speech minutes; a handful per user per 10 minutes is plenty for testing.
const perUser = rateLimit({ windowMs: 10 * 60_000, max: 10, key: (req) => (req.res?.locals['user'] as AuthUser | undefined)?.id });

export const voiceRouter = Router();
voiceRouter.use(requireAuth);
voiceRouter.post('/sessions', adminOnly, perUser, validate({ body: startVoiceSessionSchema }), async (req, res) => {
  const { body } = res.locals['input'] as { body: StartVoiceSessionInput };
  res.status(201).json(await voiceService.startSession(currentUser(res), body, requestMeta(req, res)));
});
