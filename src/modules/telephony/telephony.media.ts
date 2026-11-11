// Media-stream handler: one WebSocket per live call. Caller audio is cut into utterances by a simple
// energy-based voice-activity detector, recognised, answered by the orchestrator, synthesised and streamed
// back. Agent speech is interrupted (barge-in) when the caller starts talking.
import type { WebSocket } from 'ws';
import { env } from '../../config/env.ts';
import type { MediaMessage, TelephonyAdapter } from '../../integrations/telephony/telephony.port.ts';
import { logger } from '../../utils/logger.ts';
import { CLOSING_TEXT } from '../ai/ai.prompts.ts';
import type { ConversationSession } from '../ai/ai.types.ts';
import { callsService } from '../calls/calls.service.ts';
import { sessionRegistry } from '../calls/session.registry.ts';
import { speechService } from '../speech/speech.service.ts';
import { telephonyService } from './telephony.service.ts';

const FRAME_BYTES = 320; // 20 ms at 8 kHz, 16-bit mono
const SILENCE_END_MS = 700;
const MIN_SPEECH_MS = 300;
const MAX_UTTERANCE_MS = 15_000;

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

interface StreamState {
  streamSid: string | null;
  callId: string | null;
  session: ConversationSession | null;
  speaking: boolean;
  busy: Promise<void>;
  closed: boolean;
}

export function attachMediaStream(ws: WebSocket, adapter: TelephonyAdapter): void {
  const state: StreamState = { streamSid: null, callId: null, session: null, speaking: false, busy: Promise.resolve(), closed: false };
  const vad = new UtteranceDetector({ threshold: env.VAD_RMS_THRESHOLD, frameMs: 20, silenceEndMs: SILENCE_END_MS, minSpeechMs: MIN_SPEECH_MS, maxUtteranceMs: MAX_UTTERANCE_MS });
  let pending = Buffer.alloc(0);

  const send = (payload: string) => {
    if (!state.closed && ws.readyState === ws.OPEN) ws.send(payload);
  };

  async function speak(text: string): Promise<void> {
    if (!state.session || !state.streamSid || !text) return;
    try {
      const pcm = await speechService.speak(text, state.session.language, adapter.sampleRate);
      state.speaking = true;
      for (const frame of adapter.buildMediaFrames(state.streamSid, pcm)) {
        if (!state.speaking) break; // barge-in
        send(frame);
      }
      send(adapter.buildMark(state.streamSid, `end-${Date.now()}`));
    } catch (err) {
      logger.error('media.tts_failed', { callId: state.callId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onUtterance(audio: Buffer): Promise<void> {
    if (!state.session || !state.callId) return;
    let result;
    try {
      result = await speechService.transcribe(audio, state.session.language, adapter.sampleRate);
    } catch (err) {
      logger.error('media.stt_failed', { callId: state.callId, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (!result.text.trim()) return;
    const turn = await callsService.turn(state.callId, result.text, { confidence: result.confidence });
    await speak(turn.reply);
    if (turn.state === 'handover_required') await telephonyService.transferToStaff(state.callId, state.session.providerCallSid);
    if (turn.ended && turn.state === 'completed') await speak(CLOSING_TEXT[state.session.language]);
  }

  function enqueue(task: () => Promise<void>): void {
    state.busy = state.busy.then(task).catch((err: unknown) => logger.error('media.turn_failed', { callId: state.callId, message: err instanceof Error ? err.message : String(err) }));
  }

  async function onMessage(message: MediaMessage): Promise<void> {
    switch (message.event) {
      case 'start': {
        state.streamSid = message.streamSid;
        const callSid = message.callSid ?? message.custom['CallSid'] ?? message.streamSid;
        const started = await callsService.startSession({ provider: adapter.name, providerCallSid: callSid, fromNumber: message.fromNumber ?? message.custom['From'] ?? 'unknown', toNumber: message.toNumber ?? message.custom['To'] ?? 'unknown' });
        state.callId = started.callId;
        state.session = started.session;
        enqueue(() => speak(started.greeting.reply));
        if (started.greeting.state === 'handover_required') enqueue(() => telephonyService.transferToStaff(started.callId, callSid).then(() => undefined));
        break;
      }
      case 'media': {
        pending = Buffer.concat([pending, message.audio]);
        while (pending.length >= FRAME_BYTES) {
          const frame = pending.subarray(0, FRAME_BYTES);
          pending = pending.subarray(FRAME_BYTES);
          const rms = frameRms(frame);
          if (state.speaking && rms >= env.VAD_RMS_THRESHOLD && state.streamSid) {
            state.speaking = false; // barge-in: stop streaming agent audio
            send(adapter.buildClear(state.streamSid));
          }
          const utterance = vad.feed(frame, rms);
          if (utterance) enqueue(() => onUtterance(utterance));
        }
        break;
      }
      case 'stop':
        state.closed = true;
        if (state.callId && sessionRegistry.get(state.callId)) await callsService.endSession(state.callId, 'caller_hangup');
        break;
      case 'mark':
        // The provider finished playing our audio: the caller is no longer interrupting anything.
        state.speaking = false;
        break;
      case 'connected':
      case 'dtmf':
      case 'unknown':
        break;
    }
  }

  ws.on('message', (data) => {
    const message = adapter.parseMediaMessage(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    onMessage(message).catch((err: unknown) => logger.error('media.message_failed', { callId: state.callId, event: message.event, message: err instanceof Error ? err.message : String(err) }));
  });
  ws.on('close', () => {
    state.closed = true;
    state.speaking = false;
    if (state.callId && sessionRegistry.get(state.callId)) {
      callsService.endSession(state.callId, 'caller_hangup').catch((err: unknown) => logger.error('media.end_failed', { callId: state.callId, message: err instanceof Error ? err.message : String(err) }));
    }
  });
}
