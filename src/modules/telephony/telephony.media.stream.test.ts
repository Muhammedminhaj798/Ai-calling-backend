// Exotel media stream at the wire level: real Exotel adapter, fake WebSocket, call/speech/transfer services
// replaced with in-memory stubs, so no database or provider is contacted. Pins the 8 kHz behaviour of
// attachMediaStream: greeting frames and mark, utterance cutting, the turn, barge-in, handover, closing, hang-up.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it, mock } from 'node:test';
import type { WebSocket } from 'ws';
import { createExotelTelephony } from '../../integrations/telephony/exotel.adapter.ts';
import { CLOSING_TEXT } from '../ai/ai.prompts.ts';
import type { ConversationSession, TurnResult } from '../ai/ai.types.ts';
import { callsService, type StartSessionInput } from '../calls/calls.service.ts';
import { sessionRegistry } from '../calls/session.registry.ts';
import { speechService } from '../speech/speech.service.ts';
import { speechPieces } from '../voice/voice.loop.ts';
import { attachMediaStream } from './telephony.media.ts';
import { telephonyService } from './telephony.service.ts';

const CALL_ID = 'call-1';
const SPEECH = Buffer.alloc(8000, 1); // 0.5 s at 8 kHz: two full 3200-byte Exotel chunks and one padded

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }
  provider(message: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify({ stream_sid: 'S1', ...message })));
  }
  events(): string[] {
    return this.sent.map((m) => String(m['event']));
  }
  count(event: string): number {
    return this.sent.filter((m) => m['event'] === event).length;
  }
}

