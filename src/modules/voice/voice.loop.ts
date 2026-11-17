// Transport-independent voice loop, one per live call. Caller audio is cut into utterances by a simple
// energy-based voice-activity detector, recognised, answered by the conversation orchestrator (through
// callsService), synthesised sentence by sentence and played back through the transport. Agent speech is
// interrupted (barge-in) when the caller starts talking. A transport only moves audio and control messages:
// the Exotel/mock media WebSocket (modules/telephony/telephony.media.ts) is one.
//
// Each answered utterance logs `voice.turn_timing`: where the time between the caller going quiet and the
// agent's first audio went (endpointing, STT, the conversation turn, first TTS audio, hand-off to the transport).
//
// Turns stay strictly one at a time. A reply whose caller has already said something newer is not spoken
// (superseded), except replies the order flow depends on (read-back, confirmation, handover, call end); it is
// kept and spoken after all if the newer utterance turns out to be noise. Words the caller began before the
// previous reply started playing go to the turn as spokeEarly: the orchestrator tells the model they are not an
// answer to that reply (SPOKE_EARLY_NOTE) and the tool registry refuses record_customer_confirmation in that turn.
import { env } from '../../config/env.ts';
import type { ConversationState } from '../../generated/prisma/enums.ts';
import { logger } from '../../utils/logger.ts';
import { CLOSING_TEXT } from '../ai/ai.prompts.ts';
import type { ConversationSession, TurnResult } from '../ai/ai.types.ts';
import type { SessionEndReason } from '../ai/conversation.service.ts';
import { callsService, type StartSessionInput } from '../calls/calls.service.ts';
import { sessionRegistry } from '../calls/session.registry.ts';
import { speechService } from '../speech/speech.service.ts';

export type SampleRate = 8000 | 16000;

const FRAME_MS = 20;
const SILENCE_END_MS = 700;
const MIN_SPEECH_MS = 300;
const MAX_UTTERANCE_MS = 15_000;
/** Sentence syntheses in flight ahead of playback. */
const TTS_PREFETCH = 3;

// Replies that are spoken even when the caller has already said something newer.
const ALWAYS_SPOKEN_STATES: ReadonlySet<ConversationState> = new Set(['reading_back', 'waiting_customer_confirmation', 'handover_required', 'completed', 'failed']);
const ALWAYS_SPOKEN_TOOLS: ReadonlySet<string> = new Set(['generate_order_readback', 'record_customer_confirmation', 'request_human_handover']);
const mustSpeak = (turn: TurnResult) => turn.ended || ALWAYS_SPOKEN_STATES.has(turn.state) || turn.toolCalls.some((c) => ALWAYS_SPOKEN_TOOLS.has(c.name));

/**
 * A reply as sentences (. ! ? । ॥ or a line break), so playback starts once the first is synthesised instead
 * of after the whole reply (measured with Sarvam bulbul: 4–7 s for a 180–270 character reply, 1.2–3.7 s for
 * its first sentence). Splitting never drops or reorders text.
 */
export function speechPieces(text: string): string[] {
  return text.trim().split(/(?<=[.!?।॥])\s+|\s*\n+\s*/u).filter(Boolean);
}

/**
 * Synthesises pieces with at most `ahead` requests in flight and yields their audio in order. A consumer that
 * stops early (barge-in) abandons at most `ahead - 1` requests, and their failures are not unhandled rejections.
 */
export async function* synthesizeInOrder(pieces: string[], synth: (piece: string) => Promise<Buffer>, ahead = TTS_PREFETCH): AsyncGenerator<Buffer> {
  const inFlight: Promise<Buffer>[] = [];
  const request = (piece: string) => {
    const audio = synth(piece);
    audio.catch(() => undefined); // still awaited below, in order
    inFlight.push(audio);
  };
  pieces.slice(0, ahead).forEach(request);
  for (let i = 0; i < pieces.length; i++) {
    const audio = await inFlight[i]!;
    if (i + ahead < pieces.length) request(pieces[i + ahead]!);
    yield audio;
  }
}

