import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.ts';
import { validate } from '../../middleware/validate.ts';
import { productsController as ctrl } from './products.controller.ts';
import {
  createProductSchema,
  idParamSchema,
  importQuerySchema,
  listProductsSchema,
  searchProductsSchema,
  updateProductSchema,
} from './products.validation.ts';

const read = requireRole('admin', 'staff', 'approver');
const write = requireRole('admin', 'approver');
const importer = requireRole('admin');

export const productsRouter = Router();
productsRouter.use(requireAuth);

productsRouter.get('/', read, validate({ query: listProductsSchema }), ctrl.list);
productsRouter.post('/', write, validate({ body: createProductSchema }), ctrl.create);
productsRouter.get('/search', read, validate({ query: searchProductsSchema }), ctrl.search);
productsRouter.post('/import/preview', importer, ctrl.previewImport);
productsRouter.post('/import', importer, validate({ query: importQuerySchema }), ctrl.runImport);
productsRouter.get('/:id', read, validate({ params: idParamSchema }), ctrl.getById);
productsRouter.patch('/:id', write, validate({ params: idParamSchema, body: updateProductSchema }), ctrl.update);
