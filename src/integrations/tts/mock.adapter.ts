// Silent "speech" for tests and local runs: a PCM buffer whose length scales with the text.
import type { TtsAdapter } from './tts.port.ts';

export interface MockTtsAdapter extends TtsAdapter {
  readonly spoken: Array<{ text: string; language: string }>;
}

export function createMockTts(): MockTtsAdapter {
  const spoken: Array<{ text: string; language: string }> = [];
  return {
    name: 'mock',
    spoken,
    async synthesize(text, opts) {
      spoken.push({ text, language: opts.language });
      const seconds = Math.max(0.2, Math.min(20, text.length * 0.05));
      return Buffer.alloc(Math.round(seconds * opts.sampleRate) * 2);
    },
  };
}
