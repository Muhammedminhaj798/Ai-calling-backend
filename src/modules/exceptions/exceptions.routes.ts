import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.ts';
import { validate } from '../../middleware/validate.ts';
import { exceptionsController as ctrl } from './exceptions.controller.ts';
import {
  assignExceptionSchema,
  createExceptionSchema,
  idParamSchema,
  listExceptionsSchema,
  resolveExceptionSchema,
  updateExceptionSchema,
} from './exceptions.validation.ts';

// Working the exception queue is an everyday staff task, so every role may read, assign and resolve.
const anyRole = requireRole('admin', 'staff', 'approver');

export const exceptionsRouter = Router();
exceptionsRouter.use(requireAuth);

exceptionsRouter.get('/', anyRole, validate({ query: listExceptionsSchema }), ctrl.list);
exceptionsRouter.post('/', anyRole, validate({ body: createExceptionSchema }), ctrl.create);
exceptionsRouter.get('/:id', anyRole, validate({ params: idParamSchema }), ctrl.getById);
exceptionsRouter.patch('/:id', anyRole, validate({ params: idParamSchema, body: updateExceptionSchema }), ctrl.update);
exceptionsRouter.post('/:id/assign', anyRole, validate({ params: idParamSchema, body: assignExceptionSchema }), ctrl.assign);
exceptionsRouter.post('/:id/resolve', anyRole, validate({ params: idParamSchema, body: resolveExceptionSchema }), ctrl.resolve);
