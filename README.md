# AI Pharmacy Order Agent — backend

Express 5 (ESM) · TypeScript · Prisma 7 · PostgreSQL. REST API, AI conversation engine, speech and telephony adapters (mock by default), order management with stock reservations, staff approvals and exception handling for an AI phone order agent for wholesale pharmacies. The staff dashboard lives in the separate `Ai-calling-fronted` repository. Architecture, build-step reports and screenshots are in [Ai-calling-docs](https://github.com/Muhammedminhaj798/Ai-calling-docs); the API contract is §B of its [ARCHITECTURE.md](https://github.com/Muhammedminhaj798/Ai-calling-docs/blob/main/ARCHITECTURE.md).

## Run

```bash
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD
npm install                   # also runs prisma generate
npm run prisma:deploy         # apply migrations
npm run seed -- --samples     # admin user plus clearly labelled mock staff, products and customer
npm run dev                   # http://localhost:4000  (health: /health, /health/ready)
```

Every provider (AI, STT, TTS, telephony, inventory) runs in mock mode until its keys are configured in `.env`; `GET /api/settings` reports the current mode.

## Checks

```bash
npm run typecheck && npm run lint && npm run build
npm run test:unit
npm run test:integration      # needs TEST_DATABASE_URL pointing at a dedicated test database
npm run smoke                 # against a running server
```

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

## Deploy (Render)

```bash
npm ci --include=dev && npm run build    # build command
npm start                                # start command
```

`--include=dev` is required. When dev dependencies are omitted (e.g. `NODE_ENV=production`), `typescript` is still installed as an optional peer of `@prisma/client`, but `@types/express`, `@types/cors` and `@types/ws` are not, so `tsc` fails with TS7016.

Environment (Render → service → Environment): `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`, `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` (as a secret value), and optionally `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `ANTHROPIC_TIMEOUT_MS` and the price variables. Redeploy after saving. Then `GET /api/settings` (signed in) should report `providers.ai` as `{ provider: "anthropic", configured: true, model, effort }`. Then place one test call before taking real orders.

Never commit `.env`; it is ignored. Only `.env.example` with placeholder values is tracked.
