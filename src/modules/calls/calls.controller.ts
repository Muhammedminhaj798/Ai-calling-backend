import type { RequestHandler } from 'express';
import { requestMeta } from '../../utils/audit.ts';
import { callsService as service } from './calls.service.ts';
import type { EndInput, EventsQuery, ListCallsQuery, StartSimulationInput, TurnInput } from './calls.validation.ts';

type Input = { params?: Record<string, string>; query?: unknown; body?: unknown };
const input = (res: Parameters<RequestHandler>[1]): Input => res.locals['input'] as Input;

const list: RequestHandler = async (_req, res) => {
  res.json(await service.list(input(res).query as ListCallsQuery));
};

const detail: RequestHandler = async (_req, res) => {
  res.json({ call: await service.detail(input(res).params!['id']!) });
};

const transcript: RequestHandler = async (_req, res) => {
  res.json({ transcript: await service.transcript(input(res).params!['id']!) });
};

const events: RequestHandler = async (_req, res) => {
  const { params, query } = input(res);
  const q = query as EventsQuery;
  res.json({ events: await service.events(params!['id']!, q.type, q.limit) });
};

const startSimulation: RequestHandler = async (req, res) => {
  const body = input(res).body as StartSimulationInput;
  const started = await service.startSimulation({ fromNumber: body.fromNumber, language: body.language }, requestMeta(req, res));
  res.status(201).json({ callId: started.callId, resumed: started.resumed, greeting: started.greeting });
};

const turn: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  const t = body as TurnInput;
  res.json({ turn: await service.turn(params!['id']!, t.text, { language: t.language, meta: requestMeta(req, res) }) });
};

const end: RequestHandler = async (req, res) => {
  const { params, body } = input(res);
  const reason = (body as EndInput)?.reason ?? 'operator';
  const state = await service.endSession(params!['id']!, reason, requestMeta(req, res));
  res.json({ callId: params!['id'], conversationState: state });
};

export const callsController = { list, detail, transcript, events, startSimulation, turn, end };
