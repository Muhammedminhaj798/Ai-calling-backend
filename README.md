# AI Pharmacy Order Agent — backend

Express 5 (ESM) · TypeScript · Prisma 7 · PostgreSQL. REST API, AI conversation engine, speech and telephony adapters (mock by default), order management with stock reservations, staff approvals and exception handling for an AI phone order agent for wholesale pharmacies. The staff dashboard lives in the separate `Ai-calling-fronted` repository. Architecture, build-step reports and screenshots are in [Ai-calling-docs](https://github.com/Muhammedminhaj798/Ai-calling-docs); the API contract is §B of its [ARCHITECTURE.md](https://github.com/Muhammedminhaj798/Ai-calling-docs/blob/main/ARCHITECTURE.md).

## Run

```bash
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, PROTECTED_DATABASE_IDENTITIES, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD
npm install                   # also runs prisma generate
npm run prisma:deploy         # apply migrations (needs PROTECTED_DATABASE_IDENTITIES; see "Prisma command guard")
npm run seed -- --samples     # admin user plus clearly labelled mock staff, products and customer (interactive: type the database name; needs PROTECTED_DATABASE_IDENTITIES)
npm run dev                   # http://localhost:4000  (health: /health, /health/ready)
```

Every provider (AI, STT, TTS, telephony, inventory) runs in mock mode until its keys are configured in `.env`; `GET /api/settings` reports the current mode.

## Checks

```bash
npm run typecheck && npm run lint && npm run build
npm run test:unit
npm run test:integration      # needs TEST_DATABASE_URL pointing at a dedicated test database
npm run smoke                 # against a running server
npm run ai:smoke              # one real, text-only Claude request (needs ANTHROPIC_API_KEY; costs tokens)
```

**Integration test database guard.** The integration tests truncate every table, so `npm run test:integration` first checks (`scripts/db-guard.ts`) that `TEST_DATABASE_URL` is not the database behind `DATABASE_URL` or `DIRECT_DATABASE_URL`. It compares identities derived from the URLs, without connecting: credentials and parameters are ignored, hostnames are normalised, and a Neon pooled host is matched to its direct host by endpoint id. It allows only two cases: a different database name on the same server, or a different Neon endpoint (another branch or project). It refuses when the database is the same, when either URL cannot be identified, and when the two hosts merely differ (a DNS alias, IP, proxy or tunnel could still be one server). In that last case, after verifying the test database yourself, set `TEST_DATABASE_CONFIRMED_SEPARATE` to the identity printed in the refusal. That only unlocks that exact test identity, and never a "same database" result. `TEST_DIRECT_DATABASE_URL`, if set, must be the test database and not a Neon pooler. The suites truncate only when the runner has verified the database they are connected to. Production is not in the local environment, so the guard also needs `PROTECTED_DATABASE_IDENTITIES` (identities such as `neon:<endpoint-id>/<database>`, never URLs; see `.env.example`): until it is set, nothing runs, and a test database that is a protected identity is refused with no override. The runner forces every provider to its mock (`AI_PROVIDER=mock` included) with placeholder keys, so a run never bills a real service.

**Prisma command guard.** `prisma.config.ts` runs `scripts/prisma-guard.ts` before every Prisma command. Prisma loads the config in-process before it dispatches, so the guard sees the real arguments. Commands that can reach a database are `migrate` (dev, reset, deploy, status, resolve, diff), `db` (push, execute, pull, seed), `studio`, `bootstrap`, `postgres link` and `mcp`. They are found wherever they appear in the arguments, around `--schema` / `--config` and their values. These commands refuse to run in four cases:

- `PROTECTED_DATABASE_IDENTITIES` is missing or invalid.
- The datasource (`DIRECT_DATABASE_URL`, else `DATABASE_URL`) cannot be identified, or is a Neon pooler.
- The datasource is a protected database.
- The datasource is on a different host than the protected ones and is not confirmed with `DATABASE_CONFIRMED_SEPARATE=<identity>`.

`--url`, `--from-url`, `--to-url` and every other URL flag are refused on all commands, because they would bypass the checked datasource. Only `migrate deploy` and `migrate status` may run on a protected database, and only with `ALLOW_PROTECTED_MIGRATE_DEPLOY` set to that database's exact identity for that one command. That setting never unlocks `migrate dev`, `migrate reset`, `db push`, `db execute`, Studio or any other command. Commands that never open the datasource are not checked: `generate`, `validate`, `format`, `version`, `init`, `debug`, `telemetry`, `platform` and `dev` (a separate local Prisma Postgres). An unknown command, such as one added by a Prisma upgrade, is checked like `migrate dev` until it is classified.

**Startup database protection.** The API, the voice worker and each of its job processes check `DATABASE_URL` in `src/config/env.ts`. That file loads before `src/config/db.ts` creates the only `PrismaClient`, so the check runs before any connection. It uses the same identity logic as the Prisma guard (`checkProtectedTarget` in `src/utils/db-identity.ts`). In every `NODE_ENV`, startup is refused in four cases:

- `PROTECTED_DATABASE_IDENTITIES` is missing or invalid.
- `DATABASE_URL` cannot be identified.
- `DATABASE_URL` is on a different host than the protected ones and is not confirmed with `DATABASE_CONFIRMED_SEPARATE=<identity>`.
- `DATABASE_URL` is a protected database without the production authorisation below.

Only `NODE_ENV=production` may use a protected database, and only with `ALLOW_PROTECTED_RUNTIME_DATABASE` set to its exact identity. Wildcards are not accepted. Under any other `NODE_ENV` that variable stops startup on its own, so a production setting copied into development unlocks nothing. In production, a value that does not name `DATABASE_URL`'s database also stops startup. It is separate from `ALLOW_PROTECTED_MIGRATE_DEPLOY`, which only the Prisma CLI reads. Messages name variables and identities, never credentials or URLs.

**Claude smoke test.** `npm run ai:smoke` sends one text-only message through the production adapter, using `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` and `ANTHROPIC_TIMEOUT_MS` (defaults `claude-opus-5-5`, `low`, `20000`). It invokes no tools and touches no database, orders or inventory. It prints PASS/FAIL, the serving model and token usage, never the key or headers. Exit codes: `0` success, `1` API failure, `2` not configured (nothing sent).

## AI provider (Anthropic Claude)

`AI_PROVIDER` selects the conversation model: `mock` (default; scripted, for tests and local runs), `anthropic` (Claude, the production provider) or `openai`. With `anthropic` the backend refuses to start without `ANTHROPIC_API_KEY`, and a failed Claude call (error, timeout, rate limit after one retry, refusal) hands the caller to staff with the fixed fallback line. It never falls back to the mock.

| Variable | Default | Notes |
|---|---|---|
| `AI_PROVIDER` | `mock` | `anthropic` in production |
| `ANTHROPIC_API_KEY` | — | Required for `anthropic`. Create it in the Claude Console (API keys). Keep it in the host's secret store or the shell, never in Git |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Any current Claude model id |
| `ANTHROPIC_EFFORT` | `low` | `low`…`max`. Thinking depth, which drives latency and cost. Raise to `medium` if measured quality drops |
| `ANTHROPIC_TIMEOUT_MS` | `20000` | Per attempt; the SDK retries 408/409/429/5xx once |
| `ANTHROPIC_PRICE_INPUT_USD_PER_1M` / `_OUTPUT_` | `0` | Only to fill `usage_costs`; `claude-opus-5-5` list price is 4 / 20 |

The adapter (`src/integrations/ai/anthropic.adapter.ts`) only translates the provider-neutral port to the Messages API. Tool permissions, input validation, the 15-line limit, read-back/confirmation binding and persistence stay in the orchestrator, tool registry and services. Requests opt in to server-side refusal fallback (`fallbacks: "default"`). Automated tests use a local HTTP stub and need no key.

## Speech providers (Sarvam, Google)

`STT_PROVIDER` / `TTS_PROVIDER` select `mock` (default), `google` or `sarvam`, independently. The voice loop, Exotel and LiveKit paths are the same for every provider; Claude remains the conversation model.

| Variable | Default | Notes |
|---|---|---|
| `SARVAM_API_KEY` | — | Required when either provider is `sarvam`; sent only in the `api-subscription-key` header and scrubbed from error messages |
| `SARVAM_STT_MODEL` | `saaras:v4` | `POST /speech-to-text`; each utterance is sent as WAV (8 kHz Exotel or 16 kHz LiveKit) |
| `SARVAM_STT_LANGUAGE` | `auto` | `auto` lets Sarvam detect Malayalam, English, Tamil or Hindi per utterance; `session` sends the call's current language |
| `SARVAM_TTS_MODEL` | `bulbul:v3` | `POST /text-to-speech`, `linear16` PCM at the call's sample rate; text over 2500 characters is split at sentence ends |
| `SARVAM_TTS_SPEAKER` | `shubh` | Any bulbul:v3 speaker id |

`GET /api/settings` reports the provider, whether its key is set, and the Sarvam models, language mode and speaker. Unit and integration tests always run with the mock speech providers, whatever `.env` selects.

**Speech smoke test (billable).** `npm run speech:smoke -- --dry-run` prints the plan and sends nothing. `npm run speech:smoke` synthesises one short pharmacy phrase per language (Malayalam, English, Tamil, Hindi) at 8 kHz and 16 kHz, then recognises that audio: 8 TTS and 8 STT requests. Narrow it with `--lang ml --rate 16000`. It prints transcripts, detected languages and timings, never the key, and touches no database. Exit codes: `0` passed, `1` a request failed, `2` not configured or bad arguments.

## LiveKit voice calls (browser)

A staff member can call the agent from a browser over LiveKit Cloud instead of a phone line. Two processes run separately, from the same code and the same environment:

| Process | Command | What it does |
|---|---|---|
| Express API | `npm run dev` / `npm start` | `POST /api/voice/sessions` (signed in, any staff role, 10 per user per 10 min): mints the browser's 5-minute join token, creates the room `call-<uuid>` (2 seats) and explicitly dispatches the worker into it with the caller number and language. It never runs the conversation. |
| Voice worker | `npm run voice-worker:dev` (tsx) / `npm run voice-worker:start` (built) | Registers with LiveKit under `LIVEKIT_AGENT_NAME` and accepts only jobs whose room name and metadata validate. Each job, in its own child process, joins the room, waits for the participant the token was minted for, publishes the agent's voice and runs the existing engine through the shared voice loop (`src/modules/voice`): VAD → Google STT → Claude orchestrator and tools → Google TTS, with barge-in. When the caller leaves, the session ends like a phone hang-up and the room is deleted. |

The worker does not use LiveKit's own agent pipeline (`AgentSession`); speech, the model, tools, order and confirmation rules stay in this backend. Audio is 16 kHz mono both ways (rtc-node resamples the browser's 48 kHz). A LiveKit call ending never confirms an order: an unconfirmed draft stays unconfirmed and raises the usual staff exception.

