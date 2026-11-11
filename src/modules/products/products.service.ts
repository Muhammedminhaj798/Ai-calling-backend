// Product catalogue rules: duplicate detection, exact-vs-fuzzy search, CSV import.
import type { Prisma, Product } from '../../generated/prisma/client.ts';
import type { AuthUser } from '../../middleware/auth.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { audit, type RequestMeta } from '../../utils/audit.ts';
import { parseCsv } from '../../utils/csv.ts';
import { pageResult, parseSort, skipTake, type Page } from '../../utils/pagination.ts';
import { summarise } from '../customers/customers.import.ts';
import type { ImportResult } from '../customers/customers.types.ts';
import { analyzeProductImport, PRODUCT_CSV_REQUIRED, type ProductImportPlan, type ProductImportRow } from './products.import.ts';
import { productsRepository as repo } from './products.repository.ts';
import { isExactProductMatch, productDuplicateKey, type ProductIdentity } from './products.rules.ts';
import type { ProductSearchResult } from './products.types.ts';
import type { CreateProductInput, ListProductsQuery, SearchProductsQuery, UpdateProductInput } from './products.validation.ts';

const MAX_IMPORT_ROWS = 10_000;
const SORTABLE = ['createdAt', 'name', 'externalCode', 'brand'] as const;

async function assertNotDuplicate(identity: ProductIdentity, externalCode: string | undefined, selfId?: string): Promise<void> {
  if (externalCode) {
    const byCode = await repo.findByExternalCode(externalCode);
    if (byCode && byCode.id !== selfId) {
      throw new AppError(409, 'DUPLICATE_EXTERNAL_CODE', `SKU ${externalCode} already exists`, { conflictingProductId: byCode.id });
    }
  }
  const key = productDuplicateKey(identity);
  const sameKey = (await repo.findByName(identity.name)).find((p) => p.id !== selfId && productDuplicateKey(p) === key);
  if (sameKey) {
    throw new AppError(409, 'DUPLICATE_PRODUCT', 'A product with the same name, strength, pack size and manufacturer already exists', {
      conflictingProductId: sameKey.id,
      conflictingSku: sameKey.externalCode,
    });
  }
}

async function getOrThrow(id: string): Promise<Product> {
  const product = await repo.findById(id);
  if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');
  return product;
}

function parseImportCsv(csvText: unknown): Record<string, string>[] {
  if (typeof csvText !== 'string' || csvText.trim() === '') {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the CSV file as the request body with Content-Type: text/csv');
  }
  const { headers, rows } = parseCsv(csvText);
  const missing = PRODUCT_CSV_REQUIRED.filter((c) => !headers.includes(c));
  if (missing.length > 0) throw new AppError(400, 'CSV_MISSING_COLUMNS', `CSV is missing required columns: ${missing.join(', ')}`, { missing });
  if (rows.length === 0) throw new AppError(400, 'CSV_EMPTY', 'CSV has a header but no data rows');
  if (rows.length > MAX_IMPORT_ROWS) throw new AppError(413, 'CSV_TOO_LARGE', `CSV has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS} per import`);
  return rows;
}

async function planImport(csvText: unknown): Promise<ProductImportPlan> {
  const rows = parseImportCsv(csvText);
  // ponytail: loads every product reference into memory for duplicate detection; fine to ~100k SKUs.
  const existing = (await repo.allRefs()).map((p) => ({ id: p.id, externalCode: p.externalCode, duplicateKey: productDuplicateKey(p) }));
  return analyzeProductImport(rows, existing);
}

export const productsService = {
  async list(query: ListProductsQuery): Promise<Page<Product>> {
    const and: Prisma.ProductWhereInput[] = [];
    if (query.status) and.push({ status: query.status });
    if (query.brand) and.push({ brand: { equals: query.brand, mode: 'insensitive' } });
    if (query.strength) and.push({ strength: { equals: query.strength, mode: 'insensitive' } });
    if (query.form) and.push({ form: { equals: query.form, mode: 'insensitive' } });
    if (query.manufacturer) and.push({ manufacturer: { equals: query.manufacturer, mode: 'insensitive' } });
    if (query.q) {
      and.push({
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { genericName: { contains: query.q, mode: 'insensitive' } },
          { externalCode: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }
    const sort = parseSort(query.sort, SORTABLE, 'createdAt');
    const { skip, take } = skipTake(query);
    const [data, total] = await repo.list(and.length ? { AND: and } : {}, { [sort.field]: sort.direction }, skip, take);
    return pageResult(data, total, query);
  },

  getById: getOrThrow,

  /** Ranked candidates only. Nothing is auto-selected on a fuzzy score (ARCHITECTURE.md §E, medicine validation). */
  async search(query: SearchProductsQuery): Promise<ProductSearchResult> {
    const rows = await repo.search(query.q, query.limit, query.includeInactive);
    const candidates = rows.map((r) => ({ ...r, exact: isExactProductMatch(r, query.q) }));
    const exact = candidates.filter((c) => c.exact);
    return { query: query.q, exactMatch: exact.length === 1 ? exact[0]! : null, candidates };
  },

  async create(input: CreateProductInput, actor: AuthUser, meta: RequestMeta): Promise<Product> {
    await assertNotDuplicate(input, input.externalCode);
    const product = await repo.create(input);
    await audit({ actorType: 'staff', actorId: actor.id, action: 'product.create', entityType: 'product', entityId: product.id, after: input, ...meta });
    return product;
  },

  async update(id: string, input: UpdateProductInput, actor: AuthUser, meta: RequestMeta): Promise<Product> {
    const existing = await getOrThrow(id);
    const identity: ProductIdentity = {
      name: input.name ?? existing.name,
      strength: input.strength ?? existing.strength,
      packSize: input.packSize ?? existing.packSize,
      manufacturer: input.manufacturer ?? existing.manufacturer,
    };
    await assertNotDuplicate(identity, input.externalCode, id);
    const product = await repo.update(id, input);
    const changedKeys = Object.keys(input) as (keyof UpdateProductInput)[];
    await audit({
      actorType: 'staff',
      actorId: actor.id,
      action: input.status && input.status !== existing.status ? 'product.status_change' : 'product.update',
      entityType: 'product',
      entityId: id,
      before: Object.fromEntries(changedKeys.map((k) => [k, existing[k]])),
      after: input,
      ...meta,
    });
    return product;
  },

  previewImport: (csvText: unknown): Promise<ProductImportPlan> => planImport(csvText),

  async import(csvText: unknown, strict: boolean, actor: AuthUser, meta: RequestMeta): Promise<ImportResult<ProductImportRow>> {
    const plan = await planImport(csvText);
    if (strict && plan.summary.error > 0) {
      throw new AppError(400, 'IMPORT_HAS_ERRORS', `${plan.summary.error} row(s) have errors; fix them or import without strict=true`, plan);
    }
    const applied = await repo.applyImport(
      plan.rows,
      (row) => row.input!,
      (row) => row.input!,
    );
    await audit({
      actorType: 'staff',
      actorId: actor.id,
      action: 'product.import',
      entityType: 'product',
      after: { ...applied, skipped: plan.summary.error, rows: plan.summary.total },
      ...meta,
    });
    return { summary: summarise(plan.rows), applied, rows: plan.rows.filter((r) => r.errors.length > 0) };
  },
};
