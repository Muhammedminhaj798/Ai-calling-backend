// Loads .env (if present) and validates process.env once at boot.
// Values are never logged; only the names of invalid variables are printed.
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection string'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Staff authentication
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  // Attempts per 15-minute window. Raised only in test environments where every request shares one IP.
  LOGIN_RATE_LIMIT_PER_IP: z.coerce.number().int().min(1).default(20),
  LOGIN_RATE_LIMIT_PER_EMAIL: z.coerce.number().int().min(1).default(10),
  REFRESH_RATE_LIMIT_PER_IP: z.coerce.number().int().min(1).default(60),

  // Inventory adapter. "client_api" selects the production adapter, which stays non-functional until the
  // client documents its API (ARCHITECTURE.md §B.6, §G-3); the mock answers from the local inventory table.
  INVENTORY_ADAPTER: z.enum(['mock', 'client_api']).default('mock'),
  CLIENT_INVENTORY_BASE_URL: z.url().optional(),
  CLIENT_INVENTORY_API_KEY: z.string().min(1).optional(),

  // Orders and reservations
  MAX_ORDER_ITEMS: z.coerce.number().int().min(1).max(100).default(15),
  RESERVATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  // 0 disables the in-process expiry sweeper (tests call it directly)
  RESERVATION_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

  // --- AI conversation engine (build step 4) ---
  // mock = scripted provider for tests/dev; anthropic = Claude (needs ANTHROPIC_API_KEY); openai = Chat
  // Completions (needs OPENAI_API_KEY). A failing real provider hands the call to staff, never to the mock.
  AI_PROVIDER: z.enum(['mock', 'openai', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5-5'),
  // Thinking depth (always on): low keeps phone-call latency down; raise to medium if measured quality drops
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  // USD per 1M tokens, used only to fill usage_costs; 0 records tokens without a cost
  ANTHROPIC_PRICE_INPUT_USD_PER_1M: z.coerce.number().min(0).default(0),
  ANTHROPIC_PRICE_OUTPUT_USD_PER_1M: z.coerce.number().min(0).default(0),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-4.1-mini'),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  // USD per 1M tokens, used only to fill usage_costs; 0 records tokens without a cost
  OPENAI_PRICE_INPUT_USD_PER_1M: z.coerce.number().min(0).default(0),
  OPENAI_PRICE_OUTPUT_USD_PER_1M: z.coerce.number().min(0).default(0),
  AI_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(20).default(8),
  AI_HISTORY_MESSAGES: z.coerce.number().int().min(6).max(400).default(60),
  DEFAULT_LANGUAGE: z.enum(['en', 'ml', 'ta', 'hi']).default('en'),
  CONVERSATION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(30),

  // Speech providers: mock for tests/dev; google = REST recognize/synthesize (needs GOOGLE_SPEECH_API_KEY)
  STT_PROVIDER: z.enum(['mock', 'google']).default('mock'),
  TTS_PROVIDER: z.enum(['mock', 'google']).default('mock'),
  GOOGLE_SPEECH_API_KEY: z.string().min(1).optional(),

  // Telephony: mock for tests/dev; exotel = inbound webhooks + Voicebot media stream
  TELEPHONY_PROVIDER: z.enum(['mock', 'exotel']).default('mock'),
  // Unguessable token embedded in the webhook and media-stream URLs Exotel is configured with
  EXOTEL_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Comma-separated allow-list of Exotel source IPs; empty = no IP check (secret only)
  EXOTEL_ALLOWED_IPS: z.string().optional(),
  // Staff phone number the call is transferred to on human handover (E.164)
  HANDOVER_PHONE_NUMBER: z.string().optional(),
  // Energy threshold (16-bit PCM RMS) above which a frame counts as speech
  VAD_RMS_THRESHOLD: z.coerce.number().int().min(50).max(10_000).default(450),
})
  .refine((e) => e.INVENTORY_ADAPTER !== 'client_api' || (e.CLIENT_INVENTORY_BASE_URL && e.CLIENT_INVENTORY_API_KEY), {
    message: 'CLIENT_INVENTORY_BASE_URL and CLIENT_INVENTORY_API_KEY are required when INVENTORY_ADAPTER=client_api',
    path: ['INVENTORY_ADAPTER'],
  })
  .refine((e) => e.AI_PROVIDER !== 'openai' || Boolean(e.OPENAI_API_KEY), { message: 'OPENAI_API_KEY is required when AI_PROVIDER=openai', path: ['AI_PROVIDER'] })
  .refine((e) => e.AI_PROVIDER !== 'anthropic' || Boolean(e.ANTHROPIC_API_KEY), { message: 'ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic', path: ['AI_PROVIDER'] })
  .refine((e) => (e.STT_PROVIDER !== 'google' && e.TTS_PROVIDER !== 'google') || Boolean(e.GOOGLE_SPEECH_API_KEY), {
    message: 'GOOGLE_SPEECH_API_KEY is required when STT_PROVIDER or TTS_PROVIDER is google',
    path: ['GOOGLE_SPEECH_API_KEY'],
  })
  .refine((e) => e.TELEPHONY_PROVIDER !== 'exotel' || Boolean(e.EXOTEL_WEBHOOK_SECRET), {
    message: 'EXOTEL_WEBHOOK_SECRET is required when TELEPHONY_PROVIDER=exotel',
    path: ['TELEPHONY_PROVIDER'],
  });

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env: Env = parsed.data;
