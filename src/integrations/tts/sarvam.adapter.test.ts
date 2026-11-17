// Contract tests for the Sarvam TTS adapter against a local stub of /text-to-speech: the JSON request (bulbul:v3,
// speaker, language, sample rate, linear16), base64 decoding, long-text splitting, errors, timeouts and key
// redaction. NOT evidence that live Sarvam sounds right in each language: that is what speech:smoke is for.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startSarvamStub, stubPcm, TEST_SARVAM_KEY as KEY } from '../../../tests/fakes/sarvam-stub.ts';
import { pcmToWav } from '../stt/sarvam.adapter.ts';
import { createSarvamTts, SARVAM_TTS_MAX_CHARS, splitForTts } from './sarvam.adapter.ts';
import { SpeechProviderError } from './tts.port.ts';

let stub: Awaited<ReturnType<typeof startSarvamStub>>;
before(async () => {
  stub = await startSarvamStub();
});
after(() => stub.close());
beforeEach(() => stub.reset());

const tts = (timeoutMs?: number) => createSarvamTts({ apiKey: KEY, model: 'bulbul:v3', speaker: 'shubh', baseUrl: stub.baseUrl, timeoutMs });
const audioReply = (pcm: Buffer) => ({ status: 200, body: { request_id: 'r', audios: [pcm.toString('base64')] } });
const chars = (s: string) => [...s].length;

describe('splitForTts', () => {
  it('leaves text within the limit whole and drops blank text', () => {
    assert.deepEqual(splitForTts('  Two strips of Paracetamol 650.  '), ['Two strips of Paracetamol 650.']);
    assert.deepEqual(splitForTts('   '), []);
    assert.equal(SARVAM_TTS_MAX_CHARS, 2500);
  });

  it('splits between sentences, then between words, and only then inside a word', () => {
    assert.deepEqual(splitForTts('One. Two two. Three three three.', 15), ['One. Two two.', 'Three three', 'three.']);
    assert.deepEqual(splitForTts('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  });

  it('cuts long text into ≤ 2500-character pieces at sentence ends, in every script', () => {
    const sentences: Record<string, string> = {
      en: 'Please send two strips of Paracetamol 650 today.',
      ml: 'ദയവായി ഇന്ന് പാരസെറ്റമോൾ 650 രണ്ട് സ്ട്രിപ്പ് അയയ്ക്കുക.',
      ta: 'இன்று பாராசிட்டமால் 650 இரண்டு ஸ்ட்ரிப் அனுப்புங்கள்.',
      hi: 'कृपया आज पैरासिटामोल 650 की दो स्ट्रिप भेजें।',
    };
    for (const [lang, sentence] of Object.entries(sentences)) {
      const text = Array.from({ length: Math.ceil(6000 / chars(sentence)) }, () => sentence).join(' ');
      const pieces = splitForTts(text);
      assert.ok(pieces.length >= 3, lang);
      for (const p of pieces) {
        assert.ok(chars(p) <= SARVAM_TTS_MAX_CHARS, `${lang}: ${chars(p)} chars`);
        assert.ok(p.endsWith(sentence.at(-1)!), `${lang}: piece ends at a sentence boundary`);
      }
      assert.equal(pieces.join(' '), text, `${lang}: nothing lost or reordered`);
    }
  });

  it('counts characters, not UTF-16 units', () => {
    const emoji = '😀'.repeat(10); // 10 characters, 20 UTF-16 units
    assert.deepEqual(splitForTts(emoji, 10), [emoji]);
  });
});

describe('Sarvam TTS adapter (stub contract)', () => {
  for (const rate of [8000, 16000] as const) {
    it(`asks bulbul:v3 / shubh for linear16 at ${rate} Hz in each language and decodes the base64 audio`, async () => {
      const locales = { ml: 'ml-IN', en: 'en-IN', ta: 'ta-IN', hi: 'hi-IN' } as const;
      for (const [lang, locale] of Object.entries(locales) as Array<[keyof typeof locales, string]>) {
        stub.reset();
        const pcm = stubPcm(0.5, rate);
        stub.reply(() => audioReply(pcm));
        const out = await tts().synthesize(`phrase in ${lang}`, { language: lang, sampleRate: rate });
        const req = stub.requests[0]!;
        assert.equal(req.path, '/text-to-speech');
        assert.equal(req.headers['api-subscription-key'], KEY);
        assert.match(String(req.headers['content-type']), /^application\/json/);
        assert.deepEqual(req.json, { text: `phrase in ${lang}`, language_code: locale, speaker: 'shubh', model: 'bulbul:v3', speech_sample_rate: rate, output_audio_codec: 'linear16' });
        assert.deepEqual(out, pcm);
      }
    });
  }

  it('unwraps audio that comes back in a WAV container', async () => {
    const pcm = stubPcm(0.2, 8000);
    stub.reply(() => ({ status: 200, body: { audios: [pcmToWav(pcm, 8000).toString('base64')] } }));
    assert.deepEqual(await tts().synthesize('hello', { language: 'en', sampleRate: 8000 }), pcm);
  });

  it('synthesises long text piece by piece, in order, and joins the audio', async () => {
    const sentence = 'Please send two strips of Paracetamol 650 today.';
    const text = Array.from({ length: 120 }, () => sentence).join(' '); // ~5900 characters
    const parts = [stubPcm(0.1, 16000, 1000), stubPcm(0.1, 16000, 2000), stubPcm(0.1, 16000, 3000)];
    stub.reply((_req, i) => audioReply(parts[i]!));
    const out = await tts().synthesize(text, { language: 'en', sampleRate: 16000 });
    assert.equal(stub.requests.length, 3);
    assert.ok(stub.requests.every((r) => chars(String(r.json!['text'])) <= SARVAM_TTS_MAX_CHARS));
    assert.equal(stub.requests.map((r) => r.json!['text']).join(' '), text);
    assert.deepEqual(out, Buffer.concat(parts));
  });

  it('sends nothing for blank text', async () => {
    assert.equal((await tts().synthesize('  ', { language: 'en', sampleRate: 8000 })).length, 0);
    assert.equal(stub.requests.length, 0);
  });

  it('maps API errors and empty answers, and never repeats the key', async () => {
    stub.reply(() => ({ status: 429, body: { error: { code: 'insufficient_quota_error', message: `Quota exceeded for ${KEY}` } } }));
    await assert.rejects(tts().synthesize('hello', { language: 'en', sampleRate: 8000 }), (e: unknown) => {
      assert.ok(e instanceof SpeechProviderError);
      assert.equal(e.message, 'Sarvam TTS error 429: insufficient_quota_error: Quota exceeded for [redacted]');
      return true;
    });
    stub.reply(() => ({ status: 200, body: { request_id: 'r', audios: [] } }));
    await assert.rejects(tts().synthesize('hello', { language: 'en', sampleRate: 8000 }), /Sarvam TTS returned no audio/);
  });

  it('fails cleanly on a timeout', async () => {
    stub.reply(() => ({ ...audioReply(stubPcm(0.1, 8000)), delayMs: 500 }));
    await assert.rejects(tts(50).synthesize('hello', { language: 'en', sampleRate: 8000 }), (e: unknown) => e instanceof SpeechProviderError && /Sarvam TTS request failed/.test(e.message) && !e.message.includes(KEY));
  });
});
