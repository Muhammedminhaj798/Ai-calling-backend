import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.ts';
import { validate } from '../../middleware/validate.ts';
import { customersController as ctrl } from './customers.controller.ts';
import {
  addressParamsSchema,
  addressSchema,
  createCustomerSchema,
  idParamSchema,
  importQuerySchema,
  listCustomersSchema,
  phoneParamSchema,
  updateAddressSchema,
  updateCustomerSchema,
} from './customers.validation.ts';

const read = requireRole('admin', 'staff', 'approver');
const write = requireRole('admin', 'approver');
const importer = requireRole('admin');

export const customersRouter = Router();
customersRouter.use(requireAuth);

customersRouter.get('/', read, validate({ query: listCustomersSchema }), ctrl.list);
customersRouter.post('/', write, validate({ body: createCustomerSchema }), ctrl.create);
customersRouter.get('/phone/:phone', read, validate({ params: phoneParamSchema }), ctrl.findByPhone);
customersRouter.post('/import/preview', importer, ctrl.previewImport);
customersRouter.post('/import', importer, validate({ query: importQuerySchema }), ctrl.runImport);
customersRouter.get('/:id', read, validate({ params: idParamSchema }), ctrl.getById);
customersRouter.patch('/:id', write, validate({ params: idParamSchema, body: updateCustomerSchema }), ctrl.update);
customersRouter.post('/:id/addresses', write, validate({ params: idParamSchema, body: addressSchema }), ctrl.addAddress);
customersRouter.patch('/:id/addresses/:addressId', write, validate({ params: addressParamsSchema, body: updateAddressSchema }), ctrl.updateAddress);
customersRouter.delete('/:id/addresses/:addressId', write, validate({ params: addressParamsSchema }), ctrl.deleteAddress);
