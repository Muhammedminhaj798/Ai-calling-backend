// Imported first by any test that loads application modules: supplies the variables env.ts requires
// so unit tests run without a .env file. Placeholders only — unit tests contact no real service.
process.env['NODE_ENV'] ??= 'test';
process.env['DATABASE_URL'] ??= 'postgresql://test:test@127.0.0.1:5432/ai_pharmacy_agent_test';
process.env['JWT_SECRET'] ??= 'unit-test-secret-not-for-production-0123456789';
process.env['LOG_LEVEL'] ??= 'error';
// The startup database protection check (config/env.ts) runs under tests too. Placeholder protected identity that the
// placeholder DATABASE_URL is provably separate from (same server, another database); integration runs bring their own.
process.env['PROTECTED_DATABASE_IDENTITIES'] ??= 'loopback:5432/placeholder_protected_database';
// Speech is billable (Sarvam, Google): unit tests always use the mocks, whatever .env or the shell select.
process.env['STT_PROVIDER'] = 'mock';
process.env['TTS_PROVIDER'] = 'mock';
