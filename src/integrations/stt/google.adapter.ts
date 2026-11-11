// Google Cloud Speech-to-Text v1 `speech:recognize` over REST with an API key. Supports en-IN, hi-IN,
// ta-IN and ml-IN (verified on Google's language list, ARCHITECTURE.md §C.3). Synchronous recognition is
// limited to ~60 s of audio, which fits utterance-level use. NOT exercised against the live API in this
// repository: verify with the sample calls (§G-8) before enabling a production route.
import { LANGS, SPEECH_LOCALES, type Lang } from '../../utils/language.ts';
import { SpeechProviderError, type SttAdapter, type SttResult } from './stt.port.ts';

export interface GoogleSttConfig {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
}

interface RecognizeResponse {
  results?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }>; languageCode?: string }>;
  error?: { message?: string };
}

function localeToLang(locale: string | undefined): Lang | null {
  if (!locale) return null;
  const prefix = locale.toLowerCase().slice(0, 2);
  return (LANGS as readonly string[]).includes(prefix) ? (prefix as Lang) : null;
}

export function createGoogleStt(config: GoogleSttConfig): SttAdapter {
  const endpoint = config.endpoint ?? 'https://speech.googleapis.com/v1/speech:recognize';
  const timeoutMs = config.timeoutMs ?? 10_000;
  return {
    name: 'google',
    async recognize(audio, opts): Promise<SttResult> {
      const body = {
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: opts.sampleRate,
          languageCode: SPEECH_LOCALES[opts.language],
          alternativeLanguageCodes: (opts.alternatives ?? []).filter((l) => l !== opts.language).slice(0, 3).map((l) => SPEECH_LOCALES[l]),
          enableAutomaticPunctuation: true,
        },
        audio: { content: audio.toString('base64') },
      };
      let response: Response;
      try {
        response = await fetch(`${endpoint}?key=${encodeURIComponent(config.apiKey)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new SpeechProviderError(`Google STT request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      const json = (await response.json().catch(() => ({}))) as RecognizeResponse;
      if (!response.ok) throw new SpeechProviderError(`Google STT error ${response.status}: ${json.error?.message ?? response.statusText}`);
      const best = json.results?.[0];
      const alt = best?.alternatives?.[0];
      return { text: (alt?.transcript ?? '').trim(), confidence: alt?.confidence ?? null, language: localeToLang(best?.languageCode) };
    },
  };
}
