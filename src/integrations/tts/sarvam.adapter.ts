// Sarvam AI text-to-speech (bulbul) over REST: POST https://api.sarvam.ai/text-to-speech. Asks for linear16
// PCM at the telephony rate (8 kHz Exotel, 16 kHz LiveKit), so the audio streams straight into the call; a WAV
// container, if one comes back anyway, is stripped. bulbul:v3 takes at most 2500 characters per request, so
// longer text is split at sentence ends and the pieces are synthesised in order. Contract-tested against a
// local stub; live behaviour is checked with `npm run speech:smoke`.
import { SPEECH_LOCALES } from '../../utils/language.ts';
import { postToSarvam, SARVAM_BASE_URL } from '../stt/sarvam.adapter.ts';
import { stripWavHeader } from './google.adapter.ts';
import { SpeechProviderError, type TtsAdapter } from './tts.port.ts';

/** bulbul:v3's per-request text limit, in characters. */
export const SARVAM_TTS_MAX_CHARS = 2500;

export interface SarvamTtsConfig {
  apiKey: string;
  /** e.g. bulbul:v3 */
  model: string;
  /** e.g. shubh */
  speaker: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const length = (text: string) => [...text].length; // code points, not UTF-16 units

/** Greedily joins parts with `separator` into chunks of at most `max` characters; an oversized part stays whole. */
function pack(parts: string[], max: number, separator: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const part of parts) {
    const joined = current ? current + separator + part : part;
    if (length(joined) <= max) {
      current = joined;
      continue;
    }
    if (current) chunks.push(current);
    current = part;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Splits text into pieces of at most `max` characters: between sentences (. ! ? । ॥ or a line break) where
 * possible, then between words for an overlong sentence, and only as a last resort inside a word.
 */
export function splitForTts(text: string, max = SARVAM_TTS_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (length(trimmed) <= max) return trimmed ? [trimmed] : [];
  const pieces: string[] = [];
  for (const chunk of pack(trimmed.split(/(?<=[.!?।॥])\s+|\s*\n+\s*/u).filter(Boolean), max, ' ')) {
    if (length(chunk) <= max) {
      pieces.push(chunk);
      continue;
    }
    for (const words of pack(chunk.split(/\s+/u), max, ' ')) {
      if (length(words) <= max) pieces.push(words);
      else for (let i = 0, cps = [...words]; i < cps.length; i += max) pieces.push(cps.slice(i, i + max).join(''));
    }
  }
  return pieces;
}

export function createSarvamTts(config: SarvamTtsConfig): TtsAdapter {
  const url = `${config.baseUrl ?? SARVAM_BASE_URL}/text-to-speech`;
  const timeoutMs = config.timeoutMs ?? 15_000;
  return {
    name: 'sarvam',
    async synthesize(text, opts) {
      const audio: Buffer[] = [];
      for (const piece of splitForTts(text)) {
        const json = await postToSarvam(
          url,
          JSON.stringify({
            text: piece,
            language_code: SPEECH_LOCALES[opts.language],
            speaker: config.speaker,
            model: config.model,
            speech_sample_rate: opts.sampleRate,
            output_audio_codec: 'linear16',
          }),
          { apiKey: config.apiKey, timeoutMs, what: 'Sarvam TTS' },
        );
        const audios = json['audios'];
        if (!Array.isArray(audios) || audios.length === 0 || !audios.every((a) => typeof a === 'string' && a.length > 0)) {
          throw new SpeechProviderError('Sarvam TTS returned no audio');
        }
        for (const encoded of audios as string[]) audio.push(stripWavHeader(Buffer.from(encoded, 'base64')));
      }
      return Buffer.concat(audio);
    },
  };
}
