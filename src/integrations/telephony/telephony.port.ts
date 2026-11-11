// Telephony port (ARCHITECTURE.md §B.3): webhooks for call lifecycle and a bidirectional media stream.
// The Exotel adapter implements the Voicebot applet protocol; the mock adapter speaks plain JSON for tests.

export interface IncomingCallEvent {
  providerCallSid: string;
  fromNumber: string;
  toNumber: string;
  raw: unknown;
}

export interface CallStatusEvent {
  providerCallSid: string;
  /** Provider status as reported, lower-cased (completed, failed, busy, no-answer, …) */
  status: string;
  durationSeconds: number | null;
  recordingUrl: string | null;
  raw: unknown;
}

export type MediaMessage =
  | { event: 'connected' }
  | { event: 'start'; streamSid: string; callSid: string | null; fromNumber: string | null; toNumber: string | null; sampleRate: number; custom: Record<string, string> }
  | { event: 'media'; audio: Buffer }
  | { event: 'dtmf'; digit: string }
  | { event: 'mark'; name: string }
  | { event: 'stop'; reason: string | null }
  | { event: 'unknown'; raw: unknown };

export interface WebhookRequest {
  ip: string | undefined;
  /** Secret token from the URL path the provider was configured with */
  secret: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

export class TelephonyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TelephonyError';
  }
}

export interface TelephonyAdapter {
  readonly name: 'mock' | 'exotel';
  /** Audio format of the media stream */
  readonly sampleRate: 8000 | 16000;
  verifyWebhook(req: WebhookRequest): boolean;
  parseIncoming(body: Record<string, unknown>): IncomingCallEvent;
  parseStatus(body: Record<string, unknown>): CallStatusEvent;
  parseMediaMessage(raw: string | Buffer): MediaMessage;
  /** Splits PCM16 audio into provider-sized outbound messages (JSON strings). */
  buildMediaFrames(streamSid: string, pcm16: Buffer): string[];
  buildClear(streamSid: string): string;
  buildMark(streamSid: string, name: string): string;
  /** Warm transfer of the live call to a staff number. */
  transferToStaff(providerCallSid: string, phoneNumber: string): Promise<void>;
}
