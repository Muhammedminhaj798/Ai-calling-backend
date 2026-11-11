// Mock inventory adapter: simulates the client's inventory system against the local `inventory` table
// (rows with source = mock). Failure modes are triggered by SKU suffix so every code path can be exercised:
//   <sku>-ERR → throws InventoryAdapterError (simulated inventory API outage) on any call
//   <sku>-OOS → out of stock (0 available) regardless of the stored quantity
//   <sku>-NA  → unknown SKU (availableToSell: null); any SKU without an inventory row behaves the same
// Reservation is all-or-nothing (one local transaction) and idempotent per key. Numbers from this adapter
// are NOT real stock; every result carries source: "mock".
import { randomUUID } from 'node:crypto';
import {
  InventoryAdapterError,
  type InventoryAdapter,
  type ReserveLine,
  type ReserveLineResult,
  type ReserveResult,
  type StockLevel,
} from './inventory.port.ts';

export interface MockStockRow {
  sku: string;
  quantityAvailable: number;
  quantityReserved: number;
  syncedAt: Date;
}

export type MockReserveOutcome = { ok: true } | { ok: false; shortages: Array<{ sku: string; available: number | null }> };

export interface MockInventoryDeps {
  lookup(skus: string[]): Promise<MockStockRow[]>;
  /** Atomic across all lines: reserves every line or nothing, returning the shortages. */
  reserve(lines: ReserveLine[]): Promise<MockReserveOutcome>;
  /** Undo the given quantities (clamped at zero). */
  release(lines: ReserveLine[]): Promise<void>;
}

const isErr = (sku: string) => sku.toUpperCase().endsWith('-ERR');
const isOos = (sku: string) => sku.toUpperCase().endsWith('-OOS');
const isNa = (sku: string) => sku.toUpperCase().endsWith('-NA');

export function createMockInventoryAdapter(deps: MockInventoryDeps): InventoryAdapter {
  // ponytail: process-local idempotency memory, enough for a simulator; a real provider stores this server-side.
  const replays = new Map<string, ReserveResult>();

  async function levels(skus: string[]): Promise<Map<string, StockLevel>> {
    const rows = new Map((await deps.lookup(skus)).map((r) => [r.sku, r]));
    const now = new Date();
    return new Map(
      skus.map((sku): [string, StockLevel] => {
        const row = rows.get(sku);
        if (isNa(sku) || !row) return [sku, { sku, availableToSell: null, asOf: now, source: 'mock' }];
        const available = isOos(sku) ? 0 : Math.max(0, row.quantityAvailable - row.quantityReserved);
        return [sku, { sku, availableToSell: available, asOf: row.syncedAt, source: 'mock' }];
      }),
    );
  }

  return {
    source: 'mock',
    isMock: true,

    async getStock(skus) {
      if (skus.some(isErr)) throw new InventoryAdapterError('Simulated inventory API failure (SKU suffix -ERR)');
      const map = await levels(skus);
      return skus.map((sku) => map.get(sku)!);
    },

    async reserve(lines, idempotencyKey) {
      const replay = replays.get(idempotencyKey);
      if (replay) return replay;
      if (lines.some((l) => isErr(l.sku))) throw new InventoryAdapterError('Simulated inventory API failure (SKU suffix -ERR)');

      const before = await levels(lines.map((l) => l.sku));
      const simulatedShort = lines.filter((l) => isOos(l.sku) || isNa(l.sku));
      const outcome: MockReserveOutcome = simulatedShort.length
        ? { ok: false, shortages: simulatedShort.map((l) => ({ sku: l.sku, available: before.get(l.sku)?.availableToSell ?? null })) }
        : await deps.reserve(lines);

      const shortBySku = new Map(outcome.ok ? [] : outcome.shortages.map((s) => [s.sku, s.available]));
      const resultLines = lines.map((l): ReserveLineResult => {
        const available = shortBySku.has(l.sku) ? shortBySku.get(l.sku)! : (before.get(l.sku)?.availableToSell ?? null);
        if (outcome.ok) return { sku: l.sku, requested: l.quantity, reserved: l.quantity, availableToSell: available, status: 'reserved' };
        if (!shortBySku.has(l.sku)) return { sku: l.sku, requested: l.quantity, reserved: 0, availableToSell: available, status: 'not_reserved' };
        const status = available === null ? 'unknown' : available === 0 ? 'out_of_stock' : 'insufficient';
        return { sku: l.sku, requested: l.quantity, reserved: 0, availableToSell: available, status };
      });

      const result: ReserveResult = { reservationRef: `mock-${randomUUID()}`, source: 'mock', allReserved: outcome.ok, lines: resultLines };
      replays.set(idempotencyKey, result);
      return result;
    },

    async release(_reservationRef, lines) {
      if (lines.some((l) => isErr(l.sku))) throw new InventoryAdapterError('Simulated inventory API failure (SKU suffix -ERR)');
      await deps.release(lines.filter((l) => l.quantity > 0));
    },
  };
}
