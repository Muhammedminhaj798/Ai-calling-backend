// API side of LiveKit calls: the join token's grants, room and dispatch, cleanup on failure, the route's
// authentication, validation and rate limit, and the guard that keeps the API out of worker-owned sessions.
// LiveKit server calls and the audit write are fakes; no LiveKit connection, no database.
import '../../../tests/env.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it, mock } from 'node:test';
import { jwtVerify } from 'jose';

// Placeholder LiveKit settings, set before env.ts is loaded (.env never overrides them).
const SECRET = 'unit-test-livekit-secret-0123456789abcdef';
process.env['LIVEKIT_ENABLED'] = 'true';
process.env['LIVEKIT_URL'] = 'wss://unit-test.livekit.invalid';
process.env['LIVEKIT_API_KEY'] = 'APIunittest';
process.env['LIVEKIT_API_SECRET'] = SECRET;
process.env['LIVEKIT_AGENT_NAME'] = 'pharmacy-voice-test';

const { env } = await import('../../config/env.ts');
const { createApp } = await import('../../app.ts');
const { signAccessToken } = await import('../auth/auth.tokens.ts');
const { callsRepository } = await import('../calls/calls.repository.ts');
const { callsService } = await import('../calls/calls.service.ts');
const { createVoiceService, voiceService } = await import('./voice.service.ts');
const { parseVoiceJob } = await import('./voice.validation.ts');
type LiveKitServer = import('./voice.service.ts').LiveKitServer;

const USER = { id: '5f0c9a7e-1d2b-4c3d-8e4f-a1b2c3d4e5f6', role: 'staff' as const };
const META = { ip: '127.0.0.1', requestId: 'req-1' };

function fakeServer(fail?: 'room' | 'dispatch') {
  const calls = { createRoom: [] as unknown[], createDispatch: [] as unknown[][], deleteRoom: [] as string[] };
  const server: LiveKitServer = {
    room: {
      async createRoom(options) {
        calls.createRoom.push(options);
        if (fail === 'room') throw new Error('twirp error unavailable');
      },
      async deleteRoom(name) {
        calls.deleteRoom.push(name);
      },
    },
    agentDispatch: {
      async createDispatch(...args) {
        calls.createDispatch.push(args);
        if (fail === 'dispatch') throw new Error('twirp error unavailable');
      },
    },
  };
  return { server, calls };
}

describe('voice session (token, room, dispatch)', () => {
  it('creates a two-seat room, dispatches the worker with validated metadata and returns a microphone-only token', async () => {
    const { server, calls } = fakeServer();
    const audit = mock.fn(async () => undefined);
    const session = await createVoiceService({ server: () => server, audit }).startSession(USER, { fromNumber: '+919847012345', language: 'ml' }, META);

    assert.match(session.roomName, /^call-[0-9a-f-]{36}$/);
    assert.match(session.participantIdentity, new RegExp(`^staff-${USER.id}-[0-9a-f]{8}$`));
    assert.equal(session.serverUrl, 'wss://unit-test.livekit.invalid');
    assert.equal(session.expiresInSeconds, 300);
    assert.deepEqual(calls.createRoom, [{ name: session.roomName, emptyTimeout: 300, departureTimeout: 20, maxParticipants: 2 }]);

    const [room, agentName, options] = calls.createDispatch[0] as [string, string, { metadata: string; restartPolicy: number }];
    assert.deepEqual([room, agentName, options.restartPolicy], [session.roomName, 'pharmacy-voice-test', 1 /* JRP_NEVER */]);
    const job = parseVoiceJob(room, options.metadata);
    assert.ok(job.ok, 'the worker accepts what the API dispatches');
    assert.deepEqual(job.job, { fromNumber: '+919847012345', language: 'ml', participantIdentity: session.participantIdentity });

    const { payload } = await jwtVerify(session.participantToken, new TextEncoder().encode(SECRET));
    assert.equal(payload.iss, 'APIunittest');
    assert.equal(payload.sub, session.participantIdentity);
    assert.equal(payload.exp! - payload.nbf!, 300);
    assert.deepEqual(payload['video'], {
      roomJoin: true,
      room: session.roomName,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    }, 'exactly these grants: no room create, list, admin, record or agent rights');
    assert.doesNotMatch(JSON.stringify(session), new RegExp(SECRET));

    const entry = (audit.mock.calls[0]!.arguments as unknown[])[0] as Record<string, unknown>;
    assert.deepEqual([entry['actorId'], entry['action'], entry['entityId']], [USER.id, 'voice_session.create', session.roomName.slice('call-'.length)]);
    assert.doesNotMatch(JSON.stringify(entry), /9847012345/, 'no customer phone number in the audit entry');
  });

  it('each session gets its own room and participant identity', async () => {
    const { server } = fakeServer();
    const service = createVoiceService({ server: () => server, audit: async () => undefined });
    const a = await service.startSession(USER, { fromNumber: '+919847012345' }, META);
    const b = await service.startSession(USER, { fromNumber: '+919847012345' }, META);
    assert.notEqual(a.roomName, b.roomName);
    assert.notEqual(a.participantIdentity, b.participantIdentity);
  });

  for (const fail of ['room', 'dispatch'] as const) {
    it(`when the ${fail} call fails: deletes the room, answers 502, writes no audit entry`, async () => {
      const { server, calls } = fakeServer(fail);
      const audit = mock.fn(async () => undefined);
      await assert.rejects(createVoiceService({ server: () => server, audit }).startSession(USER, { fromNumber: '+919847012345' }, META), { status: 502, code: 'LIVEKIT_UNAVAILABLE' });
      assert.equal(calls.deleteRoom.length, 1);
      assert.equal(audit.mock.callCount(), 0);
    });
  }

  it('is a 404 without touching LiveKit when LIVEKIT_ENABLED is false', async () => {
    const { server, calls } = fakeServer();
    (env as { LIVEKIT_ENABLED: boolean }).LIVEKIT_ENABLED = false;
    try {
      await assert.rejects(createVoiceService({ server: () => server, audit: async () => undefined }).startSession(USER, { fromNumber: '+919847012345' }, META), { status: 404 });
      assert.equal(calls.createRoom.length, 0);
    } finally {
      (env as { LIVEKIT_ENABLED: boolean }).LIVEKIT_ENABLED = true;
    }
  });
});

