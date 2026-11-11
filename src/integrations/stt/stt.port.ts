// Speech-to-text port. Utterance-level recognition: the telephony layer cuts the caller's audio at
// silence boundaries (see modules/telephony/telephony.media.ts) and sends one utterance at a time, so a
// synchronous recognise call is enough and no streaming/gRPC dependency is needed.
import type { Lang } from '../../utils/language.ts';

export interface SttOptions {
  sampleRate: 8000 | 16000;
  /** Primary language of the session */
  language: Lang;
  /** Other languages the caller may switch to (code-switching); providers that support it pick the best */
  alternatives?: Lang[];
}

export interface SttResult {
  text: string;
  confidence: number | null;
  /** Language the provider believes it heard, when reported */
  language: Lang | null;
}

export class SpeechProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SpeechProviderError';
  }
}

export interface SttAdapter {
  readonly name: 'mock' | 'google';
  /** `audio` is 16-bit little-endian mono PCM at `opts.sampleRate`. */
  recognize(audio: Buffer, opts: SttOptions): Promise<SttResult>;
}
