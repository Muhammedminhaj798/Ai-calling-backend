// Pure pricing and read-back helpers. Prices come only from the catalogue snapshot taken when a line was
// resolved — never from the client. Tax is 0 until the client's pricing rules arrive (ARCHITECTURE.md §G-6).
import type { CustomerDecision, OrderItemStatus } from '../../generated/prisma/enums.ts';
import type { ReadbackLine } from './orders.types.ts';

export interface PricedLine {
  quantity: number;
  unitPricePaise: number | null;
  status: OrderItemStatus;
  customerDecision: CustomerDecision;
}

export interface OrderTotals {
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export function lineTotalPaise(quantity: number, unitPricePaise: number | null): number | null {
  return unitPricePaise === null ? null : quantity * unitPricePaise;
}

/** Active lines the customer has not declined. Lines without a price contribute 0 (price pending). */
export function computeTotals(lines: PricedLine[]): OrderTotals {
  const subtotalPaise = lines
    .filter((l) => l.status === 'active' && l.customerDecision !== 'declined')
    .reduce((sum, l) => sum + (lineTotalPaise(l.quantity, l.unitPricePaise) ?? 0), 0);
  // ponytail: tax = 0 until pricing rules (GST per product / scheme) are confirmed by the client
  const taxPaise = 0;
  return { subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise };
}

function describe(line: ReadbackLine): string {
  const spec = [line.strength, line.form].filter(Boolean).join(' ');
  const pack = line.packSize ? `pack ${line.packSize}` : '';
  const detail = [spec, pack].filter(Boolean).join(', ');
  const unit = line.unit ? ` ${line.unit}${line.quantity === 1 ? '' : 's'}` : '';
  return `${line.name}${detail ? ` — ${detail}` : ''} — quantity ${line.quantity}${unit}`;
}

/** The text read back to the customer before confirmation: every line, numbered, then the line count. */
export function buildReadbackText(lines: ReadbackLine[]): string {
  if (lines.length === 0) return 'No items.';
  const body = lines.map((l, i) => `${i + 1}. ${describe(l)}.`).join('\n');
  return `${body}\nThat is ${lines.length} item${lines.length === 1 ? '' : 's'} in total. Please confirm.`;
}
