// Live Sarvam speech smoke test. For each language and sample rate it synthesises one short pharmacy phrase
// with the production TTS adapter, then recognises that audio with the production STT adapter. No database, no
// calls, no orders. Prints the transcript, the detected language and timings, never the key.
// BILLABLE: every case is one Sarvam TTS request and one Sarvam STT request.
//   npm run speech:smoke -- --dry-run                    the plan and character counts; nothing is sent
//   npm run speech:smoke                                 4 languages × 8 and 16 kHz = 8 TTS + 8 STT requests
//   npm run speech:smoke -- --lang ml --rate 16000       one case = 1 TTS + 1 STT request
// Reads SARVAM_API_KEY, SARVAM_STT_MODEL, SARVAM_STT_LANGUAGE, SARVAM_TTS_MODEL and SARVAM_TTS_SPEAKER from the
// environment or .env (the shell wins). SARVAM_BASE_URL is for tests: it points the requests at a local stub.
// Exit codes: 0 every case passed · 1 a request failed or returned nothing · 2 not configured or bad arguments.
import { parseArgs } from 'node:util';
import { config as loadEnv } from 'dotenv';
import { createSarvamStt, SARVAM_BASE_URL, type SarvamSttLanguage } from '../src/integrations/stt/sarvam.adapter.ts';
import { createSarvamTts } from '../src/integrations/tts/sarvam.adapter.ts';
import { LANGS, LANGUAGE_NAMES, type Lang } from '../src/utils/language.ts';

loadEnv({ quiet: true });

/** One short order line per language, with a medicine name and a number, as a caller would say it. */
const PHRASES: Record<Lang, string> = {
  en: 'I need two strips of Paracetamol 650, please.',
  ml: 'പാരസെറ്റമോൾ 650 രണ്ട് സ്ട്രിപ്പ് വേണം.',
  ta: 'பாராசிட்டமால் 650 இரண்டு ஸ்ட்ரிப் வேண்டும்.',
  hi: 'पैरासिटामोल 650 की दो स्ट्रिप चाहिए।',
};
const RATES = [8000, 16000] as const;
type Rate = (typeof RATES)[number];

const apiKey = process.env['SARVAM_API_KEY']?.trim() ?? '';
/** Every printed line goes through here, so the key can never reach the terminal. */
const say = (line: string, stream: 'out' | 'err' = 'out') => (stream === 'out' ? console.log : console.error)(apiKey ? line.split(apiKey).join('[redacted]') : line);

function stop(message: string): never {
  say(`FAIL  ${message}; no request was sent.`, 'err');
  process.exit(2);
}

let args: { lang?: string[]; rate?: string[]; 'dry-run'?: boolean };
try {
  args = parseArgs({ options: { lang: { type: 'string', multiple: true }, rate: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' } }, strict: true }).values;
} catch (err) {
  stop(err instanceof Error ? err.message : 'bad arguments');
}
const langs = (args.lang ?? [...LANGS]) as Lang[];
const rates = (args.rate ?? RATES.map(String)).map(Number) as Rate[];
if (!langs.every((l) => LANGS.includes(l))) stop(`--lang must be one of ${LANGS.join(', ')}`);
if (!rates.every((r) => RATES.includes(r))) stop(`--rate must be one of ${RATES.join(', ')}`);

const stt = {
  model: process.env['SARVAM_STT_MODEL']?.trim() || 'saaras:v4',
  language: (process.env['SARVAM_STT_LANGUAGE']?.trim() || 'auto') as SarvamSttLanguage,
};
const tts = { model: process.env['SARVAM_TTS_MODEL']?.trim() || 'bulbul:v3', speaker: process.env['SARVAM_TTS_SPEAKER']?.trim() || 'shubh' };
if (stt.language !== 'auto' && stt.language !== 'session') stop('SARVAM_STT_LANGUAGE must be auto or session');
const cases = langs.flatMap((lang) => rates.map((rate) => ({ lang, rate })));
const characters = cases.reduce((n, c) => n + [...PHRASES[c.lang]].length, 0);

say(`Sarvam speech smoke test: TTS ${tts.model} (speaker ${tts.speaker}), STT ${stt.model} (language ${stt.language})`);
say(`Plan: ${cases.length} case(s) = ${cases.length} TTS request(s), ${characters} characters, and ${cases.length} STT request(s) of a few seconds each`);
if (args['dry-run']) {
  for (const c of cases) say(`      ${LANGUAGE_NAMES[c.lang].padEnd(9)} ${String(c.rate).padStart(5)} Hz  ${[...PHRASES[c.lang]].length} chars  ${PHRASES[c.lang]}`);
  say(`Dry run: nothing was sent. SARVAM_API_KEY is ${apiKey ? 'set' : 'not set'}.`);
  process.exit(0);
}
if (!apiKey) stop('SARVAM_API_KEY is not set');

const baseUrl = process.env['SARVAM_BASE_URL']?.trim() || SARVAM_BASE_URL;
const synthesiser = createSarvamTts({ apiKey, ...tts, baseUrl });
const recogniser = createSarvamStt({ apiKey, ...stt, baseUrl });

let failures = 0;
for (const { lang, rate } of cases) {
  const label = `${LANGUAGE_NAMES[lang]} ${rate} Hz`;
  try {
    const t0 = Date.now();
    const pcm = await synthesiser.synthesize(PHRASES[lang], { language: lang, sampleRate: rate });
    const seconds = pcm.length / 2 / rate;
    if (seconds < 0.3) throw new Error(`TTS returned only ${seconds.toFixed(2)} s of audio`);
    const t1 = Date.now();
    const heard = await recogniser.recognize(pcm, { language: lang, sampleRate: rate });
    if (!heard.text) throw new Error('STT returned an empty transcript');
    const detected = heard.language === lang ? heard.language : `${heard.language ?? 'none'} (expected ${lang})`;
    say(`PASS  ${label}: TTS ${seconds.toFixed(1)} s of audio in ${t1 - t0} ms; STT in ${Date.now() - t1} ms, language ${detected}`);
    say(`      said:  ${PHRASES[lang]}`);
    say(`      heard: ${heard.text}`);
  } catch (err) {
    failures++;
    say(`FAIL  ${label}: ${err instanceof Error ? err.message : 'unknown error'}`, 'err');
  }
}
say(failures === 0 ? `All ${cases.length} case(s) passed.` : `${failures} of ${cases.length} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
