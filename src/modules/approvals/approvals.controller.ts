import type { RequestHandler } from 'express';
import { currentUser } from '../../middleware/auth.ts';
import { requestMeta } from '../../utils/audit.ts';
import { approvalsService as service } from './approvals.service.ts';
import type { ApproveInput, PendingQuery, RejectInput } from './approvals.validation.ts';

type Input = { params?: Record<string, string>; query?: unknown; body?: unknown };
const input = (res: Parameters<RequestHandler>[1]): Input => res.locals['input'] as Input;

const listPending: RequestHandler = async (_req, res) => {
  res.json(await service.listPending(input(res).query as PendingQuery));
};

const review: RequestHandler = async (_req, res) => {
  res.json({ order: await service.review(input(res).params!['orderId']!) });
};

const approve: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ order: await service.approve(params!['orderId']!, body as ApproveInput, currentUser(res), requestMeta(req, res)) });
};

const reject: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  res.json({ order: await service.reject(params!['orderId']!, body as RejectInput, currentUser(res), requestMeta(req, res)) });
};

export const approvalsController = { listPending, review, approve, reject };
