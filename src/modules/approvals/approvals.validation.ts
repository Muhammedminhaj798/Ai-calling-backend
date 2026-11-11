import { z } from 'zod';
import { paginationSchema } from '../../utils/pagination.ts';

export const pendingQuerySchema = paginationSchema.extend({
  customerId: z.uuid().optional(),
});
export type PendingQuery = z.infer<typeof pendingQuerySchema>;

export const orderIdParamSchema = z.object({ orderId: z.uuid() });

export const approveSchema = z.object({ note: z.string().trim().max(500).optional() }).optional();
export type ApproveInput = z.infer<typeof approveSchema>;

export const rejectSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type RejectInput = z.infer<typeof rejectSchema>;
