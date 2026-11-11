import { z } from 'zod';
import { CallStatus, ConversationState, Language } from '../../generated/prisma/enums.ts';
import { paginationSchema } from '../../utils/pagination.ts';
import { phoneSchema } from '../customers/customers.validation.ts';

export const listCallsSchema = paginationSchema.extend({
  status: z.enum(CallStatus).optional(),
  conversationState: z.enum(ConversationState).optional(),
  customerId: z.uuid().optional(),
  provider: z.string().trim().min(1).max(30).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  sort: z.string().trim().max(30).optional(),
});
export type ListCallsQuery = z.infer<typeof listCallsSchema>;

export const idParamSchema = z.object({ id: z.uuid() });

export const eventsQuerySchema = z.object({
  type: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});
export type EventsQuery = z.infer<typeof eventsQuerySchema>;

/** Text simulation of a call (no telephony): lets staff and tests drive the conversation engine. */
export const startSimulationSchema = z.object({
  fromNumber: phoneSchema,
  language: z.enum(Language).optional(),
});
export type StartSimulationInput = z.infer<typeof startSimulationSchema>;

export const turnSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  language: z.enum(Language).optional(),
});
export type TurnInput = z.infer<typeof turnSchema>;

export const endSchema = z.object({ reason: z.enum(['caller_hangup', 'completed', 'operator']).default('operator') }).optional();
export type EndInput = z.infer<typeof endSchema>;
