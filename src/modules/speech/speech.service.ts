// Speech façade: picks the configured STT/TTS adapters and exposes transcribe/speak to the telephony layer.
import { env, type Env } from '../../config/env.ts';
import { createGoogleStt } from '../../integrations/stt/google.adapter.ts';
import { createMockStt, type MockSttAdapter } from '../../integrations/stt/mock.adapter.ts';
import { createSarvamStt } from '../../integrations/stt/sarvam.adapter.ts';
import type { SttAdapter, SttResult } from '../../integrations/stt/stt.port.ts';
import { createGoogleTts } from '../../integrations/tts/google.adapter.ts';
import { createMockTts, type MockTtsAdapter } from '../../integrations/tts/mock.adapter.ts';
import { createSarvamTts } from '../../integrations/tts/sarvam.adapter.ts';
import type { TtsAdapter } from '../../integrations/tts/tts.port.ts';
import { LANGS, type Lang } from '../../utils/language.ts';

/** Shared mock instances so tests can script transcripts and inspect what was spoken. */
export const mockStt: MockSttAdapter = createMockStt();
export const mockTts: MockTtsAdapter = createMockTts();

export type SpeechConfig = Pick<
  Env,
  'STT_PROVIDER' | 'TTS_PROVIDER' | 'GOOGLE_SPEECH_API_KEY' | 'SARVAM_API_KEY' | 'SARVAM_STT_MODEL' | 'SARVAM_STT_LANGUAGE' | 'SARVAM_TTS_MODEL' | 'SARVAM_TTS_SPEAKER'
>;

/** The configured speech-to-text adapter (keys are guaranteed by the env validation). */
export function createStt(c: SpeechConfig): SttAdapter {
  if (c.STT_PROVIDER === 'google') return createGoogleStt({ apiKey: c.GOOGLE_SPEECH_API_KEY! });
  if (c.STT_PROVIDER === 'sarvam') return createSarvamStt({ apiKey: c.SARVAM_API_KEY!, model: c.SARVAM_STT_MODEL, language: c.SARVAM_STT_LANGUAGE });
  return mockStt;
}

/** The configured text-to-speech adapter. */
export function createTts(c: SpeechConfig): TtsAdapter {
  if (c.TTS_PROVIDER === 'google') return createGoogleTts({ apiKey: c.GOOGLE_SPEECH_API_KEY! });
  if (c.TTS_PROVIDER === 'sarvam') return createSarvamTts({ apiKey: c.SARVAM_API_KEY!, model: c.SARVAM_TTS_MODEL, speaker: c.SARVAM_TTS_SPEAKER });
  return mockTts;
}

let stt: SttAdapter | undefined;
let tts: TtsAdapter | undefined;

export function getStt(): SttAdapter {
  return (stt ??= createStt(env));
}

export function getTts(): TtsAdapter {
  return (tts ??= createTts(env));
}

export const speechService = {
  /** Recognises one utterance in the session language, allowing the other three as alternatives (code-switching). */
  transcribe(audio: Buffer, language: Lang, sampleRate: 8000 | 16000 = 8000): Promise<SttResult> {
    return getStt().recognize(audio, { sampleRate, language, alternatives: LANGS.filter((l) => l !== language) });
  },
  speak(text: string, language: Lang, sampleRate: 8000 | 16000 = 8000): Promise<Buffer> {
    return getTts().synthesize(text, { language, sampleRate });
  },
};
