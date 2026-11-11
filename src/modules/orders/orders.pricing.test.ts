import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildReadbackText, computeTotals, lineTotalPaise } from './orders.pricing.ts';
import type { ReadbackLine } from './orders.types.ts';

describe('order pricing', () => {
  it('totals only active, non-declined lines and treats unknown prices as 0', () => {
    const totals = computeTotals([
      { quantity: 2, unitPricePaise: 2600, status: 'active', customerDecision: 'accepted' },
      { quantity: 1, unitPricePaise: 1000, status: 'active', customerDecision: 'declined' },
      { quantity: 3, unitPricePaise: null, status: 'active', customerDecision: 'pending' },
      { quantity: 9, unitPricePaise: 5000, status: 'flagged', customerDecision: 'pending' },
    ]);
    assert.deepEqual(totals, { subtotalPaise: 5200, taxPaise: 0, totalPaise: 5200 });
    assert.equal(lineTotalPaise(3, null), null);
    assert.equal(lineTotalPaise(3, 150), 450);
  });
});

describe('read-back text', () => {
  const line = (over: Partial<ReadbackLine>): ReadbackLine => ({
    itemId: 'i',
    lineNo: 1,
    productId: 'p',
    sku: 'S',
    name: 'Dolo 650',
    strength: '650 mg',
    form: 'tablet',
    packSize: '15x10',
    unit: 'strip',
    quantity: 20,
    ...over,
  });

  it('numbers every line, includes strength, form, pack and quantity, and ends with the count', () => {
    const text = buildReadbackText([line({}), line({ name: 'Mocklyte ORS', strength: null, form: 'powder', packSize: '21 g sachet', unit: 'sachet', quantity: 1 })]);
    assert.equal(
      text,
      '1. Dolo 650 — 650 mg tablet, pack 15x10 — quantity 20 strips.\n2. Mocklyte ORS — powder, pack 21 g sachet — quantity 1 sachet.\nThat is 2 items in total. Please confirm.',
    );
  });

  it('handles a single line and no lines', () => {
    assert.match(buildReadbackText([line({})]), /That is 1 item in total/);
    assert.equal(buildReadbackText([]), 'No items.');
  });
});
