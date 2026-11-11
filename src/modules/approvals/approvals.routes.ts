import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.ts';
import { validate } from '../../middleware/validate.ts';
import { approvalsController as ctrl } from './approvals.controller.ts';
import { approveSchema, orderIdParamSchema, pendingQuerySchema, rejectSchema } from './approvals.validation.ts';

const anyRole = requireRole('admin', 'staff', 'approver');
// Only approvers and admins decide. The AI never reaches these routes: it has no staff token.
const approverPlus = requireRole('admin', 'approver');

export const approvalsRouter = Router();
approvalsRouter.use(requireAuth);

approvalsRouter.get('/pending', anyRole, validate({ query: pendingQuerySchema }), ctrl.listPending);
approvalsRouter.get('/:orderId', anyRole, validate({ params: orderIdParamSchema }), ctrl.review);
approvalsRouter.post('/:orderId/approve', approverPlus, validate({ params: orderIdParamSchema, body: approveSchema }), ctrl.approve);
approvalsRouter.post('/:orderId/reject', approverPlus, validate({ params: orderIdParamSchema, body: rejectSchema }), ctrl.reject);
