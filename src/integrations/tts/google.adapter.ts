// Google Cloud Text-to-Speech v1 `text:synthesize` over REST with an API key. WaveNet voices exist for
// en-IN, hi-IN, ta-IN and ml-IN (verified on Google's voice list, ARCHITECTURE.md §C.4). Output is requested
// as LINEAR16 at the telephony sample rate and the WAV header is stripped. NOT exercised against the live
// API in this repository: verify pronunciation of medicine names per language with the sample calls.
import { SPEECH_LOCALES, type Lang } from '../../utils/language.ts';
import { SpeechProviderError, type TtsAdapter } from './tts.port.ts';

export interface GoogleTtsConfig {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  voices?: Partial<Record<Lang, string>>;
}

export const DEFAULT_GOOGLE_VOICES: Record<Lang, string> = {
  en: 'en-IN-Wavenet-D',
  ml: 'ml-IN-Wavenet-A',
  ta: 'ta-IN-Wavenet-A',
  hi: 'hi-IN-Wavenet-A',
};

/** Google returns LINEAR16 inside a WAV container; the stream needs raw PCM. */
export function stripWavHeader(wav: Buffer): Buffer {
  if (wav.length >= 44 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE') {
    // find the "data" chunk rather than assuming a 44-byte header
    let offset = 12;
    while (offset + 8 <= wav.length) {
      const id = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size;
    }
    return wav.subarray(44);
  }
  return wav;
}

export function createGoogleTts(config: GoogleTtsConfig): TtsAdapter {
  const endpoint = config.endpoint ?? 'https://texttospeech.googleapis.com/v1/text:synthesize';
  const timeoutMs = config.timeoutMs ?? 10_000;
  const voices = { ...DEFAULT_GOOGLE_VOICES, ...(config.voices ?? {}) };
  return {
    name: 'google',
    async synthesize(text, opts) {
      const body = {
        input: { text },
        voice: { languageCode: SPEECH_LOCALES[opts.language], name: voices[opts.language] },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: opts.sampleRate },
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
        throw new SpeechProviderError(`Google TTS request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      const json = (await response.json().catch(() => ({}))) as { audioContent?: string; error?: { message?: string } };
      if (!response.ok || !json.audioContent) throw new SpeechProviderError(`Google TTS error ${response.status}: ${json.error?.message ?? response.statusText}`);
      return stripWavHeader(Buffer.from(json.audioContent, 'base64'));
    },
  };
}
