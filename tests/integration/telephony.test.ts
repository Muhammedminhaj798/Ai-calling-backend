// Telephony pipeline with the mock provider: webhooks, the media WebSocket, VAD → STT → engine → TTS,
// disconnection and handover. Real services and database; model, speech and telephony are mocks, so this
// verifies the pipeline, NOT Exotel or Google.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import WebSocket from 'ws';
import { createApp } from '../../src/app.ts';
import { scriptedAiProvider } from '../../src/integrations/ai/mock.adapter.ts';
import { mockTelephony } from '../../src/integrations/telephony/mock.adapter.ts';
import { attachTelephonyWebSocket } from '../../src/media-server.ts';
import { mockStt, mockTts } from '../../src/modules/speech/speech.service.ts';
import { api, db, dbAvailable, disconnectDb, resetDb, skipReason, type ApiClient } from './setup.ts';

const CALLER = '+919847012345';

function speechFrame(amplitude: number): string {
  const b = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) b.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
  return b.toString('base64');
}

describe('telephony pipeline (mock provider, real engine)', { skip: dbAvailable ? false : skipReason }, () => {
  let server: http.Server;
  let baseUrl: string;
  let client: ApiClient;

  before(async () => {
    server = http.createServer(createApp());
    attachTelephonyWebSocket(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = api(baseUrl);
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await disconnectDb();
  });
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

  it('streams audio both ways: greeting out, caller utterance in via VAD and STT, reply out, clean disconnect', async () => {
    await registeredCaller();
    mockStt.enqueue('Dolo 650 twenty strips', 'en', 0.93);
    scriptedAiProvider.enqueue({ text: 'Noted, Dolo 650 twenty strips. Anything else?' });

    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/telephony/mock/mock`);
    const received: Array<Record<string, unknown>> = [];
    const waitFor = (predicate: () => boolean, ms = 60_000) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout; received ${JSON.stringify(received.map((m) => m['event']))}`)), ms);
        const check = () => {
          if (predicate()) {
            clearTimeout(t);
            resolve();
          } else setTimeout(check, 50);
        };
        check();
      });
    ws.on('message', (d) => received.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise<void>((r) => ws.once('open', () => r()));
    const send = (m: unknown) => ws.send(JSON.stringify(m));

    send({ event: 'connected' });
    send({ event: 'start', streamSid: 'S1', callSid: 'mock-call-B', from: CALLER, to: '+914842000000' });
    await waitFor(() => received.some((m) => m['event'] === 'mark'));
    const greetingFrames = received.filter((m) => m['event'] === 'media');
    assert.ok(greetingFrames.length >= 1, 'greeting audio was streamed');
    assert.equal(mockTts.spoken[0]?.language, 'ml', 'greeting synthesised in the customer language');
    send({ event: 'mark', name: (received.find((m) => m['event'] === 'mark') as { name: string }).name });
    const marksBefore = received.filter((m) => m['event'] === 'mark').length;

    for (let i = 0; i < 25; i++) send({ event: 'media', payload: speechFrame(2000) }); // 500 ms speech
    for (let i = 0; i < 40; i++) send({ event: 'media', payload: speechFrame(0) }); // 800 ms silence → utterance ends
    await waitFor(() => received.filter((m) => m['event'] === 'mark').length > marksBefore);
    assert.ok(mockStt.received.length >= 1, 'utterance sent to STT');
    assert.equal(mockStt.received.at(-1)?.language, 'ml');
    assert.ok(mockStt.received.at(-1)!.bytes >= 25 * 320);
    assert.equal(mockTts.spoken.at(-1)?.text, 'Noted, Dolo 650 twenty strips. Anything else?');

    send({ event: 'stop', reason: 'callended' });
    ws.close();
    const prisma = await db();
    let call = await prisma.call.findUnique({ where: { providerCallSid: 'mock-call-B' } });
    for (let i = 0; i < 100 && call?.endedAt === null; i++) {
      await new Promise((r) => setTimeout(r, 200));
      call = await prisma.call.findUnique({ where: { providerCallSid: 'mock-call-B' } });
    }
    assert.ok(call?.endedAt, 'session closed on stop');
    assert.equal(call?.conversationState, 'completed');
    const transcript = await prisma.transcript.findMany({ where: { callId: call!.id }, orderBy: { sequence: 'asc' } });
    assert.deepEqual(transcript.map((t) => [t.speaker, t.text]), [
      ['agent', mockTts.spoken[0]!.text],
      ['customer', 'Dolo 650 twenty strips'],
      ['agent', 'Noted, Dolo 650 twenty strips. Anything else?'],
    ]);
    assert.equal(transcript[1]?.confidence?.toString(), '0.93');
  });

  it('hands an unregistered caller to staff: handover exception, transfer attempted, call marked handed_over', async () => {
    scriptedAiProvider.enqueue({ toolCalls: [{ name: 'request_human_handover', args: { reason: 'customer_not_registered' } }] });
    mockStt.enqueue('I want to speak to someone', 'en');
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/telephony/mock/mock`);
    const received: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise<void>((r) => ws.once('open', () => r()));
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    send({ event: 'start', streamSid: 'S2', callSid: 'mock-call-C', from: '+919111111111', to: '+914842000000' });
    const until = (p: () => boolean) => new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), 60_000); const c = () => (p() ? (clearTimeout(t), resolve()) : setTimeout(c, 50)); c(); });
    await until(() => received.some((m) => m['event'] === 'mark'));
    const marks = received.filter((m) => m['event'] === 'mark').length;
    for (let i = 0; i < 25; i++) send({ event: 'media', payload: speechFrame(2000) });
    for (let i = 0; i < 40; i++) send({ event: 'media', payload: speechFrame(0) });
    await until(() => received.filter((m) => m['event'] === 'mark').length > marks);
    ws.close();

    const prisma = await db();
    let call = await prisma.call.findUnique({ where: { providerCallSid: 'mock-call-C' } });
    for (let i = 0; i < 100 && call?.status !== 'handed_over'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      call = await prisma.call.findUnique({ where: { providerCallSid: 'mock-call-C' } });
    }
    assert.equal(call?.status, 'handed_over');
    assert.equal(call?.conversationState, 'handover_required');
    assert.ok(call?.handoverReason);
    assert.equal(await prisma.exception.count({ where: { callId: call!.id, type: 'customer_not_registered' } }), 1);
    assert.deepEqual(mockTelephony.transfers.at(-1), { providerCallSid: 'mock-call-C', phoneNumber: '+919000000000' });
    assert.equal(await prisma.callEvent.count({ where: { callId: call!.id, type: 'handover_transferred' } }), 1);
  });

  it('rejects a media socket with the wrong secret', async () => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/telephony/mock/wrong-secret`);
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('rejected'));
    });
    assert.equal(outcome, 'rejected');
  });
});
