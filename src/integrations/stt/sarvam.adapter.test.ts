// Contract tests for the Sarvam STT adapter against a local stub of /speech-to-text: the WAV container, the
// multipart request (model, language detection, key header), language mapping, errors, timeouts and key
// redaction. NOT evidence that live Sarvam recognises these languages well: that is what speech:smoke is for.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startSarvamStub, TEST_SARVAM_KEY as KEY } from '../../../tests/fakes/sarvam-stub.ts';
import { createSarvamStt, pcmToWav } from './sarvam.adapter.ts';
import { SpeechProviderError } from './stt.port.ts';

let stub: Awaited<ReturnType<typeof startSarvamStub>>;
before(async () => {
  stub = await startSarvamStub();
});
after(() => stub.close());
beforeEach(() => stub.reset());

const stt = (language: 'auto' | 'session' = 'auto', timeoutMs?: number) => createSarvamStt({ apiKey: KEY, model: 'saaras:v4', language, baseUrl: stub.baseUrl, timeoutMs });
const sentFile = async (i = 0) => {
  const file = stub.requests[i]!.form!.get('file') as File;
  return { type: file.type, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
};

describe('pcmToWav', () => {
  for (const rate of [8000, 16000]) {
    it(`wraps 16-bit mono PCM in a ${rate} Hz WAV header`, () => {
      const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
      const wav = pcmToWav(pcm, rate);
      assert.equal(wav.length, 44 + 6);
      assert.deepEqual([wav.toString('ascii', 0, 4), wav.toString('ascii', 8, 12), wav.toString('ascii', 12, 16), wav.toString('ascii', 36, 40)], ['RIFF', 'WAVE', 'fmt ', 'data']);
      assert.deepEqual(
        [wav.readUInt32LE(4), wav.readUInt32LE(16), wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt32LE(28), wav.readUInt16LE(32), wav.readUInt16LE(34), wav.readUInt32LE(40)],
        [36 + 6, 16, 1, 1, rate, rate * 2, 2, 16, 6],
      );
      assert.deepEqual(wav.subarray(44), pcm);
    });
  }
});

describe('Sarvam STT adapter (stub contract)', () => {
  it('posts the utterance as WAV with saaras:v4, automatic language detection and the key header only', async () => {
    stub.reply(() => ({ status: 200, body: { request_id: 'r1', transcript: '  പാരസെറ്റമോൾ 650 രണ്ട് സ്ട്രിപ്പ്  ', language_code: 'ml-IN', language_probability: 0.97 } }));
    const audio = Buffer.alloc(3200, 7);
    const result = await stt().recognize(audio, { sampleRate: 8000, language: 'en', alternatives: ['ml', 'ta', 'hi'] });

    const req = stub.requests[0]!;
    assert.equal(req.path, '/speech-to-text');
    assert.equal(req.headers['api-subscription-key'], KEY);
    assert.equal(req.form!.get('model'), 'saaras:v4');
    assert.equal(req.form!.get('language_code'), 'unknown', 'auto = let Sarvam detect');
    const file = await sentFile();
    assert.deepEqual([file.type, file.name], ['audio/wav', 'utterance.wav']);
    assert.deepEqual(file.bytes, pcmToWav(audio, 8000));
    assert.deepEqual(result, { text: 'പാരസെറ്റമോൾ 650 രണ്ട് സ്ട്രിപ്പ്', confidence: null, language: 'ml' });
  });

  it('labels 16 kHz audio as 16 kHz', async () => {
    stub.reply(() => ({ status: 200, body: { transcript: 'two strips', language_code: 'en-IN' } }));
    await stt().recognize(Buffer.alloc(6400, 1), { sampleRate: 16000, language: 'en' });
    assert.equal((await sentFile()).bytes.readUInt32LE(24), 16000);
  });

  it('maps Malayalam, English, Tamil and Hindi; any other or no detected language is null', async () => {
    const cases: Array<[string | null, string | null]> = [['ml-IN', 'ml'], ['en-IN', 'en'], ['ta-IN', 'ta'], ['hi-IN', 'hi'], ['bn-IN', null], [null, null]];
    for (const [code, expected] of cases) {
      stub.reply(() => ({ status: 200, body: { transcript: 'x', language_code: code } }));
      assert.equal((await stt().recognize(Buffer.alloc(320), { sampleRate: 8000, language: 'en' })).language, expected, String(code));
    }
  });

  it('session mode tells Sarvam the session language instead of auto-detecting', async () => {
    stub.reply(() => ({ status: 200, body: { transcript: 'இரண்டு', language_code: 'ta-IN' } }));
    await stt('session').recognize(Buffer.alloc(320), { sampleRate: 8000, language: 'ta' });
    assert.equal(stub.requests[0]!.form!.get('language_code'), 'ta-IN');
  });

  it('returns empty text when nothing was heard', async () => {
    stub.reply(() => ({ status: 200, body: { transcript: '', language_code: null } }));
    assert.deepEqual(await stt().recognize(Buffer.alloc(320), { sampleRate: 8000, language: 'hi' }), { text: '', confidence: null, language: null });
  });

  it('maps API errors with code and request id, and never repeats the key', async () => {
    stub.reply(() => ({ status: 403, body: { error: { code: 'invalid_api_key_error', message: `Invalid API key ${KEY}`, request_id: 'req-9' } } }));
    await assert.rejects(stt().recognize(Buffer.alloc(320), { sampleRate: 8000, language: 'en' }), (e: unknown) => {
      assert.ok(e instanceof SpeechProviderError);
      assert.equal(e.message, 'Sarvam STT error 403: invalid_api_key_error: Invalid API key [redacted] (request req-9)');
      return true;
    });
  });

  it('fails cleanly on a timeout or an unreachable host', async () => {
    stub.reply(() => ({ status: 200, body: { transcript: 'late' }, delayMs: 500 }));
    await assert.rejects(stt('auto', 50).recognize(Buffer.alloc(320), { sampleRate: 8000, language: 'en' }), /Sarvam STT request failed/);
    const offline = createSarvamStt({ apiKey: KEY, model: 'saaras:v4', language: 'auto', baseUrl: 'http://127.0.0.1:9' });
    await assert.rejects(offline.recognize(Buffer.alloc(320), { sampleRate: 8000, language: 'en' }), (e: unknown) => e instanceof SpeechProviderError && !e.message.includes(KEY));
  });
});
