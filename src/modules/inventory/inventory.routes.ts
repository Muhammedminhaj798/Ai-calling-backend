import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.ts';
import { validate } from '../../middleware/validate.ts';
import { inventoryController as ctrl } from './inventory.controller.ts';
import { productIdParamSchema, stockQuerySchema } from './inventory.validation.ts';

export const inventoryRouter = Router();
inventoryRouter.use(requireAuth);
inventoryRouter.get(
  '/:productId',
  requireRole('admin', 'staff', 'approver'),
  validate({ params: productIdParamSchema, query: stockQuerySchema }),
  ctrl.getProductStock,
);
