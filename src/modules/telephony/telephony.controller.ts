import type { RequestHandler } from 'express';
import { AppError } from '../../middleware/error-handler.ts';
import { requestMeta } from '../../utils/audit.ts';
import { getTelephonyAdapter, telephonyService } from './telephony.service.ts';

const param = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

function verified(req: Parameters<RequestHandler>[0]) {
  const adapter = getTelephonyAdapter();
  const provider = param(req.params['provider']);
  if (provider !== adapter.name) throw new AppError(404, 'NOT_FOUND', `Telephony provider ${provider} is not configured`);
  if (!adapter.verifyWebhook({ ip: req.ip, secret: param(req.params['secret']), headers: req.headers })) {
    throw new AppError(403, 'WEBHOOK_REJECTED', 'Webhook verification failed');
  }
  return adapter;
}

const incoming: RequestHandler = async (req, res) => {
  const adapter = verified(req);
  const event = adapter.parseIncoming((req.body ?? {}) as Record<string, unknown>);
  const started = await telephonyService.handleIncoming(event, requestMeta(req, res));
  res.json({ callId: started.callId, resumed: started.resumed, conversationState: started.session.state });
};

const status: RequestHandler = async (req, res) => {
  const adapter = verified(req);
  const event = adapter.parseStatus((req.body ?? {}) as Record<string, unknown>);
  res.json(await telephonyService.handleStatus(event, requestMeta(req, res)));
};

export const telephonyController = { incoming, status };
