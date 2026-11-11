// Prisma queries for the product catalogue. The trigram search is the one raw query in this module.
import { prisma } from '../../config/db.ts';
import { Prisma } from '../../generated/prisma/client.ts';
import type { ProductStatus } from '../../generated/prisma/enums.ts';
import type { ProductImportRow } from './products.import.ts';

export interface SearchRow {
  id: string;
  externalCode: string;
  name: string;
  brand: string | null;
  genericName: string | null;
  strength: string | null;
  form: string | null;
  packSize: string | null;
  unit: string | null;
  manufacturer: string | null;
  status: ProductStatus;
  score: number;
}

const refSelect = {
  id: true,
  externalCode: true,
  name: true,
  strength: true,
  packSize: true,
  manufacturer: true,
} satisfies Prisma.ProductSelect;

export const productsRepository = {
  list(where: Prisma.ProductWhereInput, orderBy: Prisma.ProductOrderByWithRelationInput, skip: number, take: number) {
    return Promise.all([prisma.product.findMany({ where, orderBy, skip, take }), prisma.product.count({ where })]);
  },
  findById: (id: string) => prisma.product.findUnique({ where: { id } }),
  findByIds: (ids: string[]) => prisma.product.findMany({ where: { id: { in: ids } } }),
  findByExternalCode: (externalCode: string) => prisma.product.findUnique({ where: { externalCode } }),
  /** Candidates for duplicate detection: same name, case-insensitive. */
  findByName: (name: string) => prisma.product.findMany({ where: { name: { equals: name, mode: 'insensitive' } }, select: refSelect }),
  allRefs: () => prisma.product.findMany({ select: refSelect }),

  create: (data: Prisma.ProductCreateInput) => prisma.product.create({ data }),
  update: (id: string, data: Prisma.ProductUpdateInput) => prisma.product.update({ where: { id }, data }),

  /** Ranked trigram search over name, generic name and SKU. Requires the pg_trgm extension (migration 1). */
  search(q: string, limit: number, includeInactive: boolean): Promise<SearchRow[]> {
    const statusFilter = includeInactive ? Prisma.empty : Prisma.sql`AND p.status = 'active'`;
    return prisma.$queryRaw<SearchRow[]>`
      SELECT p.id,
             p.external_code AS "externalCode",
             p.name,
             p.brand,
             p.generic_name  AS "genericName",
             p.strength,
             p.form,
             p.pack_size     AS "packSize",
             p.unit,
             p.manufacturer,
             p.status::text  AS status,
             GREATEST(similarity(p.name, ${q}),
                      similarity(COALESCE(p.generic_name, ''), ${q}),
                      similarity(p.external_code, ${q}))::float8 AS score
      FROM products p
      WHERE (p.name % ${q}
             OR COALESCE(p.generic_name, '') % ${q}
             OR p.external_code ILIKE ${q + '%'}
             OR p.name ILIKE ${'%' + q + '%'})
        ${statusFilter}
      ORDER BY score DESC, p.name ASC
      LIMIT ${limit}`;
  },

  applyImport: (rows: ProductImportRow[], toCreate: (r: ProductImportRow) => Prisma.ProductCreateInput, toUpdate: (r: ProductImportRow) => Prisma.ProductUpdateInput) =>
    prisma.$transaction(
      async (tx) => {
        let created = 0;
        let updated = 0;
        for (const row of rows) {
          if (row.errors.length > 0 || !row.input) continue;
          if (row.action === 'create') {
            await tx.product.create({ data: toCreate(row) });
            created++;
          } else if (row.existingId) {
            await tx.product.update({ where: { id: row.existingId }, data: toUpdate(row) });
            updated++;
          }
        }
        return { created, updated };
      },
      { timeout: 120_000 },
    ),
};
