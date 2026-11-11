import type { RequestHandler } from 'express';
import { currentUser } from '../../middleware/auth.ts';
import { requestMeta } from '../../utils/audit.ts';
import { exceptionsService as service } from './exceptions.service.ts';
import type { AssignExceptionInput, CreateExceptionInput, ListExceptionsQuery, ResolveExceptionInput, UpdateExceptionInput } from './exceptions.validation.ts';

type Input = { params?: Record<string, string>; query?: unknown; body?: unknown };
const input = (res: Parameters<RequestHandler>[1]): Input => res.locals['input'] as Input;

const list: RequestHandler = async (_req, res) => {
  res.json(await service.list(input(res).query as ListExceptionsQuery, currentUser(res)));
};

const create: RequestHandler = async (req, res) => {
  res.status(201).json({ exception: await service.create(input(res).body as CreateExceptionInput, currentUser(res), requestMeta(req, res)) });
};

const getById: RequestHandler = async (_req, res) => {
  res.json({ exception: await service.get(input(res).params!['id']!) });
};

const update: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ exception: await service.update(params!['id']!, body as UpdateExceptionInput, currentUser(res), requestMeta(req, res)) });
};

const assign: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ exception: await service.assign(params!['id']!, body as AssignExceptionInput, currentUser(res), requestMeta(req, res)) });
};

const resolve: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ exception: await service.resolve(params!['id']!, body as ResolveExceptionInput, currentUser(res), requestMeta(req, res)) });
};

export const exceptionsController = { list, create, getById, update, assign, resolve };
