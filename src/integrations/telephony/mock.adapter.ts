// Mock telephony: plain-JSON protocol with the same shape as the port, for tests and local runs.
import type { CallStatusEvent, IncomingCallEvent, MediaMessage, TelephonyAdapter } from './telephony.port.ts';

export interface MockTelephonyAdapter extends TelephonyAdapter {
  readonly transfers: Array<{ providerCallSid: string; phoneNumber: string }>;
}

export function createMockTelephony(): MockTelephonyAdapter {
  const transfers: Array<{ providerCallSid: string; phoneNumber: string }> = [];
  return {
    name: 'mock',
    sampleRate: 8000,
    transfers,
    verifyWebhook: () => true,
    parseIncoming(body): IncomingCallEvent {
      return { providerCallSid: String(body['callSid'] ?? ''), fromNumber: String(body['from'] ?? ''), toNumber: String(body['to'] ?? ''), raw: body };
    },
    parseStatus(body): CallStatusEvent {
      return {
        providerCallSid: String(body['callSid'] ?? ''),
        status: String(body['status'] ?? '').toLowerCase(),
        durationSeconds: body['duration'] === undefined ? null : Number(body['duration']),
        recordingUrl: body['recordingUrl'] ? String(body['recordingUrl']) : null,
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
        case 'start':
          return { event: 'start', streamSid: String(msg['streamSid'] ?? 'mock-stream'), callSid: msg['callSid'] ? String(msg['callSid']) : null, fromNumber: msg['from'] ? String(msg['from']) : null, toNumber: msg['to'] ? String(msg['to']) : null, sampleRate: Number(msg['sampleRate'] ?? 8000), custom: {} };
        case 'media':
          return { event: 'media', audio: Buffer.from(String(msg['payload'] ?? ''), 'base64') };
        case 'dtmf':
          return { event: 'dtmf', digit: String(msg['digit'] ?? '') };
        case 'mark':
          return { event: 'mark', name: String(msg['name'] ?? '') };
        case 'stop':
          return { event: 'stop', reason: msg['reason'] ? String(msg['reason']) : null };
        default:
          return { event: 'unknown', raw: msg };
      }
    },
    buildMediaFrames: (streamSid, pcm16) => [JSON.stringify({ event: 'media', streamSid, payload: pcm16.toString('base64') })],
    buildClear: (streamSid) => JSON.stringify({ event: 'clear', streamSid }),
    buildMark: (streamSid, name) => JSON.stringify({ event: 'mark', streamSid, name }),
    async transferToStaff(providerCallSid, phoneNumber) {
      transfers.push({ providerCallSid, phoneNumber });
    },
  };
}

export const mockTelephony: MockTelephonyAdapter = createMockTelephony();