describe('HTTP: POST /api/voice/sessions and the voice-worker guard', () => {
  afterEach(() => mock.restoreAll());

  type Role = 'admin' | 'staff' | 'approver';
  async function withApp(fn: (request: (path: string, body: unknown, userId?: string, role?: Role) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>) {
    const server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await fn(async (path, body, userId, role = 'admin') => {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (userId) headers['authorization'] = `Bearer ${await signAccessToken({ id: userId, role })}`;
        const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it('requires an admin login, validates the phone number, and passes the normalised request to the service', async () => {
    const start = mock.method(voiceService, 'startSession', async () => ({ roomName: 'call-x', serverUrl: 'wss://x', participantToken: 't', participantIdentity: 'i', expiresInSeconds: 300 }));
    await withApp(async (post) => {
      assert.equal((await post('/api/voice/sessions', { fromNumber: '+919847012345' })).status, 401);
      const bad = await post('/api/voice/sessions', { fromNumber: 'not-a-phone' }, USER.id);
      assert.equal(bad.status, 400);
      const ok = await post('/api/voice/sessions', { fromNumber: '+91 98470 12345', language: 'en', roomName: 'chosen-by-client' }, USER.id);
      assert.equal(ok.status, 201);
      assert.equal(ok.body['participantToken'], 't');
    });
    assert.equal(start.mock.callCount(), 1);
    const [user, body] = start.mock.calls[0]!.arguments as unknown as [{ id: string; role: string }, Record<string, unknown>];
    assert.deepEqual([user.id, user.role], [USER.id, 'admin']);
    assert.deepEqual(body, { fromNumber: '+919847012345', language: 'en' }, 'a client-chosen room name is dropped');
  });

  it('refuses staff and approvers with 403 before the service runs', async () => {
    const start = mock.method(voiceService, 'startSession', async () => ({ roomName: 'call-x', serverUrl: 'wss://x', participantToken: 't', participantIdentity: 'i', expiresInSeconds: 300 }));
    await withApp(async (post) => {
      for (const role of ['staff', 'approver'] as const) {
        const res = await post('/api/voice/sessions', { fromNumber: '+919847012345' }, USER.id, role);
        assert.equal(res.status, 403, role);
        assert.equal((res.body['error'] as { code: string }).code, 'FORBIDDEN');
      }
    });
    assert.equal(start.mock.callCount(), 0);
  });

  it('limits each user to 10 sessions per 10 minutes', async () => {
    mock.method(voiceService, 'startSession', async () => ({ roomName: 'call-x', serverUrl: 'wss://x', participantToken: 't', participantIdentity: 'i', expiresInSeconds: 300 }));
    const userId = '6a1d0b8f-2e3c-4d4e-9f50-b2c3d4e5f6a7';
    await withApp(async (post) => {
      for (let i = 0; i < 10; i++) assert.equal((await post('/api/voice/sessions', { fromNumber: '+919847012345' }, userId)).status, 201);
      const limited = await post('/api/voice/sessions', { fromNumber: '+919847012345' }, userId);
      assert.equal(limited.status, 429);
    });
  });

  it('the text-simulator turn and end endpoints refuse LiveKit calls, which the worker owns', async () => {
    let provider = 'livekit';
    mock.method(callsRepository, 'findById', async () => ({ provider }) as never);
    const turn = mock.method(callsService, 'turn', async () => ({ reply: 'ok', language: 'en' as const, state: 'collecting_items' as const, toolCalls: [], ended: false }));
    const end = mock.method(callsService, 'endSession', async () => 'completed' as const);
    const id = '7b2e1c9a-3f4d-4e5f-8a6b-c3d4e5f6a7b8';
    await withApp(async (post) => {
      const refusedTurn = await post(`/api/conversations/${id}/turns`, { text: 'two strips' }, USER.id, 'staff');
      assert.equal(refusedTurn.status, 409);
      assert.equal((refusedTurn.body['error'] as { code: string }).code, 'CALL_HANDLED_BY_VOICE_WORKER');
      assert.equal((await post(`/api/conversations/${id}/end`, {}, USER.id, 'staff')).status, 409);
      assert.equal(turn.mock.callCount() + end.mock.callCount(), 0);

      provider = 'simulator';
      assert.equal((await post(`/api/conversations/${id}/turns`, { text: 'two strips' }, USER.id, 'staff')).status, 200, 'simulator sessions unchanged');
    });
    assert.equal(turn.mock.callCount(), 1);
  });
});
