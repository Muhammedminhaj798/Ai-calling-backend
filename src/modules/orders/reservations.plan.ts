// Pure availability evaluation used by the reservation service before and after calling the provider.
import type { ExceptionType } from '../../generated/prisma/enums.ts';
import type { ReserveLineResult, StockLevel } from '../../integrations/inventory/inventory.port.ts';
import type { LineAvailability } from './orders.types.ts';

export interface PlanLine {
  itemId: string;
  sku: string;
  quantity: number;
}

export interface AvailabilityPlan {
  allAvailable: boolean;
  lines: LineAvailability[];
}

function classify(quantity: number, available: number | null): LineAvailability['status'] {
  if (available === null) return 'unknown';
  if (available === 0) return 'out_of_stock';
  return available >= quantity ? 'in_stock' : 'insufficient';
}

/** Compares requested quantities against current available-to-sell levels. */
export function evaluateAvailability(lines: PlanLine[], levels: StockLevel[]): AvailabilityPlan {
  const bySku = new Map(levels.map((l) => [l.sku, l.availableToSell]));
  const evaluated = lines.map((line): LineAvailability => {
    const available = bySku.has(line.sku) ? bySku.get(line.sku)! : null;
    return { itemId: line.itemId, sku: line.sku, quantity: line.quantity, availableToSell: available, status: classify(line.quantity, available) };
  });
  return { allAvailable: evaluated.every((l) => l.status === 'in_stock'), lines: evaluated };
}

/** Maps the provider's per-line reservation result back onto order lines. */
export function fromReserveResult(lines: PlanLine[], results: ReserveLineResult[]): AvailabilityPlan {
  const bySku = new Map(results.map((r) => [r.sku, r]));
  const evaluated = lines.map((line): LineAvailability => {
    const r = bySku.get(line.sku);
    const available = r?.availableToSell ?? null;
    const status: LineAvailability['status'] =
      r?.status === 'reserved' || r?.status === 'not_reserved' ? classify(line.quantity, available) : classify(line.quantity, available);
    return { itemId: line.itemId, sku: line.sku, quantity: line.quantity, availableToSell: available, status };
  });
  return { allAvailable: results.length > 0 && results.every((r) => r.status === 'reserved'), lines: evaluated };
}

/** One exception per failed attempt; its type reflects the worst shortage. */
export function shortageExceptionType(lines: LineAvailability[]): Extract<ExceptionType, 'insufficient_stock' | 'out_of_stock'> {
  const short = lines.filter((l) => l.status !== 'in_stock');
  return short.length > 0 && short.every((l) => l.status === 'out_of_stock' || l.status === 'unknown') ? 'out_of_stock' : 'insufficient_stock';
}

export function shortageReason(lines: LineAvailability[]): 'insufficient_stock' | 'out_of_stock' | 'unknown_sku' {
  const short = lines.filter((l) => l.status !== 'in_stock');
  if (short.every((l) => l.status === 'unknown')) return 'unknown_sku';
  if (short.every((l) => l.status === 'out_of_stock' || l.status === 'unknown')) return 'out_of_stock';
  return 'insufficient_stock';
}
