// One LiveKit browser call inside the voice worker: duplicate check, the shared voice loop over the LiveKit
// transport, caller audio in, idle timeout, and ending the session when the caller leaves. No LiveKit SDK import:
// src/voice-worker.ts supplies the room's audio and the caller-left signal; tests supply fakes.
//
// Ending a call never confirms anything: the session ends through callsService.endSession like an Exotel
// hang-up, which leaves an unconfirmed draft unconfirmed and raises the usual staff exception.
import { env } from '../../config/env.ts';
import { callerFrameToPcm, createLiveKitTransport, type AgentAudioOutput, type CallerAudioFrame } from '../../integrations/livekit/livekit.transport.ts';
import { logger } from '../../utils/logger.ts';
import type { SessionEndReason } from '../ai/conversation.service.ts';
import { callsRepository } from '../calls/calls.repository.ts';
import { sessionRegistry } from '../calls/session.registry.ts';
import { createVoiceLoop, type VoiceLoop } from './voice.loop.ts';
import { LIVEKIT_PROVIDER, type VoiceJob } from './voice.validation.ts';

export interface LiveKitCallIo {
  output: AgentAudioOutput;
  /** The caller's microphone at 16 kHz mono. */
  callerAudio: AsyncIterable<CallerAudioFrame>;
  /** Resolves when the caller leaves or the agent loses the room. */
  ended: Promise<void>;
}

/** `duplicate`: this room already has (or just got) a call, so this job must not touch it or the room. */
export type LiveKitCallOutcome = 'ended' | 'duplicate';

export interface LiveKitCallOptions {
  idleMs?: number;
  idleCheckMs?: number;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

/** A LiveKit room has no phone line to transfer, so the handover is recorded as skipped (like a missing number). */
async function recordSkippedTransfer(callId: string): Promise<void> {
  try {
    await callsRepository.addEvent({ callId, type: 'handover_transfer_skipped', ok: false, data: { reason: 'LiveKit browser call: no staff client can join the room yet' } });
  } catch (err) {
    logger.error('livekit.handover_event_failed', { callId, message: err instanceof Error ? err.message : String(err) });
  }
}

async function pumpCallerAudio(audio: AsyncIterable<CallerAudioFrame>, loop: VoiceLoop): Promise<void> {
  let warned = false;
  for await (const frame of audio) {
    const pcm = callerFrameToPcm(frame);
    if (pcm) loop.audio(pcm);
    else if (!warned) {
      warned = true;
      logger.warn('livekit.unexpected_audio_format', { callId: loop.callId, sampleRate: frame.sampleRate, channels: frame.channels });
    }
  }
}

/** Resolves when nobody has said anything for `idleMs` (or the session is gone); the same rule as the API's idle sweeper. */
function idleWatch(loop: VoiceLoop, idleMs: number, checkMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setInterval(() => {
      const session = loop.callId ? sessionRegistry.get(loop.callId) : undefined;
      if (!session || Date.now() - session.lastActivityAt > idleMs) resolve();
    }, checkMs);
  });
  return { done, stop: () => clearInterval(timer) };
}

export async function runLiveKitCall(roomName: string, job: VoiceJob, io: LiveKitCallIo, opts: LiveKitCallOptions = {}): Promise<LiveKitCallOutcome> {
  // One room is one call. A second job for a room that already has a call row (a re-dispatch, or a racing job
  // that lost the unique providerCallSid insert) must not start a second conversation on it.
  if (await callsRepository.findByProviderSid(roomName)) {
    logger.warn('livekit.duplicate_job', { roomName });
    return 'duplicate';
  }

  const transport = createLiveKitTransport(io.output, {
    onPlaybackFinished: () => loop.playbackFinished(),
    transferToStaff: recordSkippedTransfer,
  });
  const loop = createVoiceLoop(transport);
  try {
    await loop.start({ provider: LIVEKIT_PROVIDER, providerCallSid: roomName, fromNumber: job.fromNumber, toNumber: 'browser', language: job.language });
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.warn('livekit.duplicate_job', { roomName });
      return 'duplicate';
    }
    throw err;
  }
  logger.info('livekit.call_started', { roomName, callId: loop.callId });

  void pumpCallerAudio(io.callerAudio, loop).catch((err: unknown) =>
    logger.error('livekit.caller_audio_failed', { callId: loop.callId, message: err instanceof Error ? err.message : String(err) }),
  );
  const idleMs = opts.idleMs ?? env.CONVERSATION_IDLE_TIMEOUT_MINUTES * 60_000;
  const idle = idleWatch(loop, idleMs, opts.idleCheckMs ?? Math.min(30_000, idleMs));
  let reason: SessionEndReason = 'provider_error';
  try {
    reason = await Promise.race([io.ended.then(() => 'caller_hangup' as const), idle.done.then(() => 'idle_timeout' as const)]);
  } finally {
    idle.stop();
    // Also when waiting failed: the session ends and the call row gets its end time and duration.
    await loop.end(reason);
  }
  logger.info('livekit.call_ended', { roomName, callId: loop.callId, reason });
  return 'ended';
}
