// LiveKit side of the shared voice loop (modules/voice/voice.loop.ts). No LiveKit SDK import here, so it is
// unit-tested with fakes; the worker (src/voice-worker.ts) plugs in @livekit/rtc-node's AudioSource and
// AudioStream. Audio is 16 kHz mono 16-bit PCM both ways: the worker has AudioStream resample the caller's
// 48 kHz WebRTC audio to that rate, and creates the agent's AudioSource at that rate.
import { frameBytes, type VoiceTransport } from '../../modules/voice/voice.loop.ts';
import { logger } from '../../utils/logger.ts';

export const LIVEKIT_SAMPLE_RATE = 16000;
const SAMPLES_PER_FRAME = frameBytes(LIVEKIT_SAMPLE_RATE) / 2; // 20 ms

/** The agent's outgoing audio (an rtc-node AudioSource, wrapped by the worker). */
export interface AgentAudioOutput {
  /** Queues samples; resolves when the source has room for more (back-pressure). */
  capture(samples: Int16Array): Promise<void>;
  /** Drops queued audio at once (barge-in). */
  clearQueue(): void;
  /** Resolves once everything captured so far has played out, or was cleared. */
  waitForPlayout(): Promise<void>;
}

/** A caller audio frame, as rtc-node's AudioStream yields it. */
export interface CallerAudioFrame {
  data: Int16Array;
  sampleRate: number;
  channels: number;
}

/**
 * Caller frame → PCM bytes for the voice loop, or null when it is not 16 kHz mono (such audio would make the
 * voice detector's 20 ms frames the wrong length, so it is dropped rather than misread). Int16Array is in the
 * platform's byte order, little-endian on every platform LiveKit ships native binaries for.
 */
export function callerFrameToPcm(frame: CallerAudioFrame): Buffer | null {
  if (frame.sampleRate !== LIVEKIT_SAMPLE_RATE || frame.channels !== 1) return null;
  return Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
}

/**
 * Agent speech (little-endian PCM bytes) → 20 ms frames. Each frame gets its own buffer: rtc-node's AudioFrame
 * passes the frame's whole underlying ArrayBuffer to the native layer, so a subarray view would play the wrong
 * samples.
 */
export function pcmToFrames(pcm: Buffer): Int16Array[] {
  const total = pcm.length >> 1;
  const frames: Int16Array[] = [];
  for (let start = 0; start < total; start += SAMPLES_PER_FRAME) {
    const frame = new Int16Array(Math.min(SAMPLES_PER_FRAME, total - start));
    for (let i = 0; i < frame.length; i++) frame[i] = pcm.readInt16LE((start + i) * 2);
    frames.push(frame);
  }
  return frames;
}

export interface LiveKitTransportOptions {
  /** Called when a reply has finished playing (the loop's playbackFinished). */
  onPlaybackFinished(): void;
  transferToStaff: VoiceTransport<Int16Array>['transferToStaff'];
}

export function createLiveKitTransport(output: AgentAudioOutput, opts: LiveKitTransportOptions): VoiceTransport<Int16Array> {
  // Each reply and each barge-in moves this on. A playout that completes after the next reply has started (or
  // after a clear) belongs to older audio and must not end the current reply's playback state.
  let playback = 0;
  return {
    sampleRate: LIVEKIT_SAMPLE_RATE,
    canPlay: () => true,
    frames(pcm) {
      playback++;
      return pcmToFrames(pcm);
    },
    send: (frame) => output.capture(frame),
    markEnd() {
      const current = playback;
      output.waitForPlayout().then(
        () => {
          if (current === playback) opts.onPlaybackFinished();
        },
        (err: unknown) => logger.warn('livekit.playout_wait_failed', { message: err instanceof Error ? err.message : String(err) }),
      );
    },
    clear() {
      playback++;
      output.clearQueue();
    },
    transferToStaff: opts.transferToStaff,
  };
}
