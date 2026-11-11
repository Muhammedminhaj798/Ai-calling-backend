// Scripted speech-to-text for tests and local runs: returns queued transcripts instead of recognising audio.
import type { Lang } from '../../utils/language.ts';
import type { SttAdapter, SttResult } from './stt.port.ts';

export interface MockSttAdapter extends SttAdapter {
  enqueue(text: string, language?: Lang, confidence?: number): void;
  readonly received: Array<{ bytes: number; language: Lang }>;
}

export function createMockStt(): MockSttAdapter {
  const queue: SttResult[] = [];
  const received: Array<{ bytes: number; language: Lang }> = [];
  return {
    name: 'mock',
    received,
    enqueue(text, language, confidence = 0.95) {
      queue.push({ text, confidence, language: language ?? null });
    },
    async recognize(audio, opts) {
      received.push({ bytes: audio.length, language: opts.language });
      return queue.shift() ?? { text: '', confidence: null, language: null };
    },
  };
}
