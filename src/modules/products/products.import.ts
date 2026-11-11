// CSV import analysis for the product catalogue — pure functions, no I/O.
import type { ImportRowError, ImportSummary } from '../customers/customers.types.ts';
import { summarise } from '../customers/customers.import.ts';
import { productDuplicateKey } from './products.rules.ts';
import { createProductSchema, type CreateProductInput } from './products.validation.ts';

export const PRODUCT_CSV_REQUIRED = ['sku', 'name', 'pack_size'] as const;
export const PRODUCT_CSV_COLUMNS = [
  ...PRODUCT_CSV_REQUIRED,
  'brand',
  'generic_name',
  'strength',
  'form',
  'unit',
  'manufacturer',
  'mrp', // rupees, e.g. 32.50 → stored as paise
  'ptr', // rupees
  'gst_rate', // percent
  'status', // active | inactive | discontinued
] as const;

export interface ExistingProductRef {
  id: string;
  externalCode: string;
  duplicateKey: string;
}

export interface ProductImportRow {
  row: number;
  action?: 'create' | 'update';
  externalCode?: string;
  existingId?: string;
  input?: CreateProductInput;
  errors: ImportRowError[];
}

export interface ProductImportPlan {
  summary: ImportSummary;
  rows: ProductImportRow[];
}

const blank = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/** Rupees text → integer paise; non-numeric text becomes NaN so validation reports it. */
export function rupeesToPaise(text: string | undefined): number | undefined {
  if (blank(text) === undefined) return undefined;
  const n = Number(text!.replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
}

export function csvRowToProductInput(row: Record<string, string>): unknown {
  const gst = blank(row['gst_rate']);
  return {
    externalCode: blank(row['sku']),
    name: blank(row['name']),
    brand: blank(row['brand']),
    genericName: blank(row['generic_name']),
    strength: blank(row['strength']),
    form: blank(row['form']?.toLowerCase()),
    packSize: blank(row['pack_size']),
    unit: blank(row['unit']?.toLowerCase()),
    manufacturer: blank(row['manufacturer']),
    mrpPaise: rupeesToPaise(row['mrp']),
    ptrPaise: rupeesToPaise(row['ptr']),
    gstRate: gst === undefined ? undefined : Number(gst.replace('%', '')),
    status: blank(row['status']?.toLowerCase()),
  };
}

export function analyzeProductImport(rows: Record<string, string>[], existing: ExistingProductRef[]): ProductImportPlan {
  const byCode = new Map(existing.map((e) => [e.externalCode.toLowerCase(), e]));
  const byKey = new Map(existing.map((e) => [e.duplicateKey, e]));
  const seenCodes = new Map<string, number>();
  const seenKeys = new Map<string, number>();

  const planned = rows.map((raw, index): ProductImportRow => {
    const row = index + 2;
    const parsed = createProductSchema.safeParse(csvRowToProductInput(raw));
    if (!parsed.success) {
      return {
        row,
        externalCode: blank(raw['sku']),
        errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      };
    }

    const input = parsed.data;
    const errors: ImportRowError[] = [];
    const codeKey = input.externalCode.toLowerCase();
    const current = byCode.get(codeKey);
    const key = productDuplicateKey(input);

    const earlierCode = seenCodes.get(codeKey);
    if (earlierCode !== undefined) errors.push({ field: 'sku', message: `Duplicate sku, first seen on row ${earlierCode}` });
    else seenCodes.set(codeKey, row);

    const earlierKey = seenKeys.get(key);
    if (earlierKey !== undefined && earlierKey !== row) {
      errors.push({ message: `Same product (name, strength, pack size, manufacturer) as row ${earlierKey}` });
    } else seenKeys.set(key, row);

    const sameKey = byKey.get(key);
    if (sameKey && sameKey.id !== current?.id) {
      errors.push({ message: `Same product as existing SKU ${sameKey.externalCode}` });
    }

    return { row, action: current ? 'update' : 'create', externalCode: input.externalCode, existingId: current?.id, input, errors };
  });

  return { summary: summarise(planned), rows: planned };
}
