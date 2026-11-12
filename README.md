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

## Deploy (Render)

```bash
npm ci --include=dev && npm run build    # build command
npm start                                # start command
```

`--include=dev` is required. When dev dependencies are omitted (e.g. `NODE_ENV=production`), `typescript` is still installed as an optional peer of `@prisma/client`, but `@types/express`, `@types/cors` and `@types/ws` are not, so `tsc` fails with TS7016.

Never commit `.env`; it is ignored. Only `.env.example` with placeholder values is tracked.
