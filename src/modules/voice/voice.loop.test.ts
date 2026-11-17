// Shared voice loop through a fake transport: frame sizing at 8 and 16 kHz, utterance cutting across
// arbitrary chunk sizes, barge-in with an asynchronous transport, the transport's own handover, replies
// synthesised and played sentence by sentence, and nothing recognised, answered or sent after a hang-up.
// Call and speech services are in-memory stubs: no database or provider is contacted.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { ConversationSession, TurnResult } from '../ai/ai.types.ts';
import { callsService, type StartSessionInput } from '../calls/calls.service.ts';
import { sessionRegistry } from '../calls/session.registry.ts';
import { logger } from '../../utils/logger.ts';
import { speechService } from '../speech/speech.service.ts';
import { createVoiceLoop, frameBytes, speechPieces, synthesizeInOrder, type SampleRate, type VoiceTransport } from './voice.loop.ts';

const CALL_ID = 'call-voice';
const CALL: StartSessionInput = { provider: 'test', providerCallSid: 'room-1', fromNumber: '+919847012345', toNumber: 'browser' };

/** `ms` of a square wave at `amplitude`, 16-bit mono PCM at `rate`. */
function pcm(rate: SampleRate, amplitude: number, ms: number): Buffer {
  const samples = (rate / 1000) * ms;
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b;
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const turnResult = (reply: string, state: TurnResult['state'] = 'collecting_items', ended = false): TurnResult => ({ reply, language: 'en', state, toolCalls: [], ended });

function stubServices(turns: TurnResult[] = [], speech: (rate: SampleRate) => Buffer = (rate) => pcm(rate, 1000, 200)) {
  mock.method(callsService, 'startSession', async (input: StartSessionInput) => {
    const session = { callId: CALL_ID, providerCallSid: input.providerCallSid, language: 'en' } as ConversationSession;
    sessionRegistry.set(session);
    return { callId: CALL_ID, session, greeting: turnResult('Hello', 'confirming_location'), resumed: false };
  });
  const turn = mock.method(callsService, 'turn', async () => turns.shift() ?? turnResult('Anything else?'));
  const endSession = mock.method(callsService, 'endSession', async (callId: string) => {
    sessionRegistry.delete(callId);
    return 'completed' as const;
  });
  const speak = mock.method(speechService, 'speak', async (_text: string, _lang: string, rate: SampleRate = 8000) => speech(rate));
  const transcribe = mock.method(speechService, 'transcribe', async () => ({ text: 'two strips of Dolo 650', confidence: 0.9, language: 'en' as const }));
  return { turn, endSession, speak, transcribe };
}

/** 20 ms playback units, like a WebRTC audio source; `async` makes each send wait a macrotask. */
function fakeTransport(sampleRate: SampleRate, opts: { async?: boolean } = {}) {
  const log = { sent: 0, marks: 0, clears: 0, transfers: [] as string[][] };
  const unit = frameBytes(sampleRate);
  const transport: VoiceTransport<Buffer> = {
    sampleRate,
    canPlay: () => true,
    *frames(audio) {
      for (let o = 0; o < audio.length; o += unit) yield audio.subarray(o, o + unit);
    },
    send() {
      log.sent++;
      return opts.async ? new Promise<void>((r) => setImmediate(r)) : undefined;
    },
    markEnd: () => void log.marks++,
    clear: () => void log.clears++,
    async transferToStaff(callId, providerCallSid) {
      log.transfers.push([callId, providerCallSid]);
    },
  };
  return { transport, log };
}

describe('voice loop', () => {
  afterEach(() => {
    mock.restoreAll();
    sessionRegistry.delete(CALL_ID);
  });

  it('sizes 20 ms frames from the sample rate', () => {
    assert.equal(frameBytes(8000), 320);
    assert.equal(frameBytes(16000), 640);
  });

  for (const rate of [8000, 16000] as const) {
    it(`at ${rate} Hz: greets, cuts the utterance after 700 ms of silence across odd chunk sizes, answers`, async () => {
      const s = stubServices();
      const { transport, log } = fakeTransport(rate);
      const loop = createVoiceLoop(transport);
      await loop.start(CALL);
      await until(() => log.marks === 1, 'greeting played');
      assert.equal(loop.callId, CALL_ID);
      assert.equal(s.speak.mock.calls[0]?.arguments[2], rate, 'speech synthesised at the transport rate');
      assert.equal(log.sent, 10, '200 ms of greeting in 20 ms units');
      loop.playbackFinished();

      const caller = Buffer.concat([pcm(rate, 2000, 500), pcm(rate, 0, 800)]);
      for (let o = 0; o < caller.length; o += 777) loop.audio(caller.subarray(o, o + 777)); // not a multiple of any frame size
      await until(() => log.marks === 2, 'reply played');

      const [audio, , sttRate] = s.transcribe.mock.calls[0]!.arguments;
      assert.equal(audio?.length, (25 + 35) * frameBytes(rate), '25 voiced + 35 silent 20 ms frames');
      assert.equal(sttRate, rate);
      assert.deepEqual(s.turn.mock.calls[0]?.arguments, [CALL_ID, 'two strips of Dolo 650', { confidence: 0.9 }]);
      assert.equal(log.clears, 0);
    });
  }

  it('barge-in stops an asynchronous transport mid-speech and clears it once', async () => {
    stubServices([], (rate) => pcm(rate, 1000, 2000)); // 2 s of agent speech = 100 units
    const { transport, log } = fakeTransport(16000, { async: true });
    const loop = createVoiceLoop(transport);
    await loop.start(CALL);
    await until(() => log.sent >= 5, 'agent speaking');
    loop.audio(pcm(16000, 2000, 40));
    await until(() => log.marks === 1, 'speech stopped');
    assert.equal(log.clears, 1);
    assert.ok(log.sent < 100, `stopped after ${log.sent} of 100 units`);
  });

  it('hands over through the transport, after the reply', async () => {
    stubServices([turnResult('Connecting you to staff', 'handover_required', true)]);
    const { transport, log } = fakeTransport(16000);
    const loop = createVoiceLoop(transport);
    await loop.start(CALL);
    loop.playbackFinished();
    loop.audio(Buffer.concat([pcm(16000, 2000, 500), pcm(16000, 0, 800)]));
    await until(() => log.transfers.length === 1, 'transfer');
    assert.deepEqual(log.transfers, [[CALL_ID, 'room-1']]);
    assert.equal(log.marks, 2, 'reply spoken before the transfer');
  });

  it('plays nothing until the transport can play, and ends the session only once', async () => {
    const s = stubServices();
    const { transport, log } = fakeTransport(8000);
    const loop = createVoiceLoop({ ...transport, canPlay: () => false });
    await loop.start(CALL);
    await new Promise((r) => setImmediate(r));
    assert.equal(s.speak.mock.callCount(), 0);
    assert.equal(log.sent, 0);
    await loop.end();
    await loop.end();
    assert.equal(s.endSession.mock.callCount(), 1);
    assert.deepEqual(s.endSession.mock.calls[0]?.arguments, [CALL_ID, 'caller_hangup']);
  });

  it('splits a reply into sentences without dropping or reordering text', () => {
    assert.deepEqual(speechPieces('  Dolo 650, 2 strips. Is that right? Yes!\nനന്ദി। ശരി  '),['Dolo 650, 2 strips.', 'Is that right?', 'Yes!', 'നന്ദി।', 'ശരി']);
    assert.deepEqual(speechPieces('Paracetamol 2.5 mg'), ['Paracetamol 2.5 mg'], 'no split inside a number');
    assert.deepEqual(speechPieces('   '), []);
  });

  it('synthesises ahead with bounded concurrency and yields audio in order', async () => {
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const synth = (piece: string) => {
      started.push(piece);
      return new Promise<Buffer>((resolve) => release.set(piece, () => resolve(Buffer.from(piece))));
    };
    const out: string[] = [];
    const done = (async () => {
      for await (const audio of synthesizeInOrder(['a', 'b', 'c', 'd'], synth, 2)) out.push(audio.toString());
    })();
    await until(() => started.length === 2, 'two requests');
    assert.deepEqual(started, ['a', 'b'], 'at most two in flight');
    release.get('b')!();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(out, [], 'b waits for a');
    assert.equal(started.length, 2, 'nothing new requested while a is pending');
    release.get('a')!();
    await until(() => started.length === 4, 'c and d requested as a and b are consumed');
    release.get('d')!();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(out, ['a', 'b'], 'd waits for c');
    release.get('c')!();
    await done;
    assert.deepEqual(out, ['a', 'b', 'c', 'd']);
  });

  it('an abandoned request that fails is not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const synth = async (piece: string) => {
        if (piece === 'b') throw new Error('tts down');
        return Buffer.from(piece);
      };
      for await (const audio of synthesizeInOrder(['a', 'b'], synth, 2)) {
        assert.equal(audio.toString(), 'a');
        break; // barge-in after the first sentence
      }
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('speaks a reply sentence by sentence, in order, with one end mark', async () => {
    const s = stubServices([turnResult('Dolo 650, 2 strips. Is that right?')]);
    const { transport, log } = fakeTransport(16000);
    const loop = createVoiceLoop(transport);
    await loop.start(CALL);
    loop.playbackFinished();
    loop.audio(Buffer.concat([pcm(16000, 2000, 500), pcm(16000, 0, 800)]));
    await until(() => log.marks === 2, 'reply played');
    assert.deepEqual(s.speak.mock.calls.map((c) => c.arguments[0]), ['Hello', 'Dolo 650, 2 strips.', 'Is that right?']);
    assert.equal(log.sent, 30, 'greeting + two sentences, 200 ms each');
  });

  it('a sentence that fails to synthesise ends the reply there: later sentences are never played', async () => {
    const s = stubServices([turnResult('One. Two. Three.')]);
    s.speak.mock.mockImplementation(async (text: string) => {
      if (text === 'Two.') throw new Error('tts down');
      return pcm(16000, 1000, 200);
    });
    const { transport, log } = fakeTransport(16000);
    const loop = createVoiceLoop(transport);
    await loop.start(CALL);
    loop.playbackFinished();
    loop.audio(Buffer.concat([pcm(16000, 2000, 500), pcm(16000, 0, 800)]));
    await until(() => log.marks === 2, 'reply ended');
    assert.equal(log.sent, 20, 'greeting and "One." only');
  });

  it('barge-in between sentences stops the rest of the reply', async () => {
    const s = stubServices([turnResult('One. Two. Three.')]);
    let releaseTwo!: () => void;
    s.speak.mock.mockImplementation(async (text: string) => {
      if (text === 'Two.') await new Promise<void>((r) => (releaseTwo = r));
      return pcm(16000, 1000, 200);
    });
    const { transport, log } = fakeTransport(16000);
    const loop = createVoiceLoop(transport);
    await loop.start(CALL);
    loop.playbackFinished();
    loop.audio(Buffer.concat([pcm(16000, 2000, 500), pcm(16000, 0, 800)]));
    await until(() => log.sent === 20, '"One." sent');
    loop.audio(pcm(16000, 2000, 40)); // caller talks while "Two." is still being synthesised
    releaseTwo();
    await until(() => log.marks === 2, 'reply ended');
    assert.equal(log.sent, 20, 'nothing after the barge-in');
    assert.equal(log.clears, 1);
  });

  describe('when the caller talks past a reply', () => {
    const UTTERANCE = () => Buffer.concat([pcm(16000, 2000, 500), pcm(16000, 0, 800)]);
    const spokeEarly = (s: ReturnType<typeof stubServices>) => s.turn.mock.calls.map((c) => (c.arguments[2] as { spokeEarly?: boolean } | undefined)?.spokeEarly === true);

    /**
     * Greeting played, then utterance 1, whose turn is held until `release`; utterance 2 is detected while it runs,
     * so by the time turn 1 has its reply the caller has already said something newer.
     */
    async function talkPastFirstReply(first: TurnResult, rest: TurnResult[] = []) {
      const s = stubServices(rest);
      let release!: () => void;
      s.turn.mock.mockImplementationOnce(async () => {
        await new Promise<void>((r) => (release = r));
        return first;
      }, 0);
      const { transport, log } = fakeTransport(16000);
      const loop = createVoiceLoop(transport);
      await loop.start(CALL);
      await until(() => log.marks === 1, 'greeting played');
      loop.playbackFinished();
      loop.audio(UTTERANCE());
      await until(() => s.turn.mock.callCount() === 1, 'turn 1 running');
      loop.audio(UTTERANCE());
      release();
      return { s, log };
    }

    it('a reply the caller has already talked past is not spoken; their newer words go to the turn as spokeEarly', async () => {
      const info = mock.method(logger, 'info');
      const { s, log } = await talkPastFirstReply(turnResult('Which strength?'), [turnResult('Dolo 650, two strips?')]);
      await until(() => log.marks === 2, 'second reply played');
      assert.deepEqual(s.speak.mock.calls.map((c) => c.arguments[0]), ['Hello', 'Dolo 650, two strips?'], '"Which strength?" never synthesised');
      assert.deepEqual(spokeEarly(s), [false, true], 'utterance 1 began after the greeting played; utterance 2 never heard reply 1');
      const timings = info.mock.calls.filter((c) => c.arguments[0] === 'voice.turn_timing').map((c) => c.arguments[1] as { skipped?: string; ttsPieces: number });
      assert.deepEqual(timings.map((t) => [t.skipped ?? null, t.ttsPieces]), [['superseded', 0], [null, 1]]);
      assert.ok(info.mock.calls.some((c) => c.arguments[0] === 'voice.reply_superseded'));
    });

    const alwaysSpoken: Array<[string, TurnResult]> = [
      ['read-back state', turnResult('Dolo 650, two strips. Shall I place the order?', 'reading_back')],
      ['waiting for confirmation', turnResult('Shall I place the order?', 'waiting_customer_confirmation')],
      ['generate_order_readback', { ...turnResult('Dolo 650, two strips. Correct?'), toolCalls: [{ name: 'generate_order_readback', ok: true }] }],
      ['record_customer_confirmation', { ...turnResult('Thank you, the order is recorded.'), toolCalls: [{ name: 'record_customer_confirmation', ok: true }] }],
      ['handover', { ...turnResult('Connecting you to staff.', 'handover_required'), toolCalls: [{ name: 'request_human_handover', ok: true }] }],
      ['call end', turnResult('Goodbye.', 'completed', true)],
    ];
    for (const [what, first] of alwaysSpoken) {
      it(`always speaks a ${what} reply, and the caller's earlier words are not taken as an answer to it`, async () => {
        const { s, log } = await talkPastFirstReply(first);
        await until(() => s.turn.mock.callCount() === 2, 'turn 2');
        assert.equal(s.speak.mock.calls[1]?.arguments[0], speechPieces(first.reply)[0], 'reply 1 synthesised');
        assert.ok(log.marks >= 2, 'reply 1 played');
        assert.deepEqual(spokeEarly(s), [false, true], 'utterance 2 began before reply 1 started playing');
      });
    }

    for (const [what, recognise] of [
      ['recognised as nothing', async () => ({ text: '  ', confidence: null, language: null })],
      ['not recognised (STT failure)', async () => Promise.reject(new Error('stt down'))],
    ] as const) {
      it(`a talked-past reply is spoken after all when the newer utterance is ${what}`, async () => {
        mock.method(logger, 'error', () => undefined);
        const info = mock.method(logger, 'info');
        const s = stubServices();
        s.transcribe.mock.mockImplementationOnce(recognise, 1);
        let release!: () => void;
        s.turn.mock.mockImplementationOnce(async () => {
          await new Promise<void>((r) => (release = r));
          return turnResult('Which strength?');
        }, 0);
        const { transport, log } = fakeTransport(16000);
        const loop = createVoiceLoop(transport);
        await loop.start(CALL);
        await until(() => log.marks === 1, 'greeting played');
        loop.playbackFinished();
        loop.audio(UTTERANCE());
        await until(() => s.turn.mock.callCount() === 1, 'turn 1 running');
        loop.audio(UTTERANCE()); // a cough
        release();
        await until(() => log.marks === 2, 'kept reply played');
        assert.deepEqual(s.speak.mock.calls.map((c) => c.arguments[0]), ['Hello', 'Which strength?']);
        assert.equal(s.turn.mock.callCount(), 1, 'the noise starts no turn');
        assert.ok(info.mock.calls.some((c) => c.arguments[0] === 'voice.deferred_reply_spoken'));
      });
    }

    it('words begun while the greeting was still being synthesised go to the turn as spokeEarly', async () => {
      const s = stubServices();
      let releaseGreeting!: () => void;
      s.speak.mock.mockImplementationOnce(async () => {
        await new Promise<void>((r) => (releaseGreeting = r));
        return pcm(16000, 1000, 200);
      }, 0);
      const { transport, log } = fakeTransport(16000);
      const loop = createVoiceLoop(transport);
      await loop.start(CALL);
      await until(() => s.speak.mock.callCount() === 1, 'greeting synthesis started');
      loop.audio(UTTERANCE());
      releaseGreeting();
      await until(() => log.marks === 2, 'reply played');
      assert.deepEqual(spokeEarly(s), [true]);
    });
  });

  describe('after the caller hangs up', () => {
    const UTTERANCE = () => Buffer.concat([pcm(16000, 2000, 500), pcm(16000, 0, 800)]);

    /** A transport that, like rtc-node's AudioSource after close(), throws on every send once closed. */
    function closableTransport() {
      const fake = fakeTransport(16000);
      let closed = false;
      const transport: VoiceTransport<Buffer> = {
        ...fake.transport,
        send(frame) {
          if (closed) throw new Error('AudioSource is closed');
          return fake.transport.send(frame);
        },
      };
      return { transport, log: fake.log, close: () => (closed = true) };
    }

    it('a reply still being synthesised is not sent to the closed transport (no media.tts_failed)', async () => {
      const s = stubServices();
      let release!: () => void;
      s.speak.mock.mockImplementation(async (text: string) => {
        if (text !== 'Hello') await new Promise<void>((r) => (release = r));
        return pcm(16000, 1000, 200);
      });
      const errors = mock.method(logger, 'error');
      const { transport, log, close } = closableTransport();
      const loop = createVoiceLoop(transport);
      await loop.start(CALL);
      await until(() => log.marks === 1, 'greeting played');
      loop.playbackFinished();
      loop.audio(UTTERANCE());
      await until(() => s.speak.mock.callCount() === 2, 'reply synthesis started');
      await loop.end(); // the worker then closes the AudioSource
      close();
      release();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      assert.equal(log.sent, 10, 'only the greeting was sent');
      assert.equal(log.marks, 1);
      assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]), []);
    });

    it('an utterance recognised after the hang-up starts no turn, and later caller audio is ignored', async () => {
      const s = stubServices();
      let release!: () => void;
      s.transcribe.mock.mockImplementation(async () => {
        await new Promise<void>((r) => (release = r));
        return { text: 'two strips of Dolo 650', confidence: 0.9, language: 'en' as const };
      });
      const { transport } = fakeTransport(16000);
      const loop = createVoiceLoop(transport);
      await loop.start(CALL);
      loop.playbackFinished();
      loop.audio(UTTERANCE());
      await until(() => s.transcribe.mock.callCount() === 1, 'recognition started');
      await loop.end();
      release();
      loop.audio(UTTERANCE());
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      assert.equal(s.turn.mock.callCount(), 0, 'the ended session is not reopened by a turn');
      assert.equal(s.transcribe.mock.callCount(), 1);
      assert.equal(s.endSession.mock.callCount(), 1);
    });

    it('logs once what the loop heard: caller audio, voiced time, utterances, empty recognitions, turns', async () => {
      const s = stubServices();
      s.transcribe.mock.mockImplementationOnce(async () => ({ text: '  ', confidence: null, language: null }), 0);
      const info = mock.method(logger, 'info');
      const { transport, log } = fakeTransport(16000);
      const loop = createVoiceLoop(transport);
      await loop.start(CALL);
      loop.playbackFinished();
      loop.audio(UTTERANCE()); // recognised as nothing
      await until(() => s.transcribe.mock.callCount() === 1, 'first utterance');
      loop.audio(UTTERANCE()); // answered
      await until(() => log.marks === 2, 'reply played');
      await loop.end();
      await loop.end();
      const summaries = info.mock.calls.filter((c) => c.arguments[0] === 'voice.call_audio');
      assert.equal(summaries.length, 1);
      assert.deepEqual(summaries[0]!.arguments[1], { callId: CALL_ID, callerAudioMs: 2600, voicedMs: 1000, maxRms: 2000, vadThreshold: 450, utterances: 2, sttEmpty: 1, turns: 1 });
    });
  });
});
