// Speech provider configuration: which adapter each setting selects (mock, Google, Sarvam, mixed), the
// environment validation for Sarvam (in a child process, isolated from .env), and the speech status that
// GET /api/settings reports to the dashboard. No speech request is ever sent.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// This process runs with Sarvam selected and a placeholder key (tests/env.ts pinned the mocks; set here on purpose).
const KEY = 'sk_unit_test_placeholder_not_a_real_key';
Object.assign(process.env, {
  STT_PROVIDER: 'sarvam',
  TTS_PROVIDER: 'sarvam',
  SARVAM_API_KEY: KEY,
  SARVAM_STT_MODEL: 'saaras:v4',
  SARVAM_STT_LANGUAGE: 'auto',
  SARVAM_TTS_MODEL: 'bulbul:v3',
  SARVAM_TTS_SPEAKER: 'shubh',
});
const { createStt, createTts, getStt, getTts, mockStt, mockTts } = await import('./speech.service.ts');
const { createApp } = await import('../../app.ts');
const { signAccessToken } = await import('../auth/auth.tokens.ts');
type SpeechConfig = import('./speech.service.ts').SpeechConfig;

const base: SpeechConfig = {
  STT_PROVIDER: 'mock',
  TTS_PROVIDER: 'mock',
  GOOGLE_SPEECH_API_KEY: undefined,
  SARVAM_API_KEY: undefined,
  SARVAM_STT_MODEL: 'saaras:v4',
  SARVAM_STT_LANGUAGE: 'auto',
  SARVAM_TTS_MODEL: 'bulbul:v3',
  SARVAM_TTS_SPEAKER: 'shubh',
};

describe('speech provider selection', () => {
  it('mock by default (the shared mocks tests script and inspect)', () => {
    assert.equal(createStt(base), mockStt);
    assert.equal(createTts(base), mockTts);
  });

  it('google and sarvam select their adapters, also mixed', () => {
    assert.equal(createStt({ ...base, STT_PROVIDER: 'google', GOOGLE_SPEECH_API_KEY: 'g' }).name, 'google');
    assert.equal(createTts({ ...base, TTS_PROVIDER: 'google', GOOGLE_SPEECH_API_KEY: 'g' }).name, 'google');
    assert.equal(createStt({ ...base, STT_PROVIDER: 'sarvam', SARVAM_API_KEY: 's' }).name, 'sarvam');
    assert.equal(createTts({ ...base, TTS_PROVIDER: 'sarvam', SARVAM_API_KEY: 's' }).name, 'sarvam');
    const mixed = { ...base, STT_PROVIDER: 'sarvam', TTS_PROVIDER: 'google', SARVAM_API_KEY: 's', GOOGLE_SPEECH_API_KEY: 'g' } as const;
    assert.deepEqual([createStt(mixed).name, createTts(mixed).name], ['sarvam', 'google']);
  });

  it('the running process uses the configured provider', () => {
    assert.deepEqual([getStt().name, getTts().name], ['sarvam', 'sarvam']);
  });
});

describe('environment validation for Sarvam', () => {
  const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  /** Loads src/config/env.ts in a child process, from an empty directory so no .env file is read. */
  function validate(vars: Record<string, string>) {
    const cwd = mkdtempSync(path.join(tmpdir(), 'env-check-'));
    try {
      const r = spawnSync(process.execPath, [path.join(backend, 'node_modules/tsx/dist/cli.mjs'), path.join(backend, 'src/config/env.ts')], {
        cwd,
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'],
          SystemRoot: process.env['SystemRoot'],
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/env_check',
          // Required by the startup database check; a placeholder the test database is provably separate from.
          PROTECTED_DATABASE_IDENTITIES: 'loopback:5432/placeholder_protected_database',
          JWT_SECRET: 'unit-test-secret-not-for-production-0123456789',
          ...vars,
        },
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it('refuses to start with Sarvam selected and no key', () => {
    for (const provider of ['STT_PROVIDER', 'TTS_PROVIDER']) {
      const r = validate({ [provider]: 'sarvam' });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /SARVAM_API_KEY is required when STT_PROVIDER or TTS_PROVIDER is sarvam/);
    }
  });

  it('rejects an unknown language mode; accepts a complete Sarvam setup without printing the key', () => {
    const bad = validate({ STT_PROVIDER: 'sarvam', SARVAM_API_KEY: KEY, SARVAM_STT_LANGUAGE: 'fr' });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /SARVAM_STT_LANGUAGE/);
    const ok = validate({ STT_PROVIDER: 'sarvam', TTS_PROVIDER: 'sarvam', SARVAM_API_KEY: KEY });
    assert.equal(ok.code, 0, ok.out);
    assert.doesNotMatch(bad.out + ok.out, new RegExp(KEY));
  });
});

describe('GET /api/settings speech status', () => {
  it('reports Sarvam with its models, language mode and speaker, never the key', async () => {
    const server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const token = await signAccessToken({ id: '5f0c9a7e-1d2b-4c3d-8e4f-a1b2c3d4e5f6', role: 'staff' });
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`, { headers: { authorization: `Bearer ${token}` } });
      const text = await res.text();
      assert.equal(res.status, 200, text);
      const { providers } = JSON.parse(text) as { providers: Record<string, unknown> };
      assert.deepEqual(providers['stt'], { provider: 'sarvam', configured: true, model: 'saaras:v4', language: 'auto' });
      assert.deepEqual(providers['tts'], { provider: 'sarvam', configured: true, model: 'bulbul:v3', speaker: 'shubh' });
      assert.doesNotMatch(text, new RegExp(KEY));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
