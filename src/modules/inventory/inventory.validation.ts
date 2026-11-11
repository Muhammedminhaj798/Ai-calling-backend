import { z } from 'zod';

export const productIdParamSchema = z.object({ productId: z.uuid() });

export const stockQuerySchema = z.object({
  /** Quantity the caller wants; when given, the response says whether stock is sufficient. */
  quantity: z.coerce.number().int().min(1).max(1_000_000).optional(),
});
export type StockQuery = z.infer<typeof stockQuerySchema>;
