import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.ts';
import { validate } from '../../middleware/validate.ts';
import { ordersController as ctrl } from './orders.controller.ts';
import {
  addItemSchema,
  cancelOrderSchema,
  confirmOrderSchema,
  createOrderSchema,
  idParamSchema,
  itemParamsSchema,
  listOrdersSchema,
  releaseSchema,
  updateItemSchema,
  updateOrderSchema,
} from './orders.validation.ts';

// Every role takes orders (drafts, lines, read-back, customer confirmation, reservation attempts).
// Releasing reservations is reserved for approvers/admins; cancellation rules by state live in the service.
const anyRole = requireRole('admin', 'staff', 'approver');
const approverPlus = requireRole('admin', 'approver');

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

ordersRouter.get('/', anyRole, validate({ query: listOrdersSchema }), ctrl.list);
ordersRouter.post('/', anyRole, validate({ body: createOrderSchema }), ctrl.create);
ordersRouter.get('/:id', anyRole, validate({ params: idParamSchema }), ctrl.getById);
ordersRouter.patch('/:id', anyRole, validate({ params: idParamSchema, body: updateOrderSchema }), ctrl.update);

ordersRouter.post('/:id/items', anyRole, validate({ params: idParamSchema, body: addItemSchema }), ctrl.addItem);
ordersRouter.patch('/:id/items/:itemId', anyRole, validate({ params: itemParamsSchema, body: updateItemSchema }), ctrl.updateItem);
ordersRouter.delete('/:id/items/:itemId', anyRole, validate({ params: itemParamsSchema }), ctrl.removeItem);

ordersRouter.post('/:id/readback', anyRole, validate({ params: idParamSchema }), ctrl.readback);
ordersRouter.post('/:id/confirm', anyRole, validate({ params: idParamSchema, body: confirmOrderSchema }), ctrl.confirm);
ordersRouter.post('/:id/cancel', anyRole, validate({ params: idParamSchema, body: cancelOrderSchema }), ctrl.cancel);

ordersRouter.post('/:id/reserve', anyRole, validate({ params: idParamSchema }), ctrl.reserve);
ordersRouter.get('/:id/reservations', anyRole, validate({ params: idParamSchema }), ctrl.listReservations);
ordersRouter.post('/:id/release', approverPlus, validate({ params: idParamSchema, body: releaseSchema }), ctrl.release);
