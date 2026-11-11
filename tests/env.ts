// Imported first by any test that loads application modules: supplies the variables env.ts requires
// so unit tests run without a .env file. Placeholders only — unit tests contact no real service.
process.env['NODE_ENV'] ??= 'test';
process.env['DATABASE_URL'] ??= 'postgresql://test:test@127.0.0.1:5432/ai_pharmacy_agent_test';
process.env['JWT_SECRET'] ??= 'unit-test-secret-not-for-production-0123456789';
process.env['LOG_LEVEL'] ??= 'error';
