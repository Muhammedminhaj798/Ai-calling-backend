// Runs scripts/speech-smoke.ts against the local Sarvam stub (SARVAM_BASE_URL), never the real API: the plan,
// the request scope, what is printed, exit codes, and that the key never appears in the output.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startSarvamStub, stubPcm, TEST_SARVAM_KEY as KEY } from './fakes/sarvam-stub.ts';

let stub: Awaited<ReturnType<typeof startSarvamStub>>;
before(async () => {
  stub = await startSarvamStub();
});
after(() => stub.close());
beforeEach(() => stub.reset());

/** A Sarvam that speaks 1 s of audio and "hears" the language the previous TTS request was in. */
function healthySarvam() {
  let lastLanguage: unknown = null;
  stub.reply((req) => {
    if (req.path === '/text-to-speech') {
      lastLanguage = req.json!['language_code'];
      return { status: 200, body: { request_id: 'tts', audios: [stubPcm(1, Number(req.json!['speech_sample_rate'])).toString('base64')] } };
    }
    return { status: 200, body: { request_id: 'stt', transcript: `heard ${String(lastLanguage)}`, language_code: lastLanguage } };
  });
}

function runSmoke(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  // SARVAM_BASE_URL always points at the stub; set (even empty) variables are never replaced by .env.
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/speech-smoke.ts', ...args], {
    env: { ...process.env, SARVAM_BASE_URL: stub.baseUrl, SARVAM_STT_MODEL: 'saaras:v4', SARVAM_STT_LANGUAGE: 'auto', SARVAM_TTS_MODEL: 'bulbul:v3', SARVAM_TTS_SPEAKER: 'shubh', ...env },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

describe('npm run speech:smoke', () => {
  it('--dry-run prints the plan and sends nothing', async () => {
    const r = await runSmoke(['--dry-run'], { SARVAM_API_KEY: KEY });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Plan: 8 case\(s\) = 8 TTS request\(s\), \d+ characters, and 8 STT request\(s\)/);
    assert.match(r.out, /SARVAM_API_KEY is set/);
    assert.equal(stub.requests.length, 0);
    assert.doesNotMatch(r.out, new RegExp(KEY));
  });

  it('runs 4 languages × 8 and 16 kHz: TTS then STT of that audio, printing transcripts but never the key', async () => {
    healthySarvam();
    const r = await runSmoke([], { SARVAM_API_KEY: KEY });
    assert.equal(r.code, 0, r.out);
    assert.equal((r.out.match(/^PASS {2}/gm) ?? []).length, 8);
    assert.match(r.out, /PASS {2}Malayalam 8000 Hz: TTS 1\.0 s of audio/);
    assert.match(r.out, /heard: heard hi-IN/);
    assert.match(r.out, /All 8 case\(s\) passed/);
    const tts = stub.requests.filter((q) => q.path === '/text-to-speech');
    const stt = stub.requests.filter((q) => q.path === '/speech-to-text');
    assert.equal(tts.length, 8);
    assert.equal(stt.length, 8);
    assert.deepEqual([...new Set(tts.map((q) => q.json!['speech_sample_rate']))], [8000, 16000]);
    assert.deepEqual([...new Set(tts.map((q) => q.json!['language_code']))], ['en-IN', 'ml-IN', 'ta-IN', 'hi-IN']);
    assert.ok(stt.every((q) => q.form!.get('language_code') === 'unknown' && q.form!.get('model') === 'saaras:v4'));
    assert.ok(stub.requests.every((q) => q.headers['api-subscription-key'] === KEY));
    assert.doesNotMatch(r.out, new RegExp(KEY));
  });

  it('--lang and --rate narrow the run to one case', async () => {
    healthySarvam();
    const r = await runSmoke(['--lang', 'ml', '--rate', '16000'], { SARVAM_API_KEY: KEY });
    assert.equal(r.code, 0, r.out);
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(stub.requests[0]!.json!['speech_sample_rate'], 16000);
  });

  it('exits 1 on an API failure, with the key redacted', async () => {
    stub.reply(() => ({ status: 403, body: { error: { code: 'invalid_api_key_error', message: `bad key ${KEY}` } } }));
    const r = await runSmoke(['--lang', 'en', '--rate', '8000'], { SARVAM_API_KEY: KEY });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}English 8000 Hz: Sarvam TTS error 403: invalid_api_key_error: bad key \[redacted\]/);
    assert.doesNotMatch(r.out, new RegExp(KEY));
  });

  it('exits 2 and sends nothing without a key or with bad arguments', async () => {
    const noKey = await runSmoke([], { SARVAM_API_KEY: '' });
    assert.equal(noKey.code, 2);
    assert.match(noKey.out, /SARVAM_API_KEY is not set; no request was sent/);
    const badLang = await runSmoke(['--lang', 'fr'], { SARVAM_API_KEY: KEY });
    assert.equal(badLang.code, 2);
    assert.equal(stub.requests.length, 0);
  });
});
