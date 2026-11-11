import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { frameRms, UtteranceDetector } from './telephony.media.ts';

function frame(amplitude: number, samples = 160): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b;
}

describe('voice activity detection', () => {
  it('measures frame energy', () => {
    assert.equal(frameRms(frame(0)), 0);
    assert.equal(Math.round(frameRms(frame(1000))), 1000);
  });

  it('cuts an utterance after trailing silence and ignores short noise bursts', () => {
    const vad = new UtteranceDetector({ threshold: 450, frameMs: 20, silenceEndMs: 700, minSpeechMs: 300, maxUtteranceMs: 15_000 });
    let out: Buffer | null = null;
    for (let i = 0; i < 20; i++) out = vad.feed(frame(2000)); // 400 ms of speech
    assert.equal(out, null);
    assert.equal(vad.inSpeech, true);
    for (let i = 0; i < 34; i++) out = vad.feed(frame(0)); // 680 ms silence, not yet
    assert.equal(out, null);
    out = vad.feed(frame(0)); // 700 ms
    assert.ok(out);
    assert.equal(out!.length, 55 * 320);
    assert.equal(vad.inSpeech, false);

    // a 100 ms click followed by silence is discarded
    for (let i = 0; i < 5; i++) vad.feed(frame(2000));
    let result: Buffer | null = null;
    for (let i = 0; i < 35; i++) result = vad.feed(frame(0));
    assert.equal(result, null);
  });

  it('force-ends very long utterances', () => {
    const vad = new UtteranceDetector({ threshold: 450, frameMs: 20, silenceEndMs: 700, minSpeechMs: 300, maxUtteranceMs: 1000 });
    let out: Buffer | null = null;
    for (let i = 0; i < 50 && !out; i++) out = vad.feed(frame(2000));
    assert.ok(out);
    assert.equal(out!.length, 50 * 320);
  });
});
