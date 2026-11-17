// Sarvam AI speech-to-text (saaras) over REST: POST https://api.sarvam.ai/speech-to-text, multipart, one
// utterance per request (the REST endpoint is meant for clips under 30 s). The utterance is sent as WAV: Sarvam
// accepts raw PCM only at 16 kHz, and WAV also carries Exotel's 8 kHz audio. With language "auto" Sarvam
// detects the language of every utterance (callers switch between Malayalam, English, Tamil and Hindi); with
// "session" it is told the session's language. Sarvam returns no transcript confidence, so confidence is null.
// Contract-tested against a local stub; live behaviour is checked with `npm run speech:smoke`.
import { LANGS, SPEECH_LOCALES, type Lang } from '../../utils/language.ts';
import { SpeechProviderError, type SttAdapter, type SttResult } from './stt.port.ts';

export const SARVAM_BASE_URL = 'https://api.sarvam.ai';
export type SarvamSttLanguage = 'auto' | 'session';

export interface SarvamSttConfig {
  apiKey: string;
  /** e.g. saaras:v4 */
  model: string;
  language: SarvamSttLanguage;
  baseUrl?: string;
  timeoutMs?: number;
}

/** 16-bit little-endian mono PCM → a WAV file (44-byte RIFF header). */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Sarvam's BCP-47 code (ml-IN, …) → one of our four languages; anything else, or nothing detected, is null. */
export const sarvamLanguage = (code: string | null | undefined): Lang | null => LANGS.find((l) => SPEECH_LOCALES[l].toLowerCase() === code?.toLowerCase()) ?? null;

/**
 * One POST to Sarvam, shared by the STT and TTS adapters. The key travels only in the api-subscription-key header
 * and is scrubbed from every error message (no error carries a cause that could hold request details).
 */
export async function postToSarvam(url: string, body: FormData | string, opts: { apiKey: string; timeoutMs: number; what: string }): Promise<Record<string, unknown>> {
  const redact = (text: string) => (opts.apiKey ? text.split(opts.apiKey).join('[redacted]') : text);
  const headers: Record<string, string> = { 'api-subscription-key': opts.apiKey };
  if (typeof body === 'string') headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    throw new SpeechProviderError(redact(`${opts.what} request failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (json['error'] ?? {}) as { code?: string; message?: string; request_id?: string | null };
    const detail = `${error.code ? `${error.code}: ` : ''}${error.message ?? response.statusText}${error.request_id ? ` (request ${error.request_id})` : ''}`;
    throw new SpeechProviderError(redact(`${opts.what} error ${response.status}: ${detail}`));
  }
  return json;
}

export function createSarvamStt(config: SarvamSttConfig): SttAdapter {
  const url = `${config.baseUrl ?? SARVAM_BASE_URL}/speech-to-text`;
  const timeoutMs = config.timeoutMs ?? 15_000;
  return {
    name: 'sarvam',
    async recognize(audio, opts): Promise<SttResult> {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(pcmToWav(audio, opts.sampleRate))], { type: 'audio/wav' }), 'utterance.wav');
      form.append('model', config.model);
      form.append('language_code', config.language === 'auto' ? 'unknown' : SPEECH_LOCALES[opts.language]);
      const json = await postToSarvam(url, form, { apiKey: config.apiKey, timeoutMs, what: 'Sarvam STT' });
      const transcript = typeof json['transcript'] === 'string' ? json['transcript'] : '';
      return { text: transcript.trim(), confidence: null, language: sarvamLanguage(json['language_code'] as string | null | undefined) };
    },
  };
}
