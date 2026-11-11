// Human handover manager: records why the conversation needs a person, raises the staff exception and
// moves the session to handover_required. The telephony layer transfers the call when it sees that state.
import type { ExceptionType } from '../../generated/prisma/enums.ts';
import type { Lang } from '../../utils/language.ts';
import type { Actor } from '../orders/orders.types.ts';
import { AI_ACTOR, type ConversationSession, type ToolBackend } from './ai.types.ts';
import { canTransitionConversation } from './conversation.state.ts';

export const HANDOVER_REASONS = [
  'customer_requested',
  'unclear_request',
  'customer_not_registered',
  'customer_not_eligible',
  'inventory_unavailable',
  'provider_error',
  'other',
] as const;
export type HandoverReason = (typeof HANDOVER_REASONS)[number];

const EXCEPTION_TYPES: Record<HandoverReason, ExceptionType> = {
  customer_requested: 'human_handover_required',
  unclear_request: 'human_handover_required',
  customer_not_registered: 'customer_not_registered',
  customer_not_eligible: 'customer_not_eligible',
  inventory_unavailable: 'inventory_api_error',
  provider_error: 'human_handover_required',
  other: 'human_handover_required',
};

export const HANDOVER_TEXT: Record<Lang, string> = {
  en: 'I will connect you to our staff now. Please hold the line.',
  ml: 'ഞാൻ ഇപ്പോൾ നിങ്ങളെ ഞങ്ങളുടെ സ്റ്റാഫുമായി ബന്ധിപ്പിക്കാം. ദയവായി ലൈനിൽ കാത്തിരിക്കൂ.',
  ta: 'உங்களை இப்போது எங்கள் ஊழியர்களுடன் இணைக்கிறேன். தயவுசெய்து காத்திருங்கள்.',
  hi: 'मैं आपको अभी हमारे स्टाफ से जोड़ रहा हूँ। कृपया लाइन पर बने रहें।',
};

export interface HandoverOutcome {
  exceptionId: string | null;
  message: string;
}

/**
 * Raise the exception for staff and mark the session. Safe to call more than once: a session already in
 * handover_required keeps its first reason.
 */
export async function triggerHandover(
  session: ConversationSession,
  backend: ToolBackend,
  reason: HandoverReason,
  details: string | undefined,
  actor: Actor = AI_ACTOR,
): Promise<HandoverOutcome> {
  if (session.handover) return { exceptionId: session.handover.exceptionId, message: HANDOVER_TEXT[session.language] };

  let exceptionId: string | null;
  try {
    const exception = await backend.raiseException(
      {
        type: EXCEPTION_TYPES[reason],
        description: `Human handover requested during call: ${reason}${details ? ` — ${details}` : ''}`,
        callId: session.callId,
        customerId: session.customer?.id ?? null,
        orderId: session.orderId,
        details: { reason, details: details ?? null, fromNumber: session.fromNumber, state: session.state, turns: session.turns },
      },
      actor,
    );
    exceptionId = exception.id;
  } catch {
    // The handover must still happen even if the exception row could not be written; the call event records it.
    exceptionId = null;
  }
  session.handover = { reason: details ? `${reason}: ${details}` : reason, exceptionId };
  if (canTransitionConversation(session.state, 'handover_required')) session.state = 'handover_required';
  return { exceptionId, message: HANDOVER_TEXT[session.language] };
}
