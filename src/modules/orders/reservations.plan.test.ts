import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StockLevel } from '../../integrations/inventory/inventory.port.ts';
import { evaluateAvailability, fromReserveResult, shortageExceptionType, shortageReason } from './reservations.plan.ts';

const now = new Date();
const level = (sku: string, availableToSell: number | null): StockLevel => ({ sku, availableToSell, asOf: now, source: 'mock' });
const lines = [
  { itemId: 'a', sku: 'A', quantity: 10 },
  { itemId: 'b', sku: 'B', quantity: 5 },
  { itemId: 'c', sku: 'C', quantity: 1 },
  { itemId: 'd', sku: 'D', quantity: 1 },
];

describe('evaluateAvailability', () => {
  it('classifies every line and is only satisfied when all are in stock', () => {
    const plan = evaluateAvailability(lines, [level('A', 10), level('B', 4), level('C', 0)]);
    assert.equal(plan.allAvailable, false);
    assert.deepEqual(plan.lines.map((l) => [l.sku, l.status, l.availableToSell]), [['A', 'in_stock', 10], ['B', 'insufficient', 4], ['C', 'out_of_stock', 0], ['D', 'unknown', null]]);

    const ok = evaluateAvailability(lines.slice(0, 2), [level('A', 100), level('B', 5)]);
    assert.equal(ok.allAvailable, true);
  });
});

describe('fromReserveResult', () => {
  it('maps the provider result back onto order lines', () => {
    const plan = fromReserveResult(lines.slice(0, 2), [
      { sku: 'A', requested: 10, reserved: 0, availableToSell: 100, status: 'not_reserved' },
      { sku: 'B', requested: 5, reserved: 0, availableToSell: 2, status: 'insufficient' },
    ]);
    assert.equal(plan.allAvailable, false);
    assert.deepEqual(plan.lines.map((l) => l.status), ['in_stock', 'insufficient']);
    const full = fromReserveResult(lines.slice(0, 1), [{ sku: 'A', requested: 10, reserved: 10, availableToSell: 100, status: 'reserved' }]);
    assert.equal(full.allAvailable, true);
  });
});

describe('shortage classification', () => {
  it('reports out_of_stock only when every short line is empty or unknown', () => {
    const mixed = evaluateAvailability(lines, [level('A', 10), level('B', 4), level('C', 0)]).lines;
    assert.equal(shortageExceptionType(mixed), 'insufficient_stock');
    assert.equal(shortageReason(mixed), 'insufficient_stock');

    const empty = evaluateAvailability(lines.slice(2), [level('C', 0)]).lines;
    assert.equal(shortageExceptionType(empty), 'out_of_stock');
    assert.equal(shortageReason(empty), 'out_of_stock');

    const unknownOnly = evaluateAvailability(lines.slice(3), []).lines;
    assert.equal(shortageReason(unknownOnly), 'unknown_sku');
  });
});
