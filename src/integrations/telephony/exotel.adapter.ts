// Exotel adapter: inbound-call webhooks (Passthru applet) and the Voicebot applet's bidirectional media
// stream (ARCHITECTURE.md §B.3; protocol per developer.exotel.com/docs/agentstream/stream-voicebot-applet).
// Audio is raw 16-bit mono PCM, base64 in JSON, 8 kHz by default; outbound chunks must be ≥ 3.2 KB and a
// multiple of 320 bytes. Exotel does not sign webhooks, so the URL carries an unguessable secret and an
// optional source-IP allow-list is checked. NOT exercised against a live Exotel account in this repository.
import { timingSafeEqual } from 'node:crypto';
import { normalizePhone } from '../../utils/phone.ts';
import { TelephonyError, type CallStatusEvent, type IncomingCallEvent, type MediaMessage, type TelephonyAdapter } from './telephony.port.ts';

export interface ExotelConfig {
  webhookSecret: string;
  allowedIps: string[];
}

const CHUNK_BYTES = 3200; // 200 ms at 8 kHz × 16-bit mono; a multiple of 320

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const phone = (v: unknown): string => {
  const raw = str(v) ?? '';
  return normalizePhone(raw) ?? raw;
};

export function createExotelTelephony(config: ExotelConfig): TelephonyAdapter {
  return {
    name: 'exotel',
    sampleRate: 8000,

    verifyWebhook(req) {
      if (!secretMatches(req.secret, config.webhookSecret)) return false;
      if (config.allowedIps.length === 0) return true;
      const ip = (req.ip ?? '').replace(/^::ffff:/, '');
      return config.allowedIps.includes(ip);
    },

    parseIncoming(body): IncomingCallEvent {
      const sid = str(body['CallSid']);
      if (!sid) throw new TelephonyError('Exotel incoming webhook without CallSid');
      return { providerCallSid: sid, fromNumber: phone(body['From'] ?? body['CallFrom']), toNumber: phone(body['To'] ?? body['CallTo']), raw: body };
    },

    parseStatus(body): CallStatusEvent {
      const sid = str(body['CallSid']);
      if (!sid) throw new TelephonyError('Exotel status webhook without CallSid');
      const duration = str(body['ConversationDuration'] ?? body['Duration'] ?? body['DialCallDuration']);
      return {
        providerCallSid: sid,
        status: (str(body['Status'] ?? body['CallStatus'] ?? body['DialCallStatus']) ?? 'unknown').toLowerCase(),
        durationSeconds: duration !== null && Number.isFinite(Number(duration)) ? Number(duration) : null,
        recordingUrl: str(body['RecordingUrl']),
        raw: body,
      };
    },

    parseMediaMessage(raw): MediaMessage {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return { event: 'unknown', raw };
      }
      switch (msg['event']) {
        case 'connected':
          return { event: 'connected' };
        case 'start': {
          const start = (msg['start'] ?? {}) as Record<string, unknown>;
          const format = (start['media_format'] ?? {}) as Record<string, unknown>;
          const custom = (start['custom_parameters'] ?? {}) as Record<string, unknown>;
          return {
            event: 'start',
            streamSid: String(msg['stream_sid'] ?? start['stream_sid'] ?? ''),
            callSid: str(start['call_sid']),
            fromNumber: start['from'] ? phone(start['from']) : null,
            toNumber: start['to'] ? phone(start['to']) : null,
            sampleRate: Number(format['sample_rate'] ?? 8000),
            custom: Object.fromEntries(Object.entries(custom).map(([k, v]) => [k, String(v)])),
          };
        }
        case 'media': {
          const media = (msg['media'] ?? {}) as Record<string, unknown>;
          return { event: 'media', audio: Buffer.from(String(media['payload'] ?? ''), 'base64') };
        }
        case 'dtmf':
          return { event: 'dtmf', digit: String(((msg['dtmf'] ?? {}) as Record<string, unknown>)['digit'] ?? '') };
        case 'mark':
          return { event: 'mark', name: String(((msg['mark'] ?? {}) as Record<string, unknown>)['name'] ?? '') };
        case 'stop':
          return { event: 'stop', reason: str(((msg['stop'] ?? {}) as Record<string, unknown>)['reason']) };
        default:
          return { event: 'unknown', raw: msg };
      }
    },

    buildMediaFrames(streamSid, pcm16) {
      const frames: string[] = [];
      for (let offset = 0; offset < pcm16.length; offset += CHUNK_BYTES) {
        let chunk = pcm16.subarray(offset, offset + CHUNK_BYTES);
        if (chunk.length < CHUNK_BYTES) {
          // pad the last chunk with silence to Exotel's minimum size (already a multiple of 320)
          const padded = Buffer.alloc(CHUNK_BYTES);
          chunk.copy(padded);
          chunk = padded;
        }
        frames.push(JSON.stringify({ event: 'media', stream_sid: streamSid, media: { payload: chunk.toString('base64') } }));
      }
      return frames;
    },

    buildClear: (streamSid) => JSON.stringify({ event: 'clear', stream_sid: streamSid }),
    buildMark: (streamSid, name) => JSON.stringify({ event: 'mark', stream_sid: streamSid, mark: { name } }),

    async transferToStaff() {
      // Exotel's call-transfer API (and whether the Voicebot applet allows a mid-call transfer to a number or
      // a flow) must be confirmed with Exotel for the client's account before this can be implemented honestly.
      throw new TelephonyError('Exotel call transfer is not configured: the transfer API for this account is pending confirmation (ARCHITECTURE.md §G-7)');
    },
  };
}
