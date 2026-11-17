// Loads .env (if present) and validates process.env once at boot.
// Values are never logged; only the names of invalid variables are printed.
// Every module that touches the database imports config/db.ts, which imports this file first, so the database
// protection check below runs (and exits on failure) before a PrismaClient exists: in the API, the voice worker and
// each of its job processes, and every script that loads the app config.
import 'dotenv/config';
import { z } from 'zod';
import { ANTHROPIC_DEFAULTS, ANTHROPIC_EFFORTS } from '../integrations/ai/anthropic.adapter.ts';
import { appSharesTestDatabase, databaseUrlPairProblems, runtimeDatabaseProblem } from '../utils/db-identity.ts';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// connection string'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:3000'),
  // Number of reverse-proxy hops in front of the app whose X-Forwarded-For entries are trusted for req.ip
  // (rate limits, audit logs). 0 = trust none, so req.ip is the connecting proxy. Set it only to a value
  // verified from real traffic (LOG_LEVEL=debug logs the chain): too high lets clients spoof their IP.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
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
  ANTHROPIC_MODEL: z.string().min(1).default(ANTHROPIC_DEFAULTS.model),
  // Thinking depth (always on): low keeps phone-call latency down; raise to medium if measured quality drops
  ANTHROPIC_EFFORT: z.enum(ANTHROPIC_EFFORTS).default(ANTHROPIC_DEFAULTS.effort),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(ANTHROPIC_DEFAULTS.timeoutMs),
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

  // Speech providers: mock for tests/dev; google = REST recognize/synthesize (needs GOOGLE_SPEECH_API_KEY);
  // sarvam = Sarvam AI saaras speech-to-text / bulbul text-to-speech over REST (needs SARVAM_API_KEY)
  STT_PROVIDER: z.enum(['mock', 'google', 'sarvam']).default('mock'),
  TTS_PROVIDER: z.enum(['mock', 'google', 'sarvam']).default('mock'),
  GOOGLE_SPEECH_API_KEY: z.string().min(1).optional(),
  SARVAM_API_KEY: z.string().min(1).optional(),
  SARVAM_STT_MODEL: z.string().min(1).default('saaras:v4'),
  // auto = Sarvam detects each utterance's language (callers switch languages); session = the session's language
  SARVAM_STT_LANGUAGE: z.enum(['auto', 'session']).default('auto'),
  SARVAM_TTS_MODEL: z.string().min(1).default('bulbul:v3'),
  SARVAM_TTS_SPEAKER: z.string().regex(/^[a-z0-9_]+$/, 'a lowercase Sarvam speaker id').default('shubh'),

  // Telephony: mock for tests/dev; exotel = inbound webhooks + Voicebot media stream; none = no phone line connected
  // (telephony webhooks and media stream answer 404; LiveKit browser test calls are unaffected)
  TELEPHONY_PROVIDER: z.enum(['mock', 'exotel', 'none']).default('mock'),
  // Unguessable token embedded in the webhook and media-stream URLs Exotel is configured with
  EXOTEL_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Comma-separated allow-list of Exotel source IPs; empty = no IP check (secret only)
  EXOTEL_ALLOWED_IPS: z.string().optional(),
  // Staff phone number the call is transferred to on human handover (E.164)
  HANDOVER_PHONE_NUMBER: z.string().optional(),
  // Energy threshold (16-bit PCM RMS) above which a frame counts as speech
  VAD_RMS_THRESHOLD: z.coerce.number().int().min(50).max(10_000).default(450),

  // LiveKit browser voice calls. POST /api/voice/sessions (this API) is off unless LIVEKIT_ENABLED=true; the
  // voice worker (src/voice-worker.ts, a separate process) always needs URL, key and secret. Both processes must
  // use the same values and agent name. The secret stays on the server: browsers only get short-lived tokens.
  LIVEKIT_ENABLED: z.stringbool().default(false),
  LIVEKIT_URL: z.url({ protocol: /^wss?$/ }).optional(),
  LIVEKIT_API_KEY: z.string().min(1).optional(),
  LIVEKIT_API_SECRET: z.string().min(1).optional(),
  // Explicit-dispatch name: the API dispatches it and the worker registers under it. Use a different name per
  // environment so a local worker never takes calls meant for another environment's database.
  LIVEKIT_AGENT_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, - and _ only').default('pharmacy-voice'),
  // Job processes the worker keeps warm; each one loads the whole backend, so keep this small on small instances
  LIVEKIT_WORKER_IDLE_PROCESSES: z.coerce.number().int().min(1).max(8).default(1),
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
  .refine((e) => (e.STT_PROVIDER !== 'sarvam' && e.TTS_PROVIDER !== 'sarvam') || Boolean(e.SARVAM_API_KEY), {
    message: 'SARVAM_API_KEY is required when STT_PROVIDER or TTS_PROVIDER is sarvam',
    path: ['SARVAM_API_KEY'],
  })
  .refine((e) => e.TELEPHONY_PROVIDER !== 'exotel' || Boolean(e.EXOTEL_WEBHOOK_SECRET), {
    message: 'EXOTEL_WEBHOOK_SECRET is required when TELEPHONY_PROVIDER=exotel',
    path: ['TELEPHONY_PROVIDER'],
  })
  .refine((e) => !e.LIVEKIT_ENABLED || Boolean(e.LIVEKIT_URL && e.LIVEKIT_API_KEY && e.LIVEKIT_API_SECRET), {
    message: 'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required when LIVEKIT_ENABLED=true',
    path: ['LIVEKIT_ENABLED'],
  });

