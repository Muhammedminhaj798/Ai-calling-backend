import type { RequestHandler } from 'express';
import { currentUser } from '../../middleware/auth.ts';
import { requestMeta } from '../../utils/audit.ts';
import { productsService as service } from './products.service.ts';
import type { CreateProductInput, ImportQuery, ListProductsQuery, SearchProductsQuery, UpdateProductInput } from './products.validation.ts';

type Input = { params?: Record<string, string>; query?: unknown; body?: unknown };
const input = (res: Parameters<RequestHandler>[1]): Input => res.locals['input'] as Input;

const list: RequestHandler = async (_req, res) => {
  res.json(await service.list(input(res).query as ListProductsQuery));
};

const search: RequestHandler = async (_req, res) => {
  res.json(await service.search(input(res).query as SearchProductsQuery));
};

const getById: RequestHandler = async (_req, res) => {
  res.json({ product: await service.getById(input(res).params!['id']!) });
};

const create: RequestHandler = async (req, res) => {
  const product = await service.create(input(res).body as CreateProductInput, currentUser(res), requestMeta(req, res));
  res.status(201).json({ product });
};

const update: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ product: await service.update(params!['id']!, body as UpdateProductInput, currentUser(res), requestMeta(req, res)) });
};

const previewImport: RequestHandler = async (req, res) => {
  res.json(await service.previewImport(req.body));
};

const runImport: RequestHandler = async (req, res) => {
  const { strict } = input(res).query as ImportQuery;
  res.json(await service.import(req.body, strict, currentUser(res), requestMeta(req, res)));
};

export const productsController = { list, search, getById, create, update, previewImport, runImport };
