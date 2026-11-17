// The voice worker's per-call logic with fakes for the room audio, the call service and speech: job
// authorisation, 16 kHz caller audio in, agent audio out, caller disconnect, idle timeout, duplicate jobs,
// start failures and handover. No LiveKit connection and no database.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import type { CallerAudioFrame } from '../../integrations/livekit/livekit.transport.ts';
import type { ConversationSession, TurnResult } from '../ai/ai.types.ts';
import { callsRepository } from '../calls/calls.repository.ts';
import { callsService, type StartSessionInput } from '../calls/calls.service.ts';
import { sessionRegistry } from '../calls/session.registry.ts';
import { speechService } from '../speech/speech.service.ts';
import { runLiveKitCall } from './livekit.call.ts';
import { parseVoiceJob, type VoiceJob } from './voice.validation.ts';

const ROOM = 'call-0b6e4c1e-2f4a-4c55-9d1e-7a3b5c2d1e0f';
const IDENTITY = 'staff-5f0c9a7e-1d2b-4c3d-8e4f-a1b2c3d4e5f6-0a1b2c3d';
const JOB: VoiceJob = { fromNumber: '+919847012345', language: 'ml', participantIdentity: IDENTITY };
const CALL_ID = 'call-db-id';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** An async iterable fed by the test, standing in for rtc-node's AudioStream. */
function channel<T>() {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(...values: T[]) {
      items.push(...values);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        if (items.length > 0) yield items.shift()!;
        else if (closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

const frames = (amplitude: number, count: number, sampleRate = 16000): CallerAudioFrame[] =>
  Array.from({ length: count }, () => {
    const data = new Int16Array(sampleRate / 50);
    for (let i = 0; i < data.length; i++) data[i] = i % 2 === 0 ? amplitude : -amplitude;
    return { data, sampleRate, channels: 1 };
  });

const turnResult = (reply: string, state: TurnResult['state'] = 'collecting_items', ended = false): TurnResult => ({ reply, language: 'ml', state, toolCalls: [], ended });

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function setup(opts: { existingCall?: boolean; startError?: unknown; turns?: TurnResult[]; lastActivityAt?: number } = {}) {
  const turns = [...(opts.turns ?? [])];
  const findByProviderSid = mock.method(callsRepository, 'findByProviderSid', async () => (opts.existingCall ? ({ id: 'other' } as never) : null));
  const addEvent = mock.method(callsRepository, 'addEvent', async () => ({}) as never);
  const startSession = mock.method(callsService, 'startSession', async (input: StartSessionInput) => {
    if (opts.startError) throw opts.startError;
    const session = { callId: CALL_ID, providerCallSid: input.providerCallSid, language: 'ml', lastActivityAt: opts.lastActivityAt ?? Date.now() } as ConversationSession;
    sessionRegistry.set(session);
    return { callId: CALL_ID, session, greeting: turnResult('Namaskaram'), resumed: false };
  });
  const turn = mock.method(callsService, 'turn', async () => turns.shift() ?? turnResult('Mattenthenkilum?'));
  const endSession = mock.method(callsService, 'endSession', async (callId: string) => {
    sessionRegistry.delete(callId);
    return 'completed' as const;
  });
  const speak = mock.method(speechService, 'speak', async () => Buffer.alloc(16000 * 2 * 0.1)); // 100 ms
  const transcribe = mock.method(speechService, 'transcribe', async () => ({ text: 'Dolo 650 randu strip', confidence: 0.91, language: 'ml' as const }));

  const captured: Int16Array[] = [];
  const caller = channel<CallerAudioFrame>();
  const ended = deferred();
  const io = {
    output: { capture: async (s: Int16Array) => void captured.push(s), clearQueue: () => undefined, waitForPlayout: async () => undefined },
    callerAudio: caller,
    ended: ended.promise,
  };
  return { io, caller, ended, captured, findByProviderSid, addEvent, startSession, turn, endSession, speak, transcribe };
}

describe('LiveKit call in the voice worker', () => {
  afterEach(() => {
    mock.restoreAll();
    sessionRegistry.delete(CALL_ID);
  });

  it('opens a livekit session, hears the caller at 16 kHz, answers through the agent track, ends on hang-up', async () => {
    const s = setup();
    const run = runLiveKitCall(ROOM, JOB, s.io);
    await until(() => s.captured.length === 5, 'greeting captured');
    assert.deepEqual(s.startSession.mock.calls[0]?.arguments, [{ provider: 'livekit', providerCallSid: ROOM, fromNumber: '+919847012345', toNumber: 'browser', language: 'ml' }]);
    assert.equal(s.speak.mock.calls[0]?.arguments[2], 16000);

    s.caller.push(...frames(2000, 25), ...frames(0, 40)); // 500 ms speech, 800 ms silence
    await until(() => s.captured.length === 10, 'reply captured');
    const [audio, language, rate] = s.transcribe.mock.calls[0]!.arguments;
    assert.deepEqual([audio?.length, language, rate], [(25 + 35) * 640, 'ml', 16000]);
    assert.deepEqual(s.turn.mock.calls[0]?.arguments, [CALL_ID, 'Dolo 650 randu strip', { confidence: 0.91 }]);

    s.ended.resolve(); // the browser left
    assert.equal(await run, 'ended');
    assert.equal(s.endSession.mock.callCount(), 1);
    assert.deepEqual(s.endSession.mock.calls[0]?.arguments, [CALL_ID, 'caller_hangup'], 'a hang-up, never a confirmation');
    s.caller.close();
  });

  it('ends an idle call with idle_timeout', async () => {
    const s = setup({ lastActivityAt: Date.now() - 60_000 });
    assert.equal(await runLiveKitCall(ROOM, JOB, s.io, { idleMs: 1000, idleCheckMs: 5 }), 'ended');
    assert.deepEqual(s.endSession.mock.calls[0]?.arguments, [CALL_ID, 'idle_timeout']);
  });

  it('a job for a room that already has a call does not start or end anything', async () => {
    const s = setup({ existingCall: true });
    assert.equal(await runLiveKitCall(ROOM, JOB, s.io), 'duplicate');
    assert.deepEqual(s.findByProviderSid.mock.calls[0]?.arguments, [ROOM]);
    assert.equal(s.startSession.mock.callCount(), 0);
    assert.equal(s.endSession.mock.callCount(), 0);
    assert.equal(s.captured.length, 0);
  });

  it('a job that loses the race for the unique call row is a duplicate, not a failure', async () => {
    const s = setup({ startError: Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }) });
    assert.equal(await runLiveKitCall(ROOM, JOB, s.io), 'duplicate');
    assert.equal(s.endSession.mock.callCount(), 0);
  });

  it('a failure while the call is running still ends the session (provider_error), so the call gets its end time', async () => {
    const s = setup();
    const ended = Promise.reject(new Error('room lost'));
    ended.catch(() => undefined);
    await assert.rejects(runLiveKitCall(ROOM, JOB, { ...s.io, ended }), /room lost/);
    assert.deepEqual(s.endSession.mock.calls.map((c) => c.arguments), [[CALL_ID, 'provider_error']]);
  });

  it('a second end (worker shutdown after the hang-up) does not end the session again', async () => {
    const s = setup();
    const run = runLiveKitCall(ROOM, JOB, s.io);
    s.ended.resolve();
    assert.equal(await run, 'ended');
    s.ended.resolve(); // shutdown callback resolves the same signal again
    assert.equal(s.endSession.mock.callCount(), 1);
  });

  it('any other start failure is thrown to the worker, which logs it and deletes the room', async () => {
    const s = setup({ startError: new Error('database unavailable') });
    await assert.rejects(runLiveKitCall(ROOM, JOB, s.io), /database unavailable/);
    assert.equal(s.endSession.mock.callCount(), 0);
  });

  it('handover: speaks the reply, then records that no transfer was possible', async () => {
    const s = setup({ turns: [turnResult('Staff-ine bandhippikkam', 'handover_required', true)] });
    const run = runLiveKitCall(ROOM, JOB, s.io);
    await until(() => s.captured.length === 5, 'greeting');
    s.caller.push(...frames(2000, 25), ...frames(0, 40));
    await until(() => s.addEvent.mock.callCount() === 1, 'handover event');
    assert.equal(s.captured.length, 10, 'handover reply spoken first');
    const event = s.addEvent.mock.calls[0]!.arguments[0] as { callId: string; type: string; ok: boolean };
    assert.deepEqual([event.callId, event.type, event.ok], [CALL_ID, 'handover_transfer_skipped', false]);
    s.ended.resolve();
    await run;
  });

  it('drops caller audio that is not 16 kHz mono instead of feeding it to the detector', async () => {
    const s = setup();
    const run = runLiveKitCall(ROOM, JOB, s.io);
    await until(() => s.captured.length === 5, 'greeting');
    s.caller.push(...frames(2000, 25, 48000), ...frames(0, 40, 48000));
    s.caller.push(...frames(0, 1)); // a valid frame, to know the 48 kHz ones were consumed
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.transcribe.mock.callCount(), 0);
    s.ended.resolve();
    await run;
  });
});

describe('dispatched job validation (worker side)', () => {
  const metadata = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...JOB, ...overrides });

  it('accepts a job the API created', () => {
    const parsed = parseVoiceJob(ROOM, metadata({ extra: 'ignored' }));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.job, JOB);
    assert.equal(parsed.roomName, ROOM);
  });

  it('rejects other rooms and malformed or incomplete metadata, without echoing values', () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, metadata()],
      ['some-other-room', metadata()],
      [`${ROOM}-x`, metadata()],
      [ROOM, undefined],
      [ROOM, 'not json'],
      [ROOM, metadata({ participantIdentity: 'agent-123' })],
      [ROOM, metadata({ fromNumber: 'abc' })],
      [ROOM, metadata({ language: 'fr' })],
      [ROOM, JSON.stringify({ fromNumber: JOB.fromNumber })],
    ];
    for (const [room, meta] of cases) {
      const parsed = parseVoiceJob(room, meta);
      assert.equal(parsed.ok, false, `${room} ${meta}`);
      assert.doesNotMatch((parsed as { reason: string }).reason, /9847012345|abc|agent-123/);
    }
  });
});
