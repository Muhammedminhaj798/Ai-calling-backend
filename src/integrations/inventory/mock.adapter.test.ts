import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InventoryAdapterError } from './inventory.port.ts';
import { createMockInventoryAdapter, type MockInventoryDeps } from './mock.adapter.ts';

const synced = new Date('2026-11-10T08:00:00Z');

/** In-memory stand-in for the inventory table with the same all-or-nothing semantics as the repository. */
function fakeDeps(initial: Record<string, { available: number; reserved?: number }>) {
  const stock = new Map(Object.entries(initial).map(([sku, s]) => [sku, { available: s.available, reserved: s.reserved ?? 0 }]));
  const calls = { reserve: 0, release: 0 };
  const deps: MockInventoryDeps = {
    async lookup(skus) {
      return skus.flatMap((sku) => {
        const s = stock.get(sku);
        return s ? [{ sku, quantityAvailable: s.available, quantityReserved: s.reserved, syncedAt: synced }] : [];
      });
    },
    async reserve(lines) {
      calls.reserve++;
      const short = lines.filter((l) => {
        const s = stock.get(l.sku);
        return !s || s.available - s.reserved < l.quantity;
      });
      if (short.length > 0) {
        return {
          ok: false,
          shortages: short.map((l) => {
            const s = stock.get(l.sku);
            return { sku: l.sku, available: s ? s.available - s.reserved : null };
          }),
        };
      }
      for (const l of lines) stock.get(l.sku)!.reserved += l.quantity;
      return { ok: true };
    },
    async release(lines) {
      calls.release++;
      for (const l of lines) {
        const s = stock.get(l.sku);
        if (s) s.reserved = Math.max(0, s.reserved - l.quantity);
      }
    },
  };
  return { deps, stock, calls };
}

describe('mock inventory adapter — stock lookup', () => {
  const { deps } = fakeDeps({ 'PARA-650': { available: 120, reserved: 20 }, 'AMOX-500-OOS': { available: 50 }, OVER: { available: 5, reserved: 9 } });
  const adapter = createMockInventoryAdapter(deps);

  it('is clearly labelled as mock', () => {
    assert.equal(adapter.source, 'mock');
    assert.equal(adapter.isMock, true);
  });

  it('returns available-to-sell = available − reserved, never negative, and simulates OOS / unknown SKUs', async () => {
    const [para, over, oos, missing, na] = await adapter.getStock(['PARA-650', 'OVER', 'AMOX-500-OOS', 'NOPE', 'ORS-NA']);
    assert.deepEqual(para, { sku: 'PARA-650', availableToSell: 100, asOf: synced, source: 'mock' });
    assert.equal(over?.availableToSell, 0);
    assert.equal(oos?.availableToSell, 0);
    assert.equal(missing?.availableToSell, null);
    assert.equal(na?.availableToSell, null);
  });

  it('simulates an inventory API outage for -ERR SKUs', async () => {
    await assert.rejects(adapter.getStock(['PARA-650', 'CETZ-10-ERR']), (e: unknown) => e instanceof InventoryAdapterError);
  });
});

describe('mock inventory adapter — reservations', () => {
  it('reserves every line atomically and reports the reference', async () => {
    const { deps, stock } = fakeDeps({ A: { available: 100 }, B: { available: 50 } });
    const adapter = createMockInventoryAdapter(deps);
    const result = await adapter.reserve([{ sku: 'A', quantity: 10 }, { sku: 'B', quantity: 5 }], 'key-1');
    assert.equal(result.allReserved, true);
    assert.match(result.reservationRef, /^mock-/);
    assert.deepEqual(result.lines.map((l) => [l.sku, l.status, l.reserved]), [['A', 'reserved', 10], ['B', 'reserved', 5]]);
    assert.equal(stock.get('A')?.reserved, 10);
    assert.equal(stock.get('B')?.reserved, 5);
  });

  it('reserves nothing when any line is short (all-or-nothing) and explains each line', async () => {
    const { deps, stock } = fakeDeps({ A: { available: 100 }, B: { available: 3 } });
    const adapter = createMockInventoryAdapter(deps);
    const result = await adapter.reserve([{ sku: 'A', quantity: 10 }, { sku: 'B', quantity: 5 }], 'key-2');
    assert.equal(result.allReserved, false);
    assert.deepEqual(result.lines.map((l) => [l.sku, l.status, l.reserved, l.availableToSell]), [['A', 'not_reserved', 0, 100], ['B', 'insufficient', 0, 3]]);
    assert.equal(stock.get('A')?.reserved, 0, 'nothing is reserved on partial failure');
  });

  it('treats -OOS and -NA lines as shortages without touching the store', async () => {
    const { deps, calls } = fakeDeps({ A: { available: 100 }, 'B-OOS': { available: 100 } });
    const adapter = createMockInventoryAdapter(deps);
    const result = await adapter.reserve([{ sku: 'A', quantity: 1 }, { sku: 'B-OOS', quantity: 1 }, { sku: 'C-NA', quantity: 1 }], 'key-3');
    assert.equal(result.allReserved, false);
    assert.deepEqual(result.lines.map((l) => l.status), ['not_reserved', 'out_of_stock', 'unknown']);
    assert.equal(calls.reserve, 0);
  });

  it('replays an identical idempotency key without reserving twice', async () => {
    const { deps, stock, calls } = fakeDeps({ A: { available: 100 } });
    const adapter = createMockInventoryAdapter(deps);
    const first = await adapter.reserve([{ sku: 'A', quantity: 10 }], 'same-key');
    const second = await adapter.reserve([{ sku: 'A', quantity: 10 }], 'same-key');
    assert.equal(second.reservationRef, first.reservationRef);
    assert.equal(calls.reserve, 1);
    assert.equal(stock.get('A')?.reserved, 10);
  });

  it('throws for -ERR lines on reserve and release', async () => {
    const adapter = createMockInventoryAdapter(fakeDeps({ A: { available: 1 } }).deps);
    await assert.rejects(adapter.reserve([{ sku: 'X-ERR', quantity: 1 }], 'k'), (e: unknown) => e instanceof InventoryAdapterError);
    await assert.rejects(adapter.release('mock-x', [{ sku: 'X-ERR', quantity: 1 }]), (e: unknown) => e instanceof InventoryAdapterError);
  });

  it('release returns the exact quantities and ignores zero lines', async () => {
    const { deps, stock, calls } = fakeDeps({ A: { available: 100, reserved: 10 }, B: { available: 10, reserved: 2 } });
    const adapter = createMockInventoryAdapter(deps);
    await adapter.release('mock-ref', [{ sku: 'A', quantity: 10 }, { sku: 'B', quantity: 0 }]);
    assert.equal(calls.release, 1);
    assert.equal(stock.get('A')?.reserved, 0);
    assert.equal(stock.get('B')?.reserved, 2);
  });
});
