// LiveKit voice worker: a separate process from the Express API.
//   npm run voice-worker:dev     (tsx, from source)      npm run voice-worker:start   (node, from dist/)
// It registers with LiveKit under LIVEKIT_AGENT_NAME and only takes jobs dispatched explicitly by
// POST /api/voice/sessions. Each job runs in its own child process: it joins the room, waits for the one
// participant the API minted a token for, publishes the agent's voice and runs the existing conversation engine
// through the shared voice loop (modules/voice/livekit.call.ts). LiveKit's own voice pipeline (AgentSession) is
// deliberately not used: speech, the model, tools and order rules stay in this backend.
import { fileURLToPath } from 'node:url';
import { AutoSubscribe, cli, defineAgent, ServerOptions, type JobContext, type JobRequest } from '@livekit/agents';
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, RoomEvent, TrackKind, TrackPublishOptions, TrackSource, type RemoteTrack, type Room } from '@livekit/rtc-node';
import { env } from './config/env.ts';
import { LIVEKIT_SAMPLE_RATE } from './integrations/livekit/livekit.transport.ts';
import { runLiveKitCall, type LiveKitCallOutcome } from './modules/voice/livekit.call.ts';
import { JOIN_WINDOW_SECONDS, parseVoiceJob } from './modules/voice/voice.validation.ts';
import { logger } from './utils/logger.ts';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Accepts only jobs the API created: a voice-call room name and dispatch metadata that validates. */
async function requestFunc(req: JobRequest): Promise<void> {
  const parsed = parseVoiceJob(req.room?.name, req.job.metadata);
  if (!parsed.ok) {
    logger.warn('livekit.job_rejected', { jobId: req.id, roomName: req.room?.name ?? null, reason: parsed.reason });
    await req.reject();
    return;
  }
  await req.accept('Pharmacy voice agent', `agent-${req.id}`);
}

/** The caller's first audio track: already subscribed, or the next one subscribed. */
function callerTrack(room: Room, identity: string): Promise<RemoteTrack> {
  const participant = room.remoteParticipants.get(identity);
  for (const publication of participant?.trackPublications.values() ?? []) {
    if (publication.kind === TrackKind.KIND_AUDIO && publication.track) return Promise.resolve(publication.track as RemoteTrack);
  }
  return new Promise((resolve) => {
    const onTrack = (track: RemoteTrack, _publication: unknown, from: { identity: string }) => {
      if (from.identity !== identity || track.kind !== TrackKind.KIND_AUDIO) return;
      room.off(RoomEvent.TrackSubscribed, onTrack);
      resolve(track);
    };
    room.on(RoomEvent.TrackSubscribed, onTrack);
  });
}

/** The caller's microphone, resampled by rtc-node to the voice loop's 16 kHz mono. */
async function* callerAudio(room: Room, identity: string): AsyncGenerator<AudioFrame> {
  const track = await callerTrack(room, identity);
  yield* new AudioStream(track, { sampleRate: LIVEKIT_SAMPLE_RATE, numChannels: 1 });
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]).finally(() => clearTimeout(timer));
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const parsed = parseVoiceJob(ctx.job.room?.name, ctx.job.metadata);
    if (!parsed.ok) {
      logger.warn('livekit.job_rejected', { jobId: ctx.job.id, reason: parsed.reason });
      ctx.shutdown('invalid job');
      return;
    }
    const { roomName, job } = parsed;
    const room = ctx.room;
    // Listen before anything can be missed: the caller leaving, or the agent losing the room for good
    // (rtc-node reconnects on its own first).
    let endCall!: () => void;
    const ended = new Promise<void>((resolve) => {
      endCall = resolve;
      room.on(RoomEvent.ParticipantDisconnected, (p) => {
        if (p.identity === job.participantIdentity) resolve();
      });
      room.on(RoomEvent.Disconnected, () => resolve());
    });

    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    const caller = await within(ctx.waitForParticipant(job.participantIdentity), JOIN_WINDOW_SECONDS * 1000);
    if (!caller) {
      logger.warn('livekit.caller_never_joined', { roomName });
      await ctx.deleteRoom().catch((err: unknown) => logger.warn('livekit.room_delete_failed', { roomName, message: errorMessage(err) }));
      ctx.shutdown('caller never joined');
      return;
    }

    // Worker shutdown (deploy, SIGTERM): end the call and keep the job alive until the end is recorded, so the call
    // row gets its end time and duration. Shutdown callbacks also run after a normal end; then this returns at once.
    let markRecorded!: () => void;
    const recorded = new Promise<void>((resolve) => (markRecorded = resolve));
    ctx.addShutdownCallback(async () => {
      endCall();
      await within(recorded, 10_000);
    });

    const source = new AudioSource(LIVEKIT_SAMPLE_RATE, 1);
    let outcome: LiveKitCallOutcome | 'failed' = 'failed';
    try {
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('agent-voice', source), options);
      outcome = await runLiveKitCall(roomName, job, {
        output: {
          capture: (samples) => source.captureFrame(new AudioFrame(samples, LIVEKIT_SAMPLE_RATE, 1, samples.length)),
          clearQueue: () => source.clearQueue(),
          waitForPlayout: () => source.waitForPlayout(),
        },
        callerAudio: callerAudio(room, job.participantIdentity),
        ended,
      });
    } catch (err) {
      logger.error('livekit.call_failed', { roomName, message: errorMessage(err) });
    } finally {
      markRecorded();
      await source.close().catch(() => undefined);
      // A finished or failed call takes the room (and the browser) down with it. A duplicate job leaves the room
      // alone: it belongs to the job that owns the call.
      if (outcome !== 'duplicate') {
        await ctx.deleteRoom().catch((err: unknown) => logger.warn('livekit.room_delete_failed', { roomName, message: errorMessage(err) }));
      }
      ctx.shutdown(`call ${outcome}`);
    }
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    console.error('The voice worker needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.');
    process.exit(1);
  }
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: env.LIVEKIT_AGENT_NAME,
      requestFunc,
      wsURL: env.LIVEKIT_URL,
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      numIdleProcesses: env.LIVEKIT_WORKER_IDLE_PROCESSES,
    }),
  );
}
