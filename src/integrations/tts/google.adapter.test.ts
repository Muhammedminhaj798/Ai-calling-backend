// Contract tests for the Google TTS adapter: WAV handling, voice map, and the request/response shape
// against a local stub of text:synthesize. NOT evidence that live Google Text-to-Speech works or sounds
// right in each language: that needs a key and a listening test.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createGoogleTts, DEFAULT_GOOGLE_VOICES, stripWavHeader } from './google.adapter.ts';
import { SpeechProviderError } from './tts.port.ts';

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe('Google TTS adapter helpers', () => {
  it('strips the WAV container and leaves raw PCM untouched', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
    assert.deepEqual(stripWavHeader(wav(pcm)), pcm);
    assert.deepEqual(stripWavHeader(pcm), pcm);
  });

  it('has an Indian voice for every supported language', () => {
    assert.deepEqual(Object.keys(DEFAULT_GOOGLE_VOICES).sort(), ['en', 'hi', 'ml', 'ta']);
    for (const [lang, voice] of Object.entries(DEFAULT_GOOGLE_VOICES)) assert.match(voice, new RegExp(`^${lang}-IN-`));
  });
});

describe('Google TTS adapter (stub contract)', () => {
  let server: http.Server;
  let endpoint: string;
  let lastBody: Record<string, unknown> = {};
  let respond: () => [number, unknown] = () => [200, {}];

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastBody = JSON.parse(raw) as Record<string, unknown>;
        const [status, payload] = respond();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/text:synthesize`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('requests LINEAR16 at the telephony rate with the language voice and returns raw PCM', async () => {
    const pcm = Buffer.from([9, 8, 7, 6]);
    respond = () => [200, { audioContent: wav(pcm).toString('base64') }];
    const tts = createGoogleTts({ apiKey: 'stub-key', endpoint });
    const out = await tts.synthesize('നമസ്കാരം', { language: 'ml', sampleRate: 8000 });
    assert.deepEqual(out, pcm);
    assert.deepEqual(lastBody['input'], { text: 'നമസ്കാരം' });
    assert.deepEqual(lastBody['voice'], { languageCode: 'ml-IN', name: 'ml-IN-Wavenet-A' });
    assert.deepEqual(lastBody['audioConfig'], { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 });
  });

  it('maps API errors and a missing audio payload', async () => {
    respond = () => [400, { error: { message: 'Voice not found' } }];
    const tts = createGoogleTts({ apiKey: 'stub-key', endpoint });
    await assert.rejects(tts.synthesize('hi', { language: 'hi', sampleRate: 8000 }), (e: unknown) => e instanceof SpeechProviderError && /400.*Voice not found/.test(e.message));
    respond = () => [200, {}];
    await assert.rejects(tts.synthesize('hi', { language: 'ta', sampleRate: 8000 }), (e: unknown) => e instanceof SpeechProviderError);
  });
});
