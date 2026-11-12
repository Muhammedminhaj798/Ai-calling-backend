// Dashboard support routes (build step 5). Read-only.
//   GET /api/settings  → which provider each integration uses and whether its credential is SET (never the value)
//   GET /api/staff     → active staff users for exception assignment (id, name, email, role)
// Neither route mutates anything; configuration stays in the server environment.
import { Router } from 'express';
import { prisma } from '../../config/db.ts';
import { env } from '../../config/env.ts';
import { requireAuth, requireRole } from '../../middleware/auth.ts';

const anyRole = requireRole('admin', 'staff', 'approver');

export const settingsRouter = Router();
settingsRouter.use(requireAuth);
settingsRouter.get('/', anyRole, (_req, res) => {
  res.json({
    environment: env.NODE_ENV,
    providers: {
      ai: env.AI_PROVIDER === 'anthropic'
        ? { provider: env.AI_PROVIDER, configured: Boolean(env.ANTHROPIC_API_KEY), model: env.ANTHROPIC_MODEL, effort: env.ANTHROPIC_EFFORT }
        : { provider: env.AI_PROVIDER, configured: Boolean(env.OPENAI_API_KEY), model: env.OPENAI_MODEL },
      stt: { provider: env.STT_PROVIDER, configured: Boolean(env.GOOGLE_SPEECH_API_KEY) },
      tts: { provider: env.TTS_PROVIDER, configured: Boolean(env.GOOGLE_SPEECH_API_KEY) },
      telephony: {
        provider: env.TELEPHONY_PROVIDER,
        configured: Boolean(env.EXOTEL_WEBHOOK_SECRET),
        handoverNumberConfigured: Boolean(env.HANDOVER_PHONE_NUMBER),
        ipAllowListConfigured: Boolean(env.EXOTEL_ALLOWED_IPS),
      },
      inventory: { provider: env.INVENTORY_ADAPTER, configured: Boolean(env.CLIENT_INVENTORY_BASE_URL && env.CLIENT_INVENTORY_API_KEY) },
    },
    reservation: { ttlHours: env.RESERVATION_TTL_HOURS, sweepIntervalSeconds: env.RESERVATION_SWEEP_INTERVAL_SECONDS, maxOrderItems: env.MAX_ORDER_ITEMS },
    conversation: {
      defaultLanguage: env.DEFAULT_LANGUAGE,
      maxToolRounds: env.AI_MAX_TOOL_ROUNDS,
      historyMessages: env.AI_HISTORY_MESSAGES,
      idleTimeoutMinutes: env.CONVERSATION_IDLE_TIMEOUT_MINUTES,
    },
  });
});

export const staffRouter = Router();
staffRouter.use(requireAuth);
staffRouter.get('/', anyRole, async (_req, res) => {
  res.json({ staff: await prisma.staffUser.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true, role: true }, orderBy: { name: 'asc' } }) });
});