**Environment** (both processes): `LIVEKIT_URL` (`wss://…livekit.cloud`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_AGENT_NAME` (one per environment, e.g. `pharmacy-voice-local`, `pharmacy-voice-prod`), and on the API `LIVEKIT_ENABLED=true`. The worker also needs everything the engine needs: `DATABASE_URL`, `JWT_SECRET` (required by the shared config), `AI_PROVIDER`/`ANTHROPIC_API_KEY`, `STT_PROVIDER`/`TTS_PROVIDER` with `SARVAM_API_KEY` or `GOOGLE_SPEECH_API_KEY`, and optionally `LIVEKIT_WORKER_IDLE_PROCESSES` (default 1). The API secret is used only server-side; the browser receives the `wss://` URL and its token.

**LiveKit Cloud setup.** Create a project, then Settings → API keys → create a key; put the URL, key and secret in the environment of both processes. No webhooks, SIP trunks or LiveKit-hosted agents are needed: the worker connects out to LiveKit, and dispatch is explicit (`agentName`), so the worker never joins rooms on its own.

**Run locally.** Point `DATABASE_URL` at a development database (never production, and not the integration-test database, which the tests truncate). Start the API (`npm run dev`) with `LIVEKIT_ENABLED=true`, then the worker (`npm run voice-worker:dev`) in a second terminal; it logs `registered worker`. The frontend voice page comes in the next build phase; until then `POST /api/voice/sessions` returns a token that any LiveKit client (e.g. the LiveKit Meet sandbox) can join with.

**Room and session rules.**
- The room name is generated on the server; a client cannot choose it.
- The token admits one identity to one room. It can publish a microphone and subscribe, but cannot send data, change its metadata, or create, list or administer rooms. LiveKit Cloud was checked to enforce this.
- The worker listens only to that identity. If nobody joins within 5 minutes, it deletes the room.
- One room is one call. A job for a room that already has a call row, or that loses the unique insert race, ends without touching the call or the room. Dispatches are created with restart policy `JRP_NEVER`.
- The text-simulator endpoints `POST /api/conversations/:id/turns|end` refuse `livekit` calls (`409 CALL_HANDLED_BY_VOICE_WORKER`): their session lives in the worker, and resuming it in the API would run a second copy of the conversation.
- Idle calls end after `CONVERSATION_IDLE_TIMEOUT_MINUTES` without a customer turn (`idle_timeout`).

**Latency logs.** Replies are synthesised and played sentence by sentence (up to 3 sentences synthesised ahead), so the agent starts speaking once the first sentence is ready. Each answered utterance logs `voice.turn_timing` (in ms: `endpointMs` silence that ends the utterance, `queueMs`, `sttMs`, `turnMs` for the conversation turn, `ttsFirstAudioMs`, `firstFrameMs`, and `totalMs` from the end of the caller's speech to the first agent audio sent). Each model round logs `ai.completion` (`ms`, token counts, tool calls). When a call ends, `voice.call_audio` says what the loop heard: `callerAudioMs` (0: no caller audio arrived), `voicedMs` and `maxRms` against `vadThreshold` (`VAD_RMS_THRESHOLD`; 0 voiced ms: the microphone never crossed it), `utterances`, `sttEmpty` (utterances recognised as no text, which are dropped) and `turns`. None of these logs contain text. After a hang-up the loop starts no recognition, turn or agent audio; a turn already running completes but is not spoken. Time spent in the browser's WebRTC playback is not included.

**Handover.** The handover rules are unchanged: a staff exception is raised, the call is marked `handed_over` and the agent says the handover line. A LiveKit room has no phone line to transfer, so the transfer is recorded as `handover_transfer_skipped`; nobody actually joins. Letting staff join the room from the dashboard needs a separate staff-client integration (not built).

**Deploy (Render).** Run the worker as its own Render **Background Worker** from this repository: the same build command, with start command `npm run voice-worker:start` and the same environment. The API stays a Web Service. The worker needs no inbound port. It serves a health check on 8081, which is unused on a background worker. It needs outbound access to LiveKit Cloud. Each job is a separate Node process that loads the whole backend, so size the instance for `LIVEKIT_WORKER_IDLE_PROCESSES` + concurrent calls. Keep `LIVEKIT_ENABLED=false` on the API until the worker is running, and remember that browser test calls write real calls, orders and stock reservations to the database that environment uses.

## Deploy (Render)

```bash
npm ci --include=dev && npm run build    # build command
npm start                                # start command
```

`--include=dev` is required. When dev dependencies are omitted (e.g. `NODE_ENV=production`), `typescript` is still installed as an optional peer of `@prisma/client`, but `@types/express`, `@types/cors` and `@types/ws` are not, so `tsc` fails with TS7016.

Environment (Render → service → Environment): `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`, `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` (as a secret value), and optionally `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `ANTHROPIC_TIMEOUT_MS` and the price variables. The API and the voice worker also need `PROTECTED_DATABASE_IDENTITIES` (the production identity, `neon:<endpoint-id>/<database>`) and `ALLOW_PROTECTED_RUNTIME_DATABASE` set to the same exact identity; without them a build with the startup protection refuses to start. Redeploy after saving. Then `GET /api/settings` (signed in) should report `providers.ai` as `{ provider: "anthropic", configured: true, model, effort }`. Then place one test call before taking real orders.

**Behind the Vercel proxy.** The dashboard calls same-origin `/api/*` on Vercel, which proxies to this service, so the `SameSite=Strict` refresh cookie is first-party. Every `/api` response is `Cache-Control: no-store`, so the proxy never caches it. `CORS_ORIGIN` only matters for direct cross-origin callers; keep it set to the dashboard origin.

**`TRUST_PROXY_HOPS`** (default `0`) controls which `X-Forwarded-For` entry becomes the client IP, for login/refresh rate limits and audit logs. At `0` every request appears to come from Render's proxy, so per-IP limits are shared by all users. That is safe but coarse. A value higher than the real number of proxies lets any client spoof its IP and dodge the limits. Set it only after measuring:

1. Set `LOG_LEVEL=debug` on Render. Each request then logs `http.proxy_chain` with `remoteAddress`, `forwardedFor` and the resulting `ip`.
2. Make one request through the dashboard (Vercel) and one directly to the Render URL, from a machine whose public IP you know.
3. Choose the hop count whose `ip` would be your IP on the Vercel path. Vercel overwrites `X-Forwarded-For` with the visitor IP, and Render appends its own entry. Expect `2`, but go by the logs.
4. Set `TRUST_PROXY_HOPS` to that value, and set `LOG_LEVEL` back to `info`.

With `2`, callers that bypass Vercel and hit Render directly can still spoof the left-most entry. Restricting the origin to Vercel traffic (a secret header set by a Vercel route transform and checked here) closes that gap; it is not implemented.

Never commit `.env`; it is ignored. Only `.env.example` with placeholder values is tracked.
