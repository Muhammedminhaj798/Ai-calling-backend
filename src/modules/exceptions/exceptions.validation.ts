import { z } from 'zod';
import { ExceptionStatus, ExceptionType } from '../../generated/prisma/enums.ts';
import { paginationSchema } from '../../utils/pagination.ts';

const nonEmpty = (o: object) => Object.keys(o).length > 0;

export const createExceptionSchema = z.object({
  type: z.enum(ExceptionType),
  description: z.string().trim().min(3).max(2000),
  callId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  orderItemId: z.uuid().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type CreateExceptionInput = z.infer<typeof createExceptionSchema>;

export const listExceptionsSchema = paginationSchema.extend({
  status: z.enum(ExceptionStatus).optional(),
  type: z.enum(ExceptionType).optional(),
  orderId: z.uuid().optional(),
  callId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  /** "me", "unassigned" or a staff user id */
  assignedTo: z.union([z.literal('me'), z.literal('unassigned'), z.uuid()]).optional(),
  sort: z.string().trim().max(30).optional(),
});
export type ListExceptionsQuery = z.infer<typeof listExceptionsSchema>;

export const updateExceptionSchema = z
  .object({
    /** Resolution and dismissal go through /resolve */
    status: z.enum(['open', 'in_progress']).optional(),
    description: z.string().trim().min(3).max(2000).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(nonEmpty, { message: 'No fields to update' });
export type UpdateExceptionInput = z.infer<typeof updateExceptionSchema>;

export const assignExceptionSchema = z.object({
  /** null unassigns */
  assigneeId: z.uuid().nullable(),
});
export type AssignExceptionInput = z.infer<typeof assignExceptionSchema>;

export const resolveExceptionSchema = z.object({
  status: z.enum(['resolved', 'dismissed']).default('resolved'),
  resolutionNote: z.string().trim().min(3).max(2000),
});
export type ResolveExceptionInput = z.infer<typeof resolveExceptionSchema>;

export const idParamSchema = z.object({ id: z.uuid() });