/** Bytes in one 20 ms frame of 16-bit mono PCM: 320 at 8 kHz, 640 at 16 kHz. */
export const frameBytes = (sampleRate: SampleRate): number => (sampleRate / 1000) * FRAME_MS * 2;

/** Root-mean-square amplitude of a 16-bit PCM frame. */
export function frameRms(frame: Buffer): number {
  const samples = Math.floor(frame.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = frame.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

export interface VadOptions {
  threshold: number;
  frameMs: number;
  silenceEndMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
}

/** Accumulates frames into utterances. feed() returns a completed utterance when one ends. */
export class UtteranceDetector {
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private chunks: Buffer[] = [];
  private totalMs = 0;

  constructor(private readonly opts: VadOptions) {}

  get inSpeech(): boolean {
    return this.speaking;
  }

  feed(frame: Buffer, rms: number = frameRms(frame)): Buffer | null {
    const voiced = rms >= this.opts.threshold;
    if (!this.speaking) {
      if (!voiced) return null;
      this.speaking = true;
      this.speechMs = 0;
      this.silenceMs = 0;
      this.chunks = [];
      this.totalMs = 0;
    }
    this.chunks.push(frame);
    this.totalMs += this.opts.frameMs;
    if (voiced) {
      this.speechMs += this.opts.frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += this.opts.frameMs;
    }
    const ended = this.silenceMs >= this.opts.silenceEndMs || this.totalMs >= this.opts.maxUtteranceMs;
    if (!ended) return null;
    const utterance = Buffer.concat(this.chunks);
    const hadSpeech = this.speechMs >= this.opts.minSpeechMs;
    this.speaking = false;
    this.chunks = [];
    return hadSpeech ? utterance : null;
  }
}

/** What a call transport provides. All audio is 16-bit little-endian mono PCM at `sampleRate`. */
export interface VoiceTransport<Frame> {
  readonly sampleRate: SampleRate;
  /** False until the transport can carry agent audio; nothing is spoken (or cleared) before that. */
  canPlay(): boolean;
  /** Splits agent speech into the transport's playback units. */
  frames(pcm: Buffer): Iterable<Frame>;
  /** Sends one unit. The loop stops sending between units when the caller barges in. */
  send(frame: Frame): void | Promise<void>;
  /** Marks the end of agent speech; the transport calls playbackFinished() once it has been played. */
  markEnd(): void;
  /** Drops agent audio already queued for playback (barge-in). */
  clear(): void;
  /** Hands the live call to staff. Records its own outcome; must not throw. */
  transferToStaff(callId: string, providerCallSid: string): Promise<unknown>;
}

export interface VoiceLoop {
  /** The call this loop is serving, once start() has opened its session. */
  readonly callId: string | null;
  /** Opens (or resumes) the conversation session and plays the greeting. */
  start(call: StartSessionInput): Promise<void>;
  /** Caller audio in chunks of any size; cut into 20 ms frames here. */
  audio(pcm: Buffer): void;
  /** The transport finished playing agent speech: the caller is no longer interrupting anything. */
  playbackFinished(): void;
  /**
   * The caller hung up or the transport closed (or the call idled out): ends the session if it is still live.
   * Afterwards caller audio is ignored, no recognition or turn starts, and no agent audio is sent; a turn already
   * running finishes (its records are kept) but is not spoken.
   */
  end(reason?: SessionEndReason): Promise<void>;
}

export function createVoiceLoop<Frame>(transport: VoiceTransport<Frame>): VoiceLoop {
  const bytesPerFrame = frameBytes(transport.sampleRate);
  const vad = new UtteranceDetector({ threshold: env.VAD_RMS_THRESHOLD, frameMs: FRAME_MS, silenceEndMs: SILENCE_END_MS, minSpeechMs: MIN_SPEECH_MS, maxUtteranceMs: MAX_UTTERANCE_MS });
  let callId: string | null = null;
  let session: ConversationSession | null = null;
  let speaking = false;
  // Set by end(): the caller is gone, so no new recognition, turn or agent audio starts after it.
  let ended = false;
  let busy: Promise<void> = Promise.resolve();
  let pending = Buffer.alloc(0);
  // What the loop heard, logged once as voice.call_audio when the call ends: tells "no caller audio",
  // "too quiet for the voice detector" and "speech recognised as nothing" apart.
  const heard = { frames: 0, voicedFrames: 0, maxRms: 0, utterances: 0, sttEmpty: 0, turns: 0 };
  // A logical clock orders "the caller began speaking" against "the last reply began playing" exactly.
  let tick = 0;
  let speechStartTick = 0; // start of the utterance the detector is in (or last was in)
  let replyHeardTick = Number.POSITIVE_INFINITY; // first frame of the last reply sent; Infinity while none was
  // The last superseded reply: spoken after all if the newer utterance is recognised as nothing.
  let deferredReply: string | null = null;

  /**
   * Speaks a reply sentence by sentence, in order. A sentence that fails to synthesise ends the reply there:
   * later sentences are never played without it. Returns when the first audio was ready and first sent.
   */
  async function speak(text: string): Promise<{ firstAudioAt: number | null; firstFrameAt: number | null; pieces: number }> {
    const timing = { firstAudioAt: null as number | null, firstFrameAt: null as number | null, pieces: 0 };
    replyHeardTick = Number.POSITIVE_INFINITY; // until its first frame is sent, this reply has not been heard
    if (!session || ended || !transport.canPlay() || !text) return timing;
    const language = session.language;
    const pieces = speechPieces(text);
    timing.pieces = pieces.length;
    try {
      for await (const pcm of synthesizeInOrder(pieces, (piece) => speechService.speak(piece, language, transport.sampleRate))) {
        if (ended) break; // the caller hung up while this was being synthesised: the transport may be closed
        if (timing.firstAudioAt === null) {
          timing.firstAudioAt = Date.now();
          speaking = true;
        } else if (!speaking) break; // barge-in between sentences
        for (const frame of transport.frames(pcm)) {
          if (!speaking) break; // barge-in
          await transport.send(frame);
          if (timing.firstFrameAt === null) {
            timing.firstFrameAt = Date.now();
            replyHeardTick = ++tick;
          }
        }
      }
    } catch (err) {
      logger.error('media.tts_failed', { callId, message: err instanceof Error ? err.message : String(err) });
    }
    if (timing.firstAudioAt !== null && !ended) transport.markEnd();
    return timing;
  }

  /**
   * The utterance `seq` was recognised as nothing (or not at all): if it had superseded a reply and nothing newer
   * is waiting, that reply is spoken now, so a cough or a click never leaves the caller in silence.
   */
  async function speakDeferredReply(seq: number): Promise<void> {
    if (deferredReply === null || ended || heard.utterances !== seq) return;
    const text = deferredReply;
    deferredReply = null;
    logger.info('voice.deferred_reply_spoken', { callId, replyChars: [...text].length });
    await speak(text);
  }

  /** `seq`: the utterance's number (heard.utterances when it was detected); `startTick`: when the caller began it. */
  async function onUtterance(audio: Buffer, detectedAt: number, seq: number, startTick: number): Promise<void> {
    if (!session || !callId || ended) return;
    const sttStart = Date.now();
    let result;
    try {
      result = await speechService.transcribe(audio, session.language, transport.sampleRate);
    } catch (err) {
      logger.error('media.stt_failed', { callId, message: err instanceof Error ? err.message : String(err) });
      await speakDeferredReply(seq);
      return;
    }
    const sttDone = Date.now();
    if (!result.text.trim()) {
      heard.sttEmpty++;
      await speakDeferredReply(seq);
      return;
    }
    // Hung up during recognition: a turn now would reopen the ended session from the database.
    if (ended) return;
    heard.turns++;
    deferredReply = null; // the caller said something real: the reply they talked past stays unspoken
    // Begun before the previous reply started playing (or it never played): not an answer to that reply.
    const spokeEarly = startTick < replyHeardTick;
    const turn = await callsService.turn(callId, result.text, { confidence: result.confidence, ...(spokeEarly ? { spokeEarly } : {}) });
    const turnDone = Date.now();
    // The caller has already said something newer: answering this now would be stale. Kept for speakDeferredReply.
    const superseded = heard.utterances > seq && !mustSpeak(turn);
    let spoken: Awaited<ReturnType<typeof speak>> = { firstAudioAt: null, firstFrameAt: null, pieces: 0 };
    if (superseded) {
      deferredReply = turn.reply;
      replyHeardTick = Number.POSITIVE_INFINITY;
      logger.info('voice.reply_superseded', { callId, replyChars: [...turn.reply].length, state: turn.state });
    } else {
      spoken = await speak(turn.reply);
    }
    logger.info('voice.turn_timing', {
      callId,
      endpointMs: SILENCE_END_MS, // trailing silence that ends an utterance
      queueMs: sttStart - detectedAt, // waiting for the previous turn to finish
      sttMs: sttDone - sttStart,
      turnMs: turnDone - sttDone, // conversation turn: database, model rounds and tools
      ttsFirstAudioMs: spoken.firstAudioAt === null ? null : spoken.firstAudioAt - turnDone,
      firstFrameMs: spoken.firstFrameAt === null || spoken.firstAudioAt === null ? null : spoken.firstFrameAt - spoken.firstAudioAt,
      // end of the caller's speech (approximately: one endpoint before detection) → first agent audio sent
      totalMs: spoken.firstFrameAt === null ? null : spoken.firstFrameAt - detectedAt + SILENCE_END_MS,
      replyChars: [...turn.reply].length,
      ttsPieces: spoken.pieces,
      ...(superseded ? { skipped: 'superseded' } : {}),
    });
    if (turn.state === 'handover_required') await transport.transferToStaff(callId, session.providerCallSid);
    if (turn.ended && turn.state === 'completed') await speak(CLOSING_TEXT[session.language]);
  }

  function enqueue(task: () => Promise<void>): void {
    busy = busy.then(task).catch((err: unknown) => logger.error('media.turn_failed', { callId, message: err instanceof Error ? err.message : String(err) }));
  }

  return {
    get callId() {
      return callId;
    },

    async start(call) {
      const started = await callsService.startSession(call);
      callId = started.callId;
      session = started.session;
      enqueue(() => speak(started.greeting.reply).then(() => undefined));
      if (started.greeting.state === 'handover_required') enqueue(() => transport.transferToStaff(started.callId, call.providerCallSid).then(() => undefined));
    },

    audio(pcm) {
      if (ended) return;
      pending = Buffer.concat([pending, pcm]);
      while (pending.length >= bytesPerFrame) {
        const frame = pending.subarray(0, bytesPerFrame);
        pending = pending.subarray(bytesPerFrame);
        const rms = frameRms(frame);
        heard.frames++;
        heard.maxRms = Math.max(heard.maxRms, rms);
        if (rms >= env.VAD_RMS_THRESHOLD) heard.voicedFrames++;
        if (speaking && rms >= env.VAD_RMS_THRESHOLD && transport.canPlay()) {
          speaking = false; // barge-in: stop streaming agent audio
          transport.clear();
        }
        const wasInSpeech = vad.inSpeech;
        const utterance = vad.feed(frame, rms);
        if (!wasInSpeech && vad.inSpeech) speechStartTick = ++tick;
        if (utterance) {
          const seq = ++heard.utterances;
          const detectedAt = Date.now();
          const startTick = speechStartTick;
          enqueue(() => onUtterance(utterance, detectedAt, seq, startTick));
        }
      }
    },

    playbackFinished() {
      speaking = false;
    },

    async end(reason = 'caller_hangup') {
      if (!ended && callId) {
        logger.info('voice.call_audio', {
          callId,
          callerAudioMs: heard.frames * FRAME_MS, // 0: no caller audio reached the loop
          voicedMs: heard.voicedFrames * FRAME_MS, // 0 with audio: always below the voice threshold
          maxRms: Math.round(heard.maxRms),
          vadThreshold: env.VAD_RMS_THRESHOLD,
          utterances: heard.utterances,
          sttEmpty: heard.sttEmpty, // utterances recognised as no text (dropped)
          turns: heard.turns,
        });
      }
      ended = true;
      speaking = false;
      if (callId && sessionRegistry.get(callId)) await callsService.endSession(callId, reason);
    },
  };
}
