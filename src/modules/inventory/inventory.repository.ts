// Local inventory table access. Backs the mock adapter (which plays the role of the provider) and, later,
// caches the client inventory API.
import { prisma } from '../../config/db.ts';
import type { ReserveLine } from '../../integrations/inventory/inventory.port.ts';
import type { MockReserveOutcome, MockStockRow } from '../../integrations/inventory/mock.adapter.ts';

class ShortageRollback extends Error {
  constructor(public readonly skus: string[]) {
    super('insufficient stock');
  }
}

export const inventoryRepository = {
  async findStockBySkus(skus: string[]): Promise<MockStockRow[]> {
    const rows = await prisma.inventory.findMany({
      where: { product: { externalCode: { in: skus } } },
      include: { product: { select: { externalCode: true } } },
    });
    return rows.map((r) => ({
      sku: r.product.externalCode,
      quantityAvailable: r.quantityAvailable,
      quantityReserved: r.quantityReserved,
      syncedAt: r.syncedAt,
    }));
  },

  /**
   * Atomic conditional reservation (ARCHITECTURE.md §B.7): each line increments quantity_reserved only if
   * enough stock is free; the row lock serialises concurrent callers; any shortage rolls the whole
   * transaction back so no partial reservation is ever left behind.
   */
  async reserveLocal(lines: ReserveLine[]): Promise<MockReserveOutcome> {
    try {
      await prisma.$transaction(async (tx) => {
        const short: string[] = [];
        for (const line of lines) {
          const updated = await tx.$executeRaw`
            UPDATE inventory i
               SET quantity_reserved = i.quantity_reserved + ${line.quantity}, updated_at = now()
              FROM products p
             WHERE p.id = i.product_id
               AND p.external_code = ${line.sku}
               AND i.quantity_available - i.quantity_reserved >= ${line.quantity}`;
          if (updated === 0) short.push(line.sku);
        }
        if (short.length > 0) throw new ShortageRollback(short);
      });
      return { ok: true };
    } catch (err) {
      if (!(err instanceof ShortageRollback)) throw err;
      const rows = await this.findStockBySkus(err.skus);
      return {
        ok: false,
        shortages: err.skus.map((sku) => {
          const row = rows.find((r) => r.sku === sku);
          return { sku, available: row ? Math.max(0, row.quantityAvailable - row.quantityReserved) : null };
        }),
      };
    }
  },

  async releaseLocal(lines: ReserveLine[]): Promise<void> {
    await prisma.$transaction(async (tx) => {
      for (const line of lines) {
        await tx.$executeRaw`
          UPDATE inventory i
             SET quantity_reserved = GREATEST(0, i.quantity_reserved - ${line.quantity}), updated_at = now()
            FROM products p
           WHERE p.id = i.product_id AND p.external_code = ${line.sku}`;
      }
    });
  },
};
