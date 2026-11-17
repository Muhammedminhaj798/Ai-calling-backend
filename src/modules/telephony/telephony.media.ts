// Media-stream handler: one WebSocket per live call. Translates the provider's stream messages (Exotel
// Voicebot or the mock protocol) into the shared voice loop (modules/voice/voice.loop.ts), which cuts
// utterances, recognises them, runs the conversation turn, synthesises the reply and handles barge-in.
import type { WebSocket } from 'ws';
import type { MediaMessage, TelephonyAdapter } from '../../integrations/telephony/telephony.port.ts';
import { logger } from '../../utils/logger.ts';
import { createVoiceLoop } from '../voice/voice.loop.ts';
import { telephonyService } from './telephony.service.ts';

export { frameRms, UtteranceDetector, type VadOptions } from '../voice/voice.loop.ts';

export function attachMediaStream(ws: WebSocket, adapter: TelephonyAdapter): void {
  let streamSid: string | null = null;
  let closed = false;

  const send = (payload: string) => {
    if (!closed && ws.readyState === ws.OPEN) ws.send(payload);
  };

  // streamSid is set by the provider's start message, before the loop opens the session; the loop only
  // plays or clears audio while canPlay() is true.
  const loop = createVoiceLoop<string>({
    sampleRate: adapter.sampleRate,
    canPlay: () => Boolean(streamSid),
    frames: (pcm) => adapter.buildMediaFrames(streamSid!, pcm),
    send,
    markEnd: () => send(adapter.buildMark(streamSid!, `end-${Date.now()}`)),
    clear: () => send(adapter.buildClear(streamSid!)),
    transferToStaff: (callId, providerCallSid) => telephonyService.transferToStaff(callId, providerCallSid),
  });

  async function onMessage(message: MediaMessage): Promise<void> {
    switch (message.event) {
      case 'start':
        streamSid = message.streamSid;
        await loop.start({
          provider: adapter.name,
          providerCallSid: message.callSid ?? message.custom['CallSid'] ?? message.streamSid,
          fromNumber: message.fromNumber ?? message.custom['From'] ?? 'unknown',
          toNumber: message.toNumber ?? message.custom['To'] ?? 'unknown',
        });
        break;
      case 'media':
        loop.audio(message.audio);
        break;
      case 'stop':
        closed = true;
        await loop.end();
        break;
      case 'mark':
        // The provider finished playing our audio: the caller is no longer interrupting anything.
        loop.playbackFinished();
        break;
      case 'connected':
      case 'dtmf':
      case 'unknown':
        break;
    }
  }

  ws.on('message', (data) => {
    const message = adapter.parseMediaMessage(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    onMessage(message).catch((err: unknown) => logger.error('media.message_failed', { callId: loop.callId, event: message.event, message: err instanceof Error ? err.message : String(err) }));
  });
  ws.on('close', () => {
    closed = true;
    loop.end().catch((err: unknown) => logger.error('media.end_failed', { callId: loop.callId, message: err instanceof Error ? err.message : String(err) }));
  });
}
