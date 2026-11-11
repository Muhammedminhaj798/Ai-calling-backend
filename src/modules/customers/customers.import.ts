// CSV import analysis for customers — pure functions, no I/O. The service feeds in the parsed rows
// and the existing customer references, gets back a per-row plan with errors, and applies it.
import type { ImportRowError, ImportSummary } from './customers.types.ts';
import { createCustomerSchema, type CreateCustomerInput } from './customers.validation.ts';

export const CUSTOMER_CSV_REQUIRED = ['external_code', 'name', 'phone_primary'] as const;
export const CUSTOMER_CSV_COLUMNS = [
  ...CUSTOMER_CSV_REQUIRED,
  'phone_alternates', // separated by ; or |
  'email',
  'gstin',
  'drug_license_no',
  'preferred_language', // en | ml | ta | hi
  'status', // active | inactive | blocked
  'address_label',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'pincode',
] as const;

export interface ExistingCustomerRef {
  id: string;
  externalCode: string;
  phones: string[];
}

export interface CustomerImportRow {
  /** 1-based line number in the file (header is line 1) */
  row: number;
  action?: 'create' | 'update';
  externalCode?: string;
  existingId?: string;
  input?: CreateCustomerInput;
  errors: ImportRowError[];
}

export interface CustomerImportPlan {
  summary: ImportSummary;
  rows: CustomerImportRow[];
}

const blank = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/** Maps one CSV record (lower-cased headers) to the shape createCustomerSchema expects. */
export function csvRowToCustomerInput(row: Record<string, string>): unknown {
  const hasAddress = Boolean(blank(row['address_line1']));
  return {
    externalCode: blank(row['external_code']),
    name: blank(row['name']),
    phonePrimary: blank(row['phone_primary']),
    phoneAlternates: blank(row['phone_alternates'])
      ? row['phone_alternates']!.split(/[;|]/).map((p) => p.trim()).filter(Boolean)
      : [],
    email: blank(row['email']),
    gstin: blank(row['gstin']),
    drugLicenseNo: blank(row['drug_license_no']),
    preferredLanguage: blank(row['preferred_language']?.toLowerCase()),
    status: blank(row['status']?.toLowerCase()),
    addresses: hasAddress
      ? [
          {
            label: blank(row['address_label']) ?? 'Default',
            line1: row['address_line1'],
            line2: blank(row['address_line2']),
            city: blank(row['city']),
            state: blank(row['state']),
            pincode: blank(row['pincode']),
            isDefault: true,
          },
        ]
      : [],
  };
}

export function analyzeCustomerImport(
  rows: Record<string, string>[],
  existing: ExistingCustomerRef[],
): CustomerImportPlan {
  const byCode = new Map(existing.map((e) => [e.externalCode.toLowerCase(), e]));
  const phoneOwner = new Map<string, string>();
  for (const e of existing) for (const p of e.phones) phoneOwner.set(p, e.id);

  const seenCodes = new Map<string, number>();
  const seenPhones = new Map<string, number>();

  const planned = rows.map((raw, index): CustomerImportRow => {
    const row = index + 2;
    const parsed = createCustomerSchema.safeParse(csvRowToCustomerInput(raw));
    if (!parsed.success) {
      return {
        row,
        externalCode: blank(raw['external_code']),
        errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      };
    }

    const input = parsed.data;
    const errors: ImportRowError[] = [];
    const codeKey = input.externalCode.toLowerCase();
    const current = byCode.get(codeKey);

    const earlier = seenCodes.get(codeKey);
    if (earlier !== undefined) errors.push({ field: 'external_code', message: `Duplicate external_code, first seen on row ${earlier}` });
    else seenCodes.set(codeKey, row);

    for (const phone of [input.phonePrimary, ...input.phoneAlternates]) {
      const seenAt = seenPhones.get(phone);
      if (seenAt !== undefined && seenAt !== row) {
        errors.push({ field: 'phone', message: `Phone ${phone} also appears on row ${seenAt}` });
      } else seenPhones.set(phone, row);

      const owner = phoneOwner.get(phone);
      if (owner && owner !== current?.id) {
        errors.push({ field: 'phone', message: `Phone ${phone} is registered to another customer` });
      }
    }

    return {
      row,
      action: current ? 'update' : 'create',
      externalCode: input.externalCode,
      existingId: current?.id,
      input,
      errors,
    };
  });

  return { summary: summarise(planned), rows: planned };
}

export function summarise(rows: { action?: 'create' | 'update'; errors: ImportRowError[] }[]): ImportSummary {
  const ok = rows.filter((r) => r.errors.length === 0);
  return {
    total: rows.length,
    create: ok.filter((r) => r.action === 'create').length,
    update: ok.filter((r) => r.action === 'update').length,
    error: rows.length - ok.length,
  };
}
