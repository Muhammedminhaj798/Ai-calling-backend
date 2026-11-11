import type { RequestHandler } from 'express';
import { currentUser } from '../../middleware/auth.ts';
import { requestMeta } from '../../utils/audit.ts';
import { customersService as service } from './customers.service.ts';
import type { AddressInput, CreateCustomerInput, ImportQuery, ListCustomersQuery, UpdateCustomerInput } from './customers.validation.ts';

type Input = { params?: Record<string, string>; query?: unknown; body?: unknown };
const input = (res: Parameters<RequestHandler>[1]): Input => res.locals['input'] as Input;

const list: RequestHandler = async (_req, res) => {
  res.json(await service.list(input(res).query as ListCustomersQuery));
};

const getById: RequestHandler = async (_req, res) => {
  res.json({ customer: await service.getById(input(res).params!['id']!) });
};

const findByPhone: RequestHandler = async (_req, res) => {
  res.json(await service.findByPhone(input(res).params!['phone']!));
};

const create: RequestHandler = async (req, res) => {
  const customer = await service.create(input(res).body as CreateCustomerInput, currentUser(res), requestMeta(req, res));
  res.status(201).json({ customer });
};

const update: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ customer: await service.update(params!['id']!, body as UpdateCustomerInput, currentUser(res), requestMeta(req, res)) });
};

const addAddress: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  const address = await service.addAddress(params!['id']!, body as AddressInput, currentUser(res), requestMeta(req, res));
  res.status(201).json({ address });
};

const updateAddress: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  const address = await service.updateAddress(params!['id']!, params!['addressId']!, body as Partial<AddressInput>, currentUser(res), requestMeta(req, res));
  res.json({ address });
};

const deleteAddress: RequestHandler = async (req, res) => {
  const { params } = input(res);
  await service.deleteAddress(params!['id']!, params!['addressId']!, currentUser(res), requestMeta(req, res));
  res.status(204).end();
};

const previewImport: RequestHandler = async (req, res) => {
  res.json(await service.previewImport(req.body));
};

const runImport: RequestHandler = async (req, res) => {
  const { strict } = input(res).query as ImportQuery;
  res.json(await service.import(req.body, strict, currentUser(res), requestMeta(req, res)));
};

export const customersController = { list, getById, findByPhone, create, update, addAddress, updateAddress, deleteAddress, previewImport, runImport };
