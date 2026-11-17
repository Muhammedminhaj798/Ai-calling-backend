// LiveKit transport with a fake audio output: PCM ⇄ 16 kHz frame conversion, playback completion (including a
// stale completion), and barge-in through the real voice loop. No LiveKit connection.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { ConversationSession } from '../../modules/ai/ai.types.ts';
import { callsService, type StartSessionInput } from '../../modules/calls/calls.service.ts';
import { sessionRegistry } from '../../modules/calls/session.registry.ts';
import { speechService } from '../../modules/speech/speech.service.ts';
import { createVoiceLoop } from '../../modules/voice/voice.loop.ts';
import { callerFrameToPcm, createLiveKitTransport, LIVEKIT_SAMPLE_RATE, pcmToFrames, type AgentAudioOutput } from './livekit.transport.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** 16 kHz square wave, little-endian bytes. */
function pcm(amplitude: number, ms: number): Buffer {
  const samples = (LIVEKIT_SAMPLE_RATE / 1000) * ms;
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b;
}

function fakeOutput(opts: { slow?: boolean } = {}) {
  const log = { captured: [] as Int16Array[], clears: 0, playouts: [] as Array<ReturnType<typeof deferred>> };
  const output: AgentAudioOutput = {
    capture(samples) {
      log.captured.push(samples);
      return opts.slow ? new Promise((r) => setImmediate(r)) : Promise.resolve();
    },
    clearQueue: () => void log.clears++,
    waitForPlayout() {
      const d = deferred();
      log.playouts.push(d);
      return d.promise;
    },
  };
  return { output, log };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('LiveKit audio conversion', () => {
  it('splits little-endian PCM into 20 ms frames of 320 samples, each with its own buffer', () => {
    const bytes = Buffer.alloc(2 * 700);
    for (let i = 0; i < 700; i++) bytes.writeInt16LE(i - 350, i * 2);
    const frames = pcmToFrames(bytes);
    assert.deepEqual(frames.map((f) => f.length), [320, 320, 60]);
    assert.equal(frames[1]![0], 320 - 350);
    assert.equal(frames[2]![59], 699 - 350);
    for (const f of frames) assert.deepEqual([f.byteOffset, f.buffer.byteLength], [0, f.byteLength], 'rtc-node sends the whole ArrayBuffer');
  });

  it('turns a 16 kHz mono caller frame into the same PCM bytes, honouring the view offset', () => {
    const backing = new Int16Array([9, 9, 1000, -1000, 7]);
    const view = backing.subarray(2, 4);
    assert.deepEqual(callerFrameToPcm({ data: view, sampleRate: 16000, channels: 1 }), Buffer.from([0xe8, 0x03, 0x18, 0xfc]));
  });

  it('refuses caller audio that is not 16 kHz mono instead of misreading it', () => {
    assert.equal(callerFrameToPcm({ data: new Int16Array(960), sampleRate: 48000, channels: 1 }), null);
    assert.equal(callerFrameToPcm({ data: new Int16Array(640), sampleRate: 16000, channels: 2 }), null);
  });
});

describe('LiveKit transport', () => {
  afterEach(() => {
    mock.restoreAll();
    sessionRegistry.delete('call-lk');
  });

  it('reports playback finished when the queue has played out, but never for an older reply', async () => {
    const { output, log } = fakeOutput();
    const finished = mock.fn();
    const transport = createLiveKitTransport(output, { onPlaybackFinished: finished, transferToStaff: async () => undefined });

    transport.frames(pcm(1000, 40)); // reply 1
    transport.markEnd();
    transport.frames(pcm(1000, 40)); // reply 2 starts before reply 1 has played out
    log.playouts[0]!.resolve();
    await settle();
    assert.equal(finished.mock.callCount(), 0, 'stale playout of reply 1 ignored');

    transport.markEnd();
    log.playouts[1]!.resolve();
    await settle();
    assert.equal(finished.mock.callCount(), 1);
  });

  it('a clear drops the queued audio and makes any pending playout stale', async () => {
    const { output, log } = fakeOutput();
    const finished = mock.fn();
    const transport = createLiveKitTransport(output, { onPlaybackFinished: finished, transferToStaff: async () => undefined });
    transport.frames(pcm(1000, 40));
    transport.markEnd();
    transport.clear();
    assert.equal(log.clears, 1);
    log.playouts[0]!.resolve();
    await settle();
    assert.equal(finished.mock.callCount(), 0);
  });

  async function greetingLoop(greetingMs: number, slow: boolean) {
    mock.method(callsService, 'startSession', async (input: StartSessionInput) => {
      const session = { callId: 'call-lk', providerCallSid: input.providerCallSid, language: 'en' } as ConversationSession;
      sessionRegistry.set(session);
      return { callId: 'call-lk', session, greeting: { reply: 'Hello', language: 'en' as const, state: 'confirming_location' as const, toolCalls: [], ended: false }, resumed: false };
    });
    const speak = mock.method(speechService, 'speak', async () => pcm(1000, greetingMs));
    const { output, log } = fakeOutput({ slow });
    const loop = createVoiceLoop(createLiveKitTransport(output, { onPlaybackFinished: () => loop.playbackFinished(), transferToStaff: async () => undefined }));
    await loop.start({ provider: 'livekit', providerCallSid: 'call-x', fromNumber: '+919847012345', toNumber: 'browser' });
    return { loop, log, speak };
  }

  it('through the voice loop: speech is captured at 16 kHz and a barge-in clears it mid-reply', async () => {
    const { loop, log, speak } = await greetingLoop(2000, true); // 2 s = 100 frames, captured with back-pressure
    while (log.captured.length < 5) await settle();
    assert.equal(speak.mock.calls[0]!.arguments[2], 16000);
    loop.audio(pcm(2000, 40)); // the caller talks over the greeting
    while (log.playouts.length === 0) await settle();
    assert.equal(log.clears, 1);
    assert.ok(log.captured.length < 100, `stopped after ${log.captured.length} of 100 frames`);
    assert.ok(log.captured.every((f) => f.length === 320));
  });

  it('through the voice loop: once playout completes, caller sound no longer interrupts anything', async () => {
    const { loop, log } = await greetingLoop(100, false);
    while (log.playouts.length === 0) await settle();
    log.playouts[0]!.resolve();
    await settle();
    loop.audio(pcm(2000, 40));
    assert.equal(log.clears, 0);
  });

  it('through the voice loop: before playout completes, caller sound is a barge-in', async () => {
    const { loop, log } = await greetingLoop(100, false);
    while (log.playouts.length === 0) await settle();
    loop.audio(pcm(2000, 40));
    assert.equal(log.clears, 1);
  });
});
