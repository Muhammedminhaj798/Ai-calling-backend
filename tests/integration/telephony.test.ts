// Telephony pipeline with the mock provider: webhooks, the media WebSocket, VAD → STT → engine → TTS,
// disconnection and handover. Real services and database; model, speech and telephony are mocks, so this
// verifies the pipeline, NOT Exotel or Google.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it, type TestContext } from 'node:test';
import WebSocket, { type WebSocketServer } from 'ws';
import { createApp } from '../../src/app.ts';
import { scriptedAiProvider } from '../../src/integrations/ai/mock.adapter.ts';
import { mockTelephony } from '../../src/integrations/telephony/mock.adapter.ts';
import { attachTelephonyWebSocket } from '../../src/media-server.ts';
import { mockStt, mockTts } from '../../src/modules/speech/speech.service.ts';
import { api, db, dbAvailable, disconnectDb, resetDb, skipReason, type ApiClient } from './setup.ts';

const CALLER = '+919847012345';
const FRAME_BYTES = 320; // 20 ms of 8 kHz 16-bit mono

/**
 * How long each stage may take before the test fails naming it. The test database is a remote Neon branch, so the
 * stages that write to it (opening the session, the conversation turn, closing the call) get the most time.
 */
const LIMIT_MS = {
  connection: 10_000, // WebSocket upgrade accepted
  greetingAudio: 30_000, // session opened in the database, greeting synthesised, first frame sent
  greetingAck: 10_000, // greeting fully streamed: the mark the caller side acknowledges
  vad: 10_000, // trailing silence ends the utterance and it is handed to STT
  stt: 10_000, // transcript handed to the conversation engine (model request)
  aiResponse: 30_000, // conversation turn (database, scripted model) answered
  ttsAudio: 15_000, // reply synthesised, streamed and marked
  sessionCleanup: 30_000, // call closed in the database after stop
} as const;
/** Backstop per test, above the sum of its stage limits: a test never hangs the file. */
const TEST_TIMEOUT_MS = 180_000;

function speechFrame(amplitude: number): string {
  const b = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b.toString('base64');
}

