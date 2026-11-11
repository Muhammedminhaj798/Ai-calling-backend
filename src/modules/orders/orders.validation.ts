import { z } from 'zod';
import { ConfirmationSource, OrderStatus } from '../../generated/prisma/enums.ts';
import { paginationSchema } from '../../utils/pagination.ts';

const nonEmpty = (o: object) => Object.keys(o).length > 0;

/** What the customer confirmed verbally; the server checks it against the catalogue row (case-insensitive). */
const confirmedDetailsSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    strength: z.string().trim().min(1).max(50).optional(),
    packSize: z.string().trim().min(1).max(50).optional(),
  })
  .optional();

export const addItemSchema = z
  .object({
    /** Catalogue product. Omit only for an unresolved request, together with flagReason. */
    productId: z.uuid().optional(),
    /** The customer's words, verbatim */
    requestedText: z.string().trim().min(1).max(300),
    quantity: z.number().int().min(1).max(100_000),
    confirmedDetails: confirmedDetailsSchema,
    /** Why the line has no catalogue product: unresolved name, ambiguous, unavailable, or stock could not be verified */
    flagReason: z.enum(['product_not_found', 'ambiguous_product', 'out_of_stock', 'stock_unverified']).optional(),
  })
  .refine((i) => Boolean(i.productId) !== Boolean(i.flagReason), {
    message: 'Provide productId for a resolved line, or flagReason (without productId) for an unresolved request',
  });
export type AddItemInput = z.infer<typeof addItemSchema>;
export type FlagReason = NonNullable<AddItemInput['flagReason']>;

export const updateItemSchema = z
  .object({
    quantity: z.number().int().min(1).max(100_000).optional(),
    /** Resolves a flagged line (or re-points a line) to a catalogue product */
    productId: z.uuid().optional(),
    requestedText: z.string().trim().min(1).max(300).optional(),
    confirmedDetails: confirmedDetailsSchema,
  })
  .refine(nonEmpty, { message: 'No fields to update' });
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export const createOrderSchema = z.object({
  customerId: z.uuid(),
  callId: z.uuid().optional(),
  /** One of the customer's delivery addresses, confirmed with them */
  deliveryAddressId: z.uuid().optional(),
  customerPoReference: z.string().trim().min(1).max(64).optional(),
  notes: z.string().trim().max(1000).optional(),
  items: z.array(addItemSchema).max(100).default([]),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const updateOrderSchema = z
  .object({
    customerPoReference: z.string().trim().min(1).max(64).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine(nonEmpty, { message: 'No fields to update' });
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

export const confirmOrderSchema = z.object({
  /** Must equal the order's current revision — the one that was read back */
  revision: z.number().int().min(1),
  source: z.enum(ConfirmationSource),
  /** Lines the customer declined during read-back */
  declinedItemIds: z.array(z.uuid()).max(100).default([]),
  /** Optional; the Idempotency-Key header is used when the body has none */
  idempotencyKey: z.string().min(8).max(128).optional(),
});
export type ConfirmOrderInput = z.infer<typeof confirmOrderSchema>;

export const cancelOrderSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const releaseSchema = z.object({ reason: z.string().trim().min(3).max(500).optional() }).optional();

export const listOrdersSchema = paginationSchema.extend({
  status: z.enum(OrderStatus).optional(),
  customerId: z.uuid().optional(),
  callId: z.uuid().optional(),
  /** Order number contains */
  q: z.string().trim().min(1).max(64).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  sort: z.string().trim().max(30).optional(),
});
export type ListOrdersQuery = z.infer<typeof listOrdersSchema>;

export const idParamSchema = z.object({ id: z.uuid() });
export const itemParamsSchema = z.object({ id: z.uuid(), itemId: z.uuid() });

/** Idempotency-Key header value, when present and sane */
export function idempotencyKeyFrom(header: string | undefined): string | undefined {
  const key = header?.trim();
  return key && key.length >= 8 && key.length <= 128 ? key : undefined;
}
