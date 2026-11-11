import { z } from 'zod';
import { ProductStatus } from '../../generated/prisma/enums.ts';
import { paginationSchema } from '../../utils/pagination.ts';

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

// No defaults here; the create schema adds them, so a partial update never resets `status`.
const productFields = {
  externalCode: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  brand: optionalText(100),
  genericName: optionalText(200),
  strength: optionalText(50),
  form: optionalText(50),
  packSize: z.string().trim().min(1).max(50),
  unit: optionalText(30),
  manufacturer: optionalText(150),
  mrpPaise: z.number().int().min(0).optional(),
  ptrPaise: z.number().int().min(0).optional(),
  gstRate: z.number().min(0).max(100).optional(),
  status: z.enum(ProductStatus),
};

export const createProductSchema = z.object({ ...productFields, status: productFields.status.default('active') });
export type CreateProductInput = z.infer<typeof createProductSchema>;

/** Every field optional, no defaults: only the keys sent are updated. */
export const updateProductSchema = z.object(productFields).partial().refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsSchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  strength: z.string().trim().min(1).max(50).optional(),
  form: z.string().trim().min(1).max(50).optional(),
  manufacturer: z.string().trim().min(1).max(150).optional(),
  status: z.enum(ProductStatus).optional(),
  sort: z.string().trim().max(30).optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsSchema>;

export const searchProductsSchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
export type SearchProductsQuery = z.infer<typeof searchProductsSchema>;

export const idParamSchema = z.object({ id: z.uuid() });

export const importQuerySchema = z.object({
  strict: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
export type ImportQuery = z.infer<typeof importQuerySchema>;
