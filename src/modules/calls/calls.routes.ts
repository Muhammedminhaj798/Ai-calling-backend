import { Router } from 'express';
import { env } from '../../config/env.ts';
import { requireAuth, requireRole } from '../../middleware/auth.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { validate } from '../../middleware/validate.ts';
import { callsController as ctrl } from './calls.controller.ts';
import { endSchema, eventsQuerySchema, idParamSchema, listCallsSchema, startSimulationSchema, turnSchema } from './calls.validation.ts';

const anyRole = requireRole('admin', 'staff', 'approver');

/** Dashboard views of conversation sessions. */
export const callsRouter = Router();
callsRouter.use(requireAuth);
callsRouter.get('/', anyRole, validate({ query: listCallsSchema }), ctrl.list);
callsRouter.get('/:id', anyRole, validate({ params: idParamSchema }), ctrl.detail);
callsRouter.get('/:id/transcript', anyRole, validate({ params: idParamSchema }), ctrl.transcript);
callsRouter.get('/:id/events', anyRole, validate({ params: idParamSchema, query: eventsQuerySchema }), ctrl.events);

/**
 * Text simulation of a call: the same engine without telephony, for staff testing and automated tests. Disabled in
 * production (404 before authentication): it would place calls and draft orders as any phone number.
 */
export const conversationsRouter = Router();
conversationsRouter.use((_req, _res, next) => {
  if (env.NODE_ENV === 'production') throw new AppError(404, 'NOT_FOUND', 'Text simulation is disabled in production');
  next();
});
conversationsRouter.use(requireAuth);
conversationsRouter.post('/', anyRole, validate({ body: startSimulationSchema }), ctrl.startSimulation);
conversationsRouter.post('/:id/turns', anyRole, validate({ params: idParamSchema, body: turnSchema }), ctrl.turn);
conversationsRouter.post('/:id/end', anyRole, validate({ params: idParamSchema, body: endSchema }), ctrl.end);
