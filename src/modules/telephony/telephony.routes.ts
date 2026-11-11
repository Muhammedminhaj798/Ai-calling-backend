// Provider webhooks live outside /api and outside JWT auth; the adapter verifies each request
// (URL secret + optional IP allow-list for Exotel). Mounted at /webhooks/telephony by app.ts.
import { Router } from 'express';
import { telephonyController as ctrl } from './telephony.controller.ts';

export const telephonyWebhooksRouter = Router();
telephonyWebhooksRouter.post('/:provider/:secret/incoming', ctrl.incoming);
telephonyWebhooksRouter.post('/:provider/:secret/status', ctrl.status);
