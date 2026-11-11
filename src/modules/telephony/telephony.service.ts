// Maps provider call events onto conversation sessions.
import { env } from '../../config/env.ts';
import { createExotelTelephony } from '../../integrations/telephony/exotel.adapter.ts';
import { mockTelephony } from '../../integrations/telephony/mock.adapter.ts';
import type { CallStatusEvent, IncomingCallEvent, TelephonyAdapter } from '../../integrations/telephony/telephony.port.ts';
import type { RequestMeta } from '../../utils/audit.ts';
import { logger } from '../../utils/logger.ts';
import { callsRepository } from '../calls/calls.repository.ts';
import { callsService, type StartedSession } from '../calls/calls.service.ts';
import { sessionRegistry } from '../calls/session.registry.ts';

let adapter: TelephonyAdapter | undefined;

export function getTelephonyAdapter(): TelephonyAdapter {
  if (!adapter) {
    adapter = env.TELEPHONY_PROVIDER === 'exotel'
      ? createExotelTelephony({ webhookSecret: env.EXOTEL_WEBHOOK_SECRET!, allowedIps: (env.EXOTEL_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean) })
      : mockTelephony;
  }
  return adapter;
}

const FINAL_STATUSES = new Set(['completed', 'failed', 'busy', 'no-answer', 'no_answer', 'canceled', 'cancelled']);

export const telephonyService = {
  /** Incoming-call webhook: open the session now so the greeting is ready when the media stream starts. */
  handleIncoming(event: IncomingCallEvent, meta?: RequestMeta): Promise<StartedSession> {
    return callsService.startSession({ provider: getTelephonyAdapter().name, providerCallSid: event.providerCallSid, fromNumber: event.fromNumber, toNumber: event.toNumber }, meta);
  },

  /** Status webhook: duration and recording, and closes the session when the provider says the call is over. */
  async handleStatus(event: CallStatusEvent, meta?: RequestMeta): Promise<{ callId: string | null; ended: boolean }> {
    const call = await callsRepository.findByProviderSid(event.providerCallSid);
    if (!call) {
      logger.warn('telephony.status_for_unknown_call', { providerCallSid: event.providerCallSid, status: event.status });
      return { callId: null, ended: false };
    }
    await callsRepository.update(call.id, {
      ...(event.durationSeconds !== null ? { durationSeconds: event.durationSeconds } : {}),
      ...(event.recordingUrl ? { recordingUrl: event.recordingUrl } : {}),
    });
    await callsRepository.addEvent({ callId: call.id, type: 'provider_status', data: { status: event.status, durationSeconds: event.durationSeconds, recording: Boolean(event.recordingUrl) } });
    if (FINAL_STATUSES.has(event.status) && sessionRegistry.get(call.id)) {
      await callsService.endSession(call.id, event.status === 'completed' ? 'caller_hangup' : 'provider_error', meta);
      return { callId: call.id, ended: true };
    }
    return { callId: call.id, ended: false };
  },

  /** Transfer the live call to staff, if the provider supports it. Failure is recorded, never thrown. */
  async transferToStaff(callId: string, providerCallSid: string): Promise<boolean> {
    if (!env.HANDOVER_PHONE_NUMBER) {
      await callsRepository.addEvent({ callId, type: 'handover_transfer_skipped', ok: false, data: { reason: 'HANDOVER_PHONE_NUMBER not configured' } });
      return false;
    }
    try {
      await getTelephonyAdapter().transferToStaff(providerCallSid, env.HANDOVER_PHONE_NUMBER);
      await callsRepository.addEvent({ callId, type: 'handover_transferred', ok: true, data: { to: env.HANDOVER_PHONE_NUMBER } });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('telephony.transfer_failed', { callId, message });
      await callsRepository.addEvent({ callId, type: 'handover_transfer_failed', ok: false, data: { message } });
      return false;
    }
  },
};