/** Polls `probe` (in-process state or the database) until `ok`; fails after `ms` naming the stage. Never outlives `ms`. */
async function eventually<T>(stage: string, probe: () => T | Promise<T>, ok: (value: T) => boolean, ms: number, everyMs = 20): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (ok(value)) return value;
    if (Date.now() >= deadline) throw new Error(`${stage}: not reached within ${ms} ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

type MediaEvent = Record<string, unknown> & { event?: string };

/**
 * A caller-side media socket for one test. Waits on its messages as they arrive (no polling), fails fast when
 * the socket closes, and remembers the stage reached so a failure says where the pipeline stopped.
 */
function mediaSocket(url: string) {
  const ws = new WebSocket(url);
  const received: MediaEvent[] = [];
  const listeners = new Set<() => void>();
  const notify = () => [...listeners].forEach((l) => l());
  ws.on('message', (d) => {
    received.push(JSON.parse(d.toString()) as MediaEvent);
    notify();
  });
  ws.on('close', notify);
  ws.on('error', notify); // also keeps a socket error from becoming an uncaught exception

  const media = {
    ws,
    received,
    stage: 'connection',
    /** The events received so far, runs collapsed: "media×3, mark, media×2, mark". Payloads are left out. */
    summary(): string {
      const runs: Array<[string, number]> = [];
      for (const m of received) {
        const name = String(m.event);
        const last = runs.at(-1);
        if (last && last[0] === name) last[1]++;
        else runs.push([name, 1]);
      }
      return runs.map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ') || 'none';
    },
    count: (event: string) => received.filter((m) => m.event === event).length,
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    /** Resolves once the socket is open; rejects if it is refused, closes or takes longer than the limit. */
    open(): Promise<void> {
      return media.until(LIMIT_MS.connection, () => ws.readyState === WebSocket.OPEN);
    },
    /** Resolves when `predicate` holds, checked now and on every message; rejects on close or after `ms`. */
    until(ms: number, predicate: () => boolean): Promise<void> {
      const stage = media.stage;
      return new Promise<void>((resolve, reject) => {
        const settle = (outcome: Error | null) => {
          clearTimeout(timer);
          listeners.delete(check);
          ws.off('open', check);
          if (outcome) reject(outcome);
          else resolve();
        };
        const check = () => {
          if (predicate()) settle(null);
          else if (ws.readyState === WebSocket.CLOSED) settle(new Error(`${stage}: media socket closed first; events received: ${media.summary()}`));
        };
        const timer = setTimeout(() => settle(new Error(`${stage}: timed out after ${ms} ms; events received: ${media.summary()}`)), ms);
        listeners.add(check);
        ws.on('open', check);
        check();
      });
    },
  };
  return media;
}
type MediaSocket = ReturnType<typeof mediaSocket>;

describe('telephony pipeline (mock provider, real engine)', { skip: dbAvailable ? false : skipReason }, () => {
  let server: http.Server | undefined;
  let wss: WebSocketServer | undefined;
  let baseUrl: string;
  let client: ApiClient;

  before(async () => {
    server = http.createServer(createApp());
    wss = attachTelephonyWebSocket(server);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = api(baseUrl);
  });
  after(async () => {
    try {
      // server.close() waits for every connection, upgraded media sockets included: one left open by a failed
      // test would keep this hook, and the process, waiting forever.
      for (const socket of wss?.clients ?? []) socket.terminate();
      if (server) await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
    } finally {
      await disconnectDb();
    }
  });

  /**
   * Runs one media-socket test. On failure it reports the stage reached and the events received, then fails with
   * the original error (expected/actual and stack intact). The socket is always closed, pass or fail.
   */
  async function withMediaSocket(t: TestContext, body: (media: MediaSocket) => Promise<void>, secret = 'mock'): Promise<void> {
    const media = mediaSocket(`${baseUrl.replace('http', 'ws')}/ws/telephony/mock/${secret}`);
    try {
      await body(media);
    } catch (err) {
      t.diagnostic(`telephony stage: ${media.stage}`);
      t.diagnostic(`media events received: ${media.summary()}`);
      throw err;
    } finally {
      media.ws.terminate();
    }
  }
  beforeEach(async () => {
    await resetDb();
    scriptedAiProvider.clear();
    mockTelephony.transfers.length = 0;
    mockTts.spoken.length = 0;
  });

  async function registeredCaller() {
    const prisma = await db();
    return prisma.customer.create({ data: { externalCode: 'C-TEL-1', name: 'Sample Medicals', phonePrimary: CALLER, preferredLanguage: 'ml', status: 'active' } });
  }

  it('incoming and status webhooks create and close a session; wrong provider or path is rejected', async () => {
    await registeredCaller();
    const incoming = await client.post('/webhooks/telephony/mock/mock/incoming', { callSid: 'mock-call-A', from: CALLER, to: '+914842000000' });
    assert.equal(incoming.status, 200, incoming.text);
    assert.equal(incoming.body.conversationState, 'confirming_location');
    const callId = incoming.body.callId as string;

    const replay = await client.post('/webhooks/telephony/mock/mock/incoming', { callSid: 'mock-call-A', from: CALLER, to: '+914842000000' });
    assert.equal(replay.body.callId, callId, 'the same provider call id resumes the session');

    assert.equal((await client.post('/webhooks/telephony/exotel/mock/incoming', { callSid: 'x' })).status, 404);

    const status = await client.post('/webhooks/telephony/mock/mock/status', { callSid: 'mock-call-A', status: 'completed', duration: 42, recordingUrl: 'https://example.invalid/rec.mp3' });
    assert.equal(status.status, 200, status.text);
    assert.deepEqual(status.body, { callId, ended: true });
    const prisma = await db();
    const call = await prisma.call.findUnique({ where: { id: callId } });
    assert.equal(call?.durationSeconds, 42);
    assert.equal(call?.recordingUrl, 'https://example.invalid/rec.mp3');
    assert.equal(call?.conversationState, 'completed');
    assert.ok(call?.endedAt);
  });

  it('streams audio both ways: greeting out, caller utterance in via VAD and STT, reply out, clean disconnect', { timeout: TEST_TIMEOUT_MS }, (t) =>
    withMediaSocket(t, async (media) => {
      const REPLY = 'Noted, Dolo 650 twenty strips. Anything else?';
      // The voice loop speaks a reply sentence by sentence (voice.loop.ts speechPieces), so the first audio goes
      // out before the whole reply is synthesised: the synthesiser gets these two pieces, in this order.
      const REPLY_PIECES = ['Noted, Dolo 650 twenty strips.', 'Anything else?'];
      await registeredCaller();
      mockStt.enqueue('Dolo 650 twenty strips', 'en', 0.93);
      scriptedAiProvider.enqueue({ text: REPLY });

      await media.open();

      media.stage = 'greeting audio';
      media.send({ event: 'connected' });
      media.send({ event: 'start', streamSid: 'S1', callSid: 'mock-call-B', from: CALLER, to: '+914842000000' });
      await media.until(LIMIT_MS.greetingAudio, () => media.count('media') >= 1);

      media.stage = 'greeting acknowledgement';
      await media.until(LIMIT_MS.greetingAck, () => media.count('mark') >= 1);
      const greetingSpoken = mockTts.spoken.slice(); // everything synthesised so far is the greeting
      const greetingFrames = media.received.filter((m) => m.event === 'media');
      assert.ok(greetingSpoken.length >= 1, 'greeting synthesised');
      assert.ok(greetingSpoken.every((s) => s.language === 'ml'), 'greeting synthesised in the customer language');
      assert.equal(greetingFrames.length, greetingSpoken.length, 'one media frame per synthesised greeting piece');
      assert.ok(greetingFrames.every((m) => m['streamSid'] === 'S1' && String(m['payload']).length > 0), 'greeting frames carry audio on the stream');
      const greetingMark = media.received.find((m) => m.event === 'mark')!;
      assert.equal(greetingMark['streamSid'], 'S1');
      // The caller side has played the greeting: without this acknowledgement the caller's speech below would count
      // as barge-in and the server would send `clear`.
      media.send({ event: 'mark', name: greetingMark['name'] });
      const eventsBeforeReply = media.received.length;
      const sttBefore = mockStt.received.length; // the shared mock is not reset between tests

      media.stage = 'VAD completion';
      for (let i = 0; i < 25; i++) media.send({ event: 'media', payload: speechFrame(2000) }); // 500 ms speech
      for (let i = 0; i < 40; i++) media.send({ event: 'media', payload: speechFrame(0) }); // 800 ms silence → utterance ends
      const [heard] = await eventually(media.stage, () => mockStt.received.slice(sttBefore), (r) => r.length >= 1, LIMIT_MS.vad);
      assert.equal(mockStt.received.length - sttBefore, 1, 'exactly one utterance sent to STT');
      assert.equal(heard!.language, 'ml', 'recognised in the session language');
      assert.ok(heard!.bytes >= 25 * FRAME_BYTES, `the whole utterance reaches STT (got ${heard!.bytes} bytes)`);
      assert.ok(heard!.bytes <= 65 * FRAME_BYTES && heard!.bytes % FRAME_BYTES === 0, `whole 20 ms frames, no more than was sent (got ${heard!.bytes} bytes)`);

      media.stage = 'STT processing';
      const request = await eventually(media.stage, () => scriptedAiProvider.requests.at(-1), (r) => JSON.stringify(r?.messages ?? []).includes('Dolo 650 twenty strips'), LIMIT_MS.stt);
      assert.ok(request, 'the transcript reached the conversation engine');

      media.stage = 'AI response';
      await eventually(media.stage, () => scriptedAiProvider.pending, (n) => n === 0, LIMIT_MS.aiResponse);

      media.stage = 'TTS audio';
      await media.until(LIMIT_MS.ttsAudio, () => media.count('mark') >= 2);
      const replySpoken = mockTts.spoken.slice(greetingSpoken.length);
      assert.deepEqual(replySpoken.map((s) => s.text), REPLY_PIECES, 'the whole reply synthesised, in order');
      assert.equal(replySpoken.map((s) => s.text).join(' '), REPLY);
      assert.ok(replySpoken.every((s) => s.language === 'ml'), 'reply synthesised in the session language');
      const replyEvents = media.received.slice(eventsBeforeReply);
      assert.deepEqual(replyEvents.map((m) => m.event), [...REPLY_PIECES.map(() => 'media'), 'mark'], 'reply streamed piece by piece, then marked; no barge-in clear');
      assert.ok(replyEvents.every((m) => m['streamSid'] === 'S1'));

      media.stage = 'session cleanup';
      media.send({ event: 'stop', reason: 'callended' });
      media.ws.close();
      const prisma = await db();
      const call = await eventually(media.stage, () => prisma.call.findUnique({ where: { providerCallSid: 'mock-call-B' } }), (c) => Boolean(c?.endedAt), LIMIT_MS.sessionCleanup, 200);
      assert.equal(call?.conversationState, 'completed');
      const transcript = await prisma.transcript.findMany({ where: { callId: call!.id }, orderBy: { sequence: 'asc' } });
      assert.deepEqual(transcript.map((row) => [row.speaker, row.text]), [
        ['agent', greetingSpoken.map((s) => s.text).join(' ')],
        ['customer', 'Dolo 650 twenty strips'],
        ['agent', REPLY],
      ]);
      assert.equal(transcript[1]?.confidence?.toString(), '0.93');
    }));

  it('hands an unregistered caller to staff: handover exception, transfer attempted, call marked handed_over', { timeout: TEST_TIMEOUT_MS }, (t) =>
    withMediaSocket(t, async (media) => {
      scriptedAiProvider.enqueue({ toolCalls: [{ name: 'request_human_handover', args: { reason: 'customer_not_registered' } }] });
      mockStt.enqueue('I want to speak to someone', 'en');
      await media.open();

      media.stage = 'greeting acknowledgement';
      media.send({ event: 'start', streamSid: 'S2', callSid: 'mock-call-C', from: '+919111111111', to: '+914842000000' });
      await media.until(LIMIT_MS.greetingAudio + LIMIT_MS.greetingAck, () => media.count('mark') >= 1);
      const marks = media.count('mark');

      media.stage = 'reply after the caller utterance (VAD, STT, AI, TTS)';
      for (let i = 0; i < 25; i++) media.send({ event: 'media', payload: speechFrame(2000) });
      for (let i = 0; i < 40; i++) media.send({ event: 'media', payload: speechFrame(0) });
      await media.until(LIMIT_MS.vad + LIMIT_MS.stt + LIMIT_MS.aiResponse + LIMIT_MS.ttsAudio, () => media.count('mark') > marks);
      media.ws.close();

      media.stage = 'handover recorded';
      const prisma = await db();
      const call = await eventually(media.stage, () => prisma.call.findUnique({ where: { providerCallSid: 'mock-call-C' } }), (c) => c?.status === 'handed_over', LIMIT_MS.sessionCleanup, 200);
      assert.equal(call?.status, 'handed_over');
      assert.equal(call?.conversationState, 'handover_required');
      assert.ok(call?.handoverReason);
      assert.equal(await prisma.exception.count({ where: { callId: call!.id, type: 'customer_not_registered' } }), 1);
      assert.deepEqual(mockTelephony.transfers.at(-1), { providerCallSid: 'mock-call-C', phoneNumber: '+919000000000' });
      assert.equal(await prisma.callEvent.count({ where: { callId: call!.id, type: 'handover_transferred' } }), 1);
    }));

  it('rejects a media socket with the wrong secret', { timeout: TEST_TIMEOUT_MS }, (t) =>
    withMediaSocket(
      t,
      async (media) => {
        await assert.rejects(media.open(), /connection: media socket closed first/, 'the upgrade is refused');
        assert.notEqual(media.ws.readyState, WebSocket.OPEN);
      },
      'wrong-secret',
    ));
});
