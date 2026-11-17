// Browser voice calls over LiveKit, API side: mints the browser's join token, creates the room and dispatches
// the voice worker into it. The conversation session is opened by the worker (src/voice-worker.ts) once the
// browser has joined; this process never owns it. The API secret is used here and in the worker only.
import { randomBytes, randomUUID } from 'node:crypto';
import { AccessToken, JobRestartPolicy, LiveKitAPI, TrackSource } from 'livekit-server-sdk';
import { env } from '../../config/env.ts';
import type { AuthUser } from '../../middleware/auth.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { audit, type RequestMeta } from '../../utils/audit.ts';
import { logger } from '../../utils/logger.ts';
import { JOIN_WINDOW_SECONDS, roomNameFor, type StartVoiceSessionInput, type VoiceJob } from './voice.validation.ts';

/** The LiveKit server calls made here; LiveKitAPI satisfies it and tests pass a fake. */
export interface LiveKitServer {
  room: {
    createRoom(options: { name: string; emptyTimeout: number; departureTimeout: number; maxParticipants: number }): Promise<unknown>;
    deleteRoom(name: string): Promise<void>;
  };
  agentDispatch: {
    createDispatch(roomName: string, agentName: string, options: { metadata: string; restartPolicy: JobRestartPolicy }): Promise<unknown>;
  };
}

export interface VoiceSession {
  roomName: string;
  /** wss:// URL the browser connects to; not a secret. */
  serverUrl: string;
  participantToken: string;
  participantIdentity: string;
  /** The token only admits a join within this many seconds. */
  expiresInSeconds: number;
}

const defaultServer = (() => {
  let api: LiveKitAPI | undefined;
  return (): LiveKitServer => (api ??= new LiveKitAPI({ host: env.LIVEKIT_URL!, apiKey: env.LIVEKIT_API_KEY!, secret: env.LIVEKIT_API_SECRET! }));
})();

export function createVoiceService({ server = defaultServer, audit: writeAudit = audit }: { server?: () => LiveKitServer; audit?: typeof audit } = {}) {
  return {
    async startSession(user: AuthUser, input: StartVoiceSessionInput, meta: RequestMeta): Promise<VoiceSession> {
      if (!env.LIVEKIT_ENABLED) throw new AppError(404, 'NOT_FOUND', 'Browser voice calls are not enabled');
      const id = randomUUID();
      const roomName = roomNameFor(id);
      const participantIdentity = `staff-${user.id}-${randomBytes(4).toString('hex')}`;

      // Join this one room, publish a microphone and hear the agent: no data messages, no metadata changes,
      // no room creation, listing or admin rights.
      const token = new AccessToken(env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!, { identity: participantIdentity, ttl: JOIN_WINDOW_SECONDS });
      token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false });
      const participantToken = await token.toJwt();

      const job: VoiceJob = { fromNumber: input.fromNumber, language: input.language, participantIdentity };
      const api = server();
      try {
        // Two seats, caller and agent. The room closes if nobody joins within the join window.
        await api.room.createRoom({ name: roomName, emptyTimeout: JOIN_WINDOW_SECONDS, departureTimeout: 20, maxParticipants: 2 });
        // A failed job is not restarted: a restarted agent would find the call already recorded and stay silent.
        await api.agentDispatch.createDispatch(roomName, env.LIVEKIT_AGENT_NAME, { metadata: JSON.stringify(job), restartPolicy: JobRestartPolicy.JRP_NEVER });
      } catch (err) {
        logger.error('voice.session_failed', { roomName, message: err instanceof Error ? err.message : String(err) });
        await api.room.deleteRoom(roomName).catch(() => undefined);
        throw new AppError(502, 'LIVEKIT_UNAVAILABLE', 'The voice call could not be started; try again');
      }

      await writeAudit({ actorType: 'staff', actorId: user.id, action: 'voice_session.create', entityType: 'livekit_room', entityId: id, after: { roomName, agentName: env.LIVEKIT_AGENT_NAME, language: input.language ?? null }, ...meta });
      logger.info('voice.session_created', { roomName, userId: user.id });
      return { roomName, serverUrl: env.LIVEKIT_URL!, participantToken, participantIdentity, expiresInSeconds: JOIN_WINDOW_SECONDS };
    },
  };
}

export const voiceService = createVoiceService();
