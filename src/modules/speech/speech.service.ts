// Speech façade: picks the configured STT/TTS adapters and exposes transcribe/speak to the telephony layer.
import { env } from '../../config/env.ts';
import { createGoogleStt } from '../../integrations/stt/google.adapter.ts';
import { createMockStt, type MockSttAdapter } from '../../integrations/stt/mock.adapter.ts';
import type { SttAdapter, SttResult } from '../../integrations/stt/stt.port.ts';
import { createGoogleTts } from '../../integrations/tts/google.adapter.ts';
import { createMockTts, type MockTtsAdapter } from '../../integrations/tts/mock.adapter.ts';
import type { TtsAdapter } from '../../integrations/tts/tts.port.ts';
import { LANGS, type Lang } from '../../utils/language.ts';

/** Shared mock instances so tests can script transcripts and inspect what was spoken. */
export const mockStt: MockSttAdapter = createMockStt();
export const mockTts: MockTtsAdapter = createMockTts();

let stt: SttAdapter | undefined;
let tts: TtsAdapter | undefined;

export function getStt(): SttAdapter {
  if (!stt) stt = env.STT_PROVIDER === 'google' ? createGoogleStt({ apiKey: env.GOOGLE_SPEECH_API_KEY! }) : mockStt;
  return stt;
}

export function getTts(): TtsAdapter {
  if (!tts) tts = env.TTS_PROVIDER === 'google' ? createGoogleTts({ apiKey: env.GOOGLE_SPEECH_API_KEY! }) : mockTts;
  return tts;
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
