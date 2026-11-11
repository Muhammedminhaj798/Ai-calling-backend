// Contract test against a local stub of Google's speech:recognize endpoint. Proves the request shape
// (LINEAR16, sample rate, en-IN/ml-IN/ta-IN/hi-IN locales, alternative languages) and response mapping.
// NOT evidence that live Google Speech-to-Text works or recognises these languages well: that needs a key
// and the sample calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createGoogleStt } from './google.adapter.ts';
import { SpeechProviderError } from './stt.port.ts';

let server: http.Server;
let endpoint: string;
let lastBody: Record<string, unknown> = {};
let lastUrl = '';
let respond: () => [number, unknown] = () => [200, {}];

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastUrl = req.url ?? '';
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      const [status, payload] = respond();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/speech:recognize`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

describe('Google STT adapter (stub contract)', () => {
  it('sends LINEAR16 audio with the session locale and the other languages as alternatives', async () => {
    respond = () => [200, { results: [{ alternatives: [{ transcript: ' ഡോളോ 650 ഇരുപത് സ്ട്രിപ്പ് ', confidence: 0.91 }], languageCode: 'ml-in' }] }];
    const stt = createGoogleStt({ apiKey: 'stub-key', endpoint });
    const audio = Buffer.alloc(16_000, 7);
    const result = await stt.recognize(audio, { sampleRate: 8000, language: 'ml', alternatives: ['en', 'ta', 'hi'] });
    assert.ok(lastUrl.startsWith('/v1/speech:recognize?key=stub-key'));
    const config = lastBody['config'] as Record<string, unknown>;
    assert.equal(config['encoding'], 'LINEAR16');
    assert.equal(config['sampleRateHertz'], 8000);
    assert.equal(config['languageCode'], 'ml-IN');
    assert.deepEqual(config['alternativeLanguageCodes'], ['en-IN', 'ta-IN', 'hi-IN']);
    assert.equal((lastBody['audio'] as { content: string }).content, audio.toString('base64'));
    assert.deepEqual(result, { text: 'ഡോളോ 650 ഇരുപത് സ്ട്രിപ്പ്', confidence: 0.91, language: 'ml' });
  });

  it('returns empty text when nothing was recognised and maps API errors', async () => {
    respond = () => [200, {}];
    const stt = createGoogleStt({ apiKey: 'stub-key', endpoint });
    assert.deepEqual(await stt.recognize(Buffer.alloc(320), { sampleRate: 8000, language: 'en' }), { text: '', confidence: null, language: null });
    respond = () => [403, { error: { message: 'API key not valid' } }];
    await assert.rejects(stt.recognize(Buffer.alloc(320), { sampleRate: 8000, language: 'ta' }), (e: unknown) => e instanceof SpeechProviderError && /403.*API key not valid/.test(e.message));
  });
});
