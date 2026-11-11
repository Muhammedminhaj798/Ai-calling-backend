import { z } from 'zod';
import { CustomerStatus, Language } from '../../generated/prisma/enums.ts';
import { paginationSchema } from '../../utils/pagination.ts';
import { normalizePhone } from '../../utils/phone.ts';

const nonEmpty = (o: object) => Object.keys(o).length > 0;

/** Accepts common Indian and international spellings and normalises to E.164. */
export const phoneSchema = z
  .string()
  .trim()
  .min(5)
  .max(20)
  .transform((value, ctx) => {
    const normalised = normalizePhone(value);
    if (!normalised) {
      ctx.addIssue({ code: 'custom', message: 'Invalid phone number' });
      return z.NEVER;
    }
    return normalised;
  });

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// Field definitions carry no defaults. Defaults are added only in the create schemas, so that a partial
// update never silently resets a field (e.g. PATCH { name } must not set status back to `active`).
const addressFields = {
  label: z.string().trim().min(1).max(50),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Pincode must be 6 digits'),
  isDefault: z.boolean(),
};

export const addressSchema = z.object({
  ...addressFields,
  label: addressFields.label.default('Default'),
  isDefault: addressFields.isDefault.default(false),
});
export type AddressInput = z.infer<typeof addressSchema>;

export const updateAddressSchema = z.object(addressFields).partial().refine(nonEmpty, { message: 'No fields to update' });

const customerFields = {
  externalCode: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  phonePrimary: phoneSchema,
  phoneAlternates: z.array(phoneSchema).max(5),
  email: emailSchema.optional(),
  gstin: z.string().trim().toUpperCase().regex(GSTIN, 'Invalid GSTIN').optional(),
  drugLicenseNo: z.string().trim().min(1).max(64).optional(),
  preferredLanguage: z.enum(Language),
  status: z.enum(CustomerStatus),
};

export const createCustomerSchema = z.object({
  ...customerFields,
  phoneAlternates: customerFields.phoneAlternates.default([]),
  preferredLanguage: customerFields.preferredLanguage.default('en'),
  status: customerFields.status.default('active'),
  addresses: z.array(addressSchema).max(10).default([]),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

/** Every field optional, no defaults: only the keys sent are updated. */
export const updateCustomerSchema = z.object(customerFields).partial().refine(nonEmpty, { message: 'No fields to update' });
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const listCustomersSchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(CustomerStatus).optional(),
  preferredLanguage: z.enum(Language).optional(),
  sort: z.string().trim().max(30).optional(),
});
export type ListCustomersQuery = z.infer<typeof listCustomersSchema>;

export const idParamSchema = z.object({ id: z.uuid() });
export const phoneParamSchema = z.object({ phone: phoneSchema });
export const addressParamsSchema = z.object({ id: z.uuid(), addressId: z.uuid() });

export const importQuerySchema = z.object({
  /** strict=true rejects the whole file when any row has an error; default applies the valid rows. */
  strict: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
export type ImportQuery = z.infer<typeof importQuerySchema>;