export type Env = z.infer<typeof EnvSchema>;

/** Providers that production never runs as mock. Inventory is decided separately (see parseEnv). */
const LIVE_ONLY_PROVIDERS = ['AI_PROVIDER', 'STT_PROVIDER', 'TTS_PROVIDER', 'TELEPHONY_PROVIDER'] as const;

export type EnvResult = { ok: true; env: Env; warnings: string[] } | { ok: false; error: string };

/**
 * Validates raw variables. Production also refuses simulated providers — an unset provider defaults to mock, so a
 * missing one is refused too — and needs INVENTORY_ADAPTER set explicitly: until the database inventory adapter
 * exists, `mock` (the local inventory table, labelled simulated) is accepted with a warning. Outside tests the database
 * URLs are checked too — DIRECT_DATABASE_URL a non-pooler URL of the same database, DATABASE_URL never the integration-
 * test database — as errors in production and warnings in development. In every NODE_ENV, DATABASE_URL must not be a
 * protected database (PROTECTED_DATABASE_IDENTITIES, required) unless production authorises exactly it
 * (runtimeDatabaseProblem). Errors name variables and database identities, never values, credentials or URLs.
 */
export function parseEnv(raw: Record<string, string | undefined>): EnvResult {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const e = parsed.data;
  const problems: string[] = [];
  const warnings: string[] = [];
  const databaseProblem = runtimeDatabaseProblem(raw, e.NODE_ENV);
  if (databaseProblem) problems.push(databaseProblem);
  if (e.NODE_ENV === 'production') {
    for (const name of LIVE_ONLY_PROVIDERS) {
      if (e[name] === 'mock') {
        problems.push(`${name} is "mock" or not set; production needs a real provider${name === 'TELEPHONY_PROVIDER' ? ' (or "none" when no phone line is connected)' : ''}`);
      }
    }
    if (!raw['INVENTORY_ADAPTER']?.trim()) problems.push('INVENTORY_ADAPTER must be set explicitly in production');
    else if (e.INVENTORY_ADAPTER === 'mock') warnings.push('INVENTORY_ADAPTER=mock: stock comes from the local inventory table and is labelled simulated');
  }
  // The integration runner itself sets DATABASE_URL to the test database under NODE_ENV=test.
  if (e.NODE_ENV !== 'test') {
    const dbProblems = databaseUrlPairProblems(raw, '');
    if (appSharesTestDatabase(raw)) dbProblems.push('DATABASE_URL is the same database as TEST_DATABASE_URL, which integration tests truncate');
    (e.NODE_ENV === 'production' ? problems : warnings).push(...dbProblems);
  }
  return problems.length > 0 ? { ok: false, error: problems.map((p) => `✖ ${p}`).join('\n') } : { ok: true, env: e, warnings };
}

const result = parseEnv(process.env);
if (!result.ok) {
  console.error('Invalid environment configuration:\n' + result.error);
  process.exit(1);
}
for (const warning of result.warnings) console.warn(`Configuration warning: ${warning}`);

export const env: Env = result.env;
