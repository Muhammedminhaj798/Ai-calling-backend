// Shared by the API (POST /api/voice/sessions) and the LiveKit voice worker: the request body, the room-name
// format and the dispatch metadata, which is the only job input the worker acts on.
import { z } from 'zod';
import { Language } from '../../generated/prisma/enums.ts';
import { phoneSchema } from '../customers/customers.validation.ts';

/** `calls.provider` of a LiveKit browser call. Its conversation session lives in the voice worker. */
export const LIVEKIT_PROVIDER = 'livekit';

/** Seconds the browser has to join with its token; the room and the waiting worker give up after the same time. */
export const JOIN_WINDOW_SECONDS = 300;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROOM_NAME = new RegExp(`^call-${UUID}$`);

export const roomNameFor = (id: string) => `call-${id}`;

export const startVoiceSessionSchema = z.object({
  /** The customer phone number the call is placed as (the browser has no caller ID). */
  fromNumber: phoneSchema,
  language: z.enum(Language).optional(),
});
export type StartVoiceSessionInput = z.infer<typeof startVoiceSessionSchema>;

/** Dispatch metadata written by the API. The worker only listens to `participantIdentity`. */
export const voiceJobSchema = z.object({
  fromNumber: phoneSchema,
  language: z.enum(Language).optional(),
  participantIdentity: z.string().regex(new RegExp(`^staff-${UUID}-[0-9a-f]{8}$`)),
});
export type VoiceJob = z.infer<typeof voiceJobSchema>;

/** Validates a dispatched job. Reasons name what failed, never the values. */
export function parseVoiceJob(roomName: string | undefined, metadata: string | undefined): { ok: true; roomName: string; job: VoiceJob } | { ok: false; reason: string } {
  if (!roomName || !ROOM_NAME.test(roomName)) return { ok: false, reason: 'room name is not a voice-call room' };
  let raw: unknown;
  try {
    raw = JSON.parse(metadata ?? '');
  } catch {
    return { ok: false, reason: 'metadata is not JSON' };
  }
  const parsed = voiceJobSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `metadata invalid: ${parsed.error.issues.map((i) => i.path.join('.') || 'root').join(', ')}` };
  return { ok: true, roomName, job: parsed.data };
}
