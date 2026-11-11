// Text-to-speech port. Returns raw 16-bit little-endian mono PCM at the requested rate so the telephony
// layer can stream it straight into the call.
import type { Lang } from '../../utils/language.ts';

export interface TtsOptions {
  language: Lang;
  sampleRate: 8000 | 16000;
}

export interface TtsAdapter {
  readonly name: 'mock' | 'google';
  synthesize(text: string, opts: TtsOptions): Promise<Buffer>;
}

export { SpeechProviderError } from '../stt/stt.port.ts';
