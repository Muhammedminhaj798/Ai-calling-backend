import type { RequestHandler } from 'express';
import { currentUser } from '../../middleware/auth.ts';
import { requestMeta } from '../../utils/audit.ts';
import { ordersService as service } from './orders.service.ts';
import { staffActor } from './orders.types.ts';
import {
  idempotencyKeyFrom,
  type AddItemInput,
  type CancelOrderInput,
  type ConfirmOrderInput,
  type CreateOrderInput,
  type ListOrdersQuery,
  type UpdateItemInput,
  type UpdateOrderInput,
} from './orders.validation.ts';
import { reservationsService } from './reservations.service.ts';

type Input = { params?: Record<string, string>; query?: unknown; body?: unknown };
const input = (res: Parameters<RequestHandler>[1]): Input => res.locals['input'] as Input;
const actor = (res: Parameters<RequestHandler>[1]) => staffActor(currentUser(res));

const list: RequestHandler = async (_req, res) => {
  res.json(await service.list(input(res).query as ListOrdersQuery));
};

const create: RequestHandler = async (req, res) => {
  const order = await service.create(input(res).body as CreateOrderInput, actor(res), requestMeta(req, res), idempotencyKeyFrom(req.header('idempotency-key')));
  res.status(201).json({ order });
};

const getById: RequestHandler = async (_req, res) => {
  res.json({ order: await service.getDetail(input(res).params!['id']!) });
};

const update: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ order: await service.updateMeta(params!['id']!, body as UpdateOrderInput, actor(res), requestMeta(req, res)) });
};

const addItem: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.status(201).json({ order: await service.addItem(params!['id']!, body as AddItemInput, actor(res), requestMeta(req, res)) });
};

const updateItem: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ order: await service.updateItem(params!['id']!, params!['itemId']!, body as UpdateItemInput, actor(res), requestMeta(req, res)) });
};

const removeItem: RequestHandler = async (req, res) => {
  const { params } = input(res);
  res.json({ order: await service.removeItem(params!['id']!, params!['itemId']!, actor(res), requestMeta(req, res)) });
};

const readback: RequestHandler = async (req, res) => {
  res.json({ readback: await service.readback(input(res).params!['id']!, actor(res), requestMeta(req, res)) });
};

const confirm: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  const payload = body as ConfirmOrderInput;
  const idempotencyKey = payload.idempotencyKey ?? idempotencyKeyFrom(req.header('idempotency-key'));
  res.json({ order: await service.confirm(params!['id']!, { ...payload, idempotencyKey }, actor(res), requestMeta(req, res)) });
};

const cancel: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ order: await service.cancel(params!['id']!, body as CancelOrderInput, currentUser(res), requestMeta(req, res)) });
};

const reserve: RequestHandler = async (req, res) => {
  const outcome = await reservationsService.reserve(input(res).params!['id']!, idempotencyKeyFrom(req.header('idempotency-key')), actor(res), requestMeta(req, res));
  res.json(outcome);
};

const listReservations: RequestHandler = async (_req, res) => {
  res.json({ reservations: await reservationsService.list(input(res).params!['id']!) });
};

const release: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  const reason = (body as { reason?: string } | undefined)?.reason;
  res.json(await reservationsService.release(params!['id']!, actor(res), requestMeta(req, res), reason));
};

export const ordersController = { list, create, getById, update, addItem, updateItem, removeItem, readback, confirm, cancel, reserve, listReservations, release };