function pcm(amplitude: number, frames: number): Buffer {
  const b = Buffer.alloc(frames * 320);
  for (let i = 0; i < frames * 160; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b;
}

/** Caller audio as Exotel media messages of `chunk` bytes, so frames straddle message boundaries. */
function sendAudio(ws: FakeSocket, audio: Buffer, chunk = 3000): void {
  for (let o = 0; o < audio.length; o += chunk) ws.provider({ event: 'media', media: { payload: audio.subarray(o, o + chunk).toString('base64') } });
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const turnResult = (reply: string, state: TurnResult['state'] = 'collecting_items', ended = false): TurnResult => ({ reply, language: 'en', state, toolCalls: [], ended });

function stubServices(opts: { greetingState?: TurnResult['state']; turns?: TurnResult[] } = {}) {
  const order: string[] = [];
  const turns = [...(opts.turns ?? [])];
  const startSession = mock.method(callsService, 'startSession', async (input: StartSessionInput) => {
    const session = { callId: CALL_ID, providerCallSid: input.providerCallSid, language: 'en' } as ConversationSession;
    sessionRegistry.set(session);
    return { callId: CALL_ID, session, greeting: turnResult('Hello', opts.greetingState ?? 'confirming_location'), resumed: false };
  });
  const turn = mock.method(callsService, 'turn', async () => turns.shift() ?? turnResult('Anything else?'));
  const endSession = mock.method(callsService, 'endSession', async (callId: string) => {
    sessionRegistry.delete(callId);
    return 'completed' as const;
  });
  const speak = mock.method(speechService, 'speak', async (text: string) => {
    order.push(`speak:${text}`);
    return SPEECH;
  });
  const transcribe = mock.method(speechService, 'transcribe', async () => ({ text: 'Dolo 650 twenty strips', confidence: 0.93, language: 'en' as const }));
  const transfer = mock.method(telephonyService, 'transferToStaff', async (callId: string, sid: string) => {
    order.push(`transfer:${callId}:${sid}`);
    return true;
  });
  return { order, startSession, turn, endSession, speak, transcribe, transfer };
}

function connect(): FakeSocket {
  const ws = new FakeSocket();
  attachMediaStream(ws as unknown as WebSocket, createExotelTelephony({ webhookSecret: 'x'.repeat(16), allowedIps: [] }));
  ws.provider({ event: 'connected' });
  ws.provider({ event: 'start', start: { call_sid: 'CA1', from: '+919847012345', to: '+914842000000', media_format: { sample_rate: 8000 }, custom_parameters: {} } });
  return ws;
}

describe('Exotel media stream (8 kHz)', () => {
  afterEach(() => {
    mock.restoreAll();
    sessionRegistry.delete(CALL_ID);
  });

  it('greets in 3200-byte frames plus a mark, cuts the caller utterance, answers the turn', async () => {
    const s = stubServices();
    const ws = connect();
    await until(() => ws.count('mark') === 1, 'greeting mark');

    assert.deepEqual(s.startSession.mock.calls[0]?.arguments, [{ provider: 'exotel', providerCallSid: 'CA1', fromNumber: '+919847012345', toNumber: '+914842000000' }]);
    assert.deepEqual(s.speak.mock.calls[0]?.arguments, ['Hello', 'en', 8000]);
    assert.deepEqual(ws.events(), ['media', 'media', 'media', 'mark']);
    const payloads = ws.sent.slice(0, 3).map((m) => Buffer.from(String((m['media'] as { payload: string }).payload), 'base64'));
    assert.deepEqual(payloads.map((p) => p.length), [3200, 3200, 3200]);
    assert.ok(ws.sent.every((m) => m['stream_sid'] === 'S1'));
    assert.deepEqual(payloads[2], Buffer.concat([Buffer.alloc(1600, 1), Buffer.alloc(1600)]), 'last chunk padded with silence');
    assert.match(String((ws.sent[3]!['mark'] as { name: string }).name), /^end-\d+$/);

    ws.provider({ event: 'mark', mark: { name: 'played' } });
    sendAudio(ws, Buffer.concat([pcm(2000, 25), pcm(0, 40)])); // 500 ms speech, 800 ms silence
    await until(() => ws.count('mark') === 2, 'reply mark');

    assert.equal(s.transcribe.mock.callCount(), 1);
    const [audio, language, rate] = s.transcribe.mock.calls[0]!.arguments;
    assert.deepEqual([audio?.length, language, rate], [(25 + 35) * 320, 'en', 8000], 'utterance ends after 700 ms of silence');
    assert.deepEqual(s.turn.mock.calls[0]?.arguments, [CALL_ID, 'Dolo 650 twenty strips', { confidence: 0.93 }]);
    assert.deepEqual(s.order, ['speak:Hello', 'speak:Anything else?']);
    assert.equal(ws.count('clear'), 0, 'no barge-in once the provider reported playback finished');
  });

  it('barge-in sends one clear while agent audio is playing; the provider mark ends playback', async () => {
    stubServices();
    const ws = connect();
    await until(() => ws.count('mark') === 1, 'greeting mark');

    sendAudio(ws, pcm(2000, 1));
    assert.deepEqual(ws.sent.at(-1), { event: 'clear', stream_sid: 'S1' });
    sendAudio(ws, pcm(2000, 1));
    assert.equal(ws.count('clear'), 1, 'only the first voiced frame interrupts');
  });

  it('a mark before any loud audio means no clear is sent', async () => {
    stubServices();
    const ws = connect();
    await until(() => ws.count('mark') === 1, 'greeting mark');
    ws.provider({ event: 'mark', mark: { name: 'played' } });
    sendAudio(ws, pcm(2000, 3));
    assert.equal(ws.count('clear'), 0);
  });

  it('transfers to staff after speaking the handover reply', async () => {
    const s = stubServices({ turns: [turnResult('Connecting you to staff', 'handover_required', true)] });
    const ws = connect();
    await until(() => ws.count('mark') === 1, 'greeting mark');
    ws.provider({ event: 'mark', mark: { name: 'played' } });
    sendAudio(ws, Buffer.concat([pcm(2000, 25), pcm(0, 40)]));
    await until(() => s.transfer.mock.callCount() === 1, 'transfer');
    assert.deepEqual(s.order, ['speak:Hello', 'speak:Connecting you to staff', `transfer:${CALL_ID}:CA1`]);
  });

  it('transfers straight after the greeting when the greeting already requires handover', async () => {
    const s = stubServices({ greetingState: 'handover_required' });
    connect();
    await until(() => s.transfer.mock.callCount() === 1, 'transfer');
    assert.deepEqual(s.order, ['speak:Hello', `transfer:${CALL_ID}:CA1`]);
  });

  it('plays the closing line after the reply when the conversation completes', async () => {
    const s = stubServices({ turns: [turnResult('Order placed', 'completed', true)] });
    const ws = connect();
    await until(() => ws.count('mark') === 1, 'greeting mark');
    ws.provider({ event: 'mark', mark: { name: 'played' } });
    sendAudio(ws, Buffer.concat([pcm(2000, 25), pcm(0, 40)]));
    await until(() => ws.count('mark') === 3, 'closing mark');
    // replies are synthesised sentence by sentence (voice.loop.ts speechPieces)
    assert.deepEqual(s.order, ['speak:Hello', 'speak:Order placed', ...speechPieces(CLOSING_TEXT.en).map((p) => `speak:${p}`)]);
    assert.equal(speechPieces(CLOSING_TEXT.en).length, 3);
    assert.equal(s.transfer.mock.callCount(), 0);
  });

  it('stop ends the session once; nothing is sent afterwards and a later close does not end it again', async () => {
    const s = stubServices();
    const ws = connect();
    await until(() => ws.count('mark') === 1, 'greeting mark');
    const sentBefore = ws.sent.length;
    ws.provider({ event: 'stop', stop: { reason: 'callended' } });
    await until(() => s.endSession.mock.callCount() === 1, 'endSession');
    assert.deepEqual(s.endSession.mock.calls[0]?.arguments, [CALL_ID, 'caller_hangup']);
    sendAudio(ws, pcm(2000, 3));
    ws.emit('close');
    await new Promise((r) => setImmediate(r));
    assert.equal(s.endSession.mock.callCount(), 1);
    assert.equal(ws.sent.length, sentBefore);
  });

  it('a socket closed without stop still ends the session', async () => {
    const s = stubServices();
    const ws = connect();
    await until(() => ws.count('mark') === 1, 'greeting mark');
    ws.emit('close');
    await until(() => s.endSession.mock.callCount() === 1, 'endSession');
  });

  it('logs and skips the turn when speech recognition fails or hears nothing', async () => {
    const s = stubServices();
    const ws = connect();
    await until(() => ws.count('mark') === 1, 'greeting mark');
    ws.provider({ event: 'mark', mark: { name: 'played' } });
    s.transcribe.mock.mockImplementationOnce(async () => {
      throw new Error('stt down');
    });
    s.transcribe.mock.mockImplementationOnce(async () => ({ text: '  ', confidence: null, language: null }), 1);
    sendAudio(ws, Buffer.concat([pcm(2000, 25), pcm(0, 40), pcm(2000, 25), pcm(0, 40)]));
    await until(() => s.transcribe.mock.callCount() === 2, 'two utterances');
    await new Promise((r) => setImmediate(r));
    assert.equal(s.turn.mock.callCount(), 0);
  });
});
