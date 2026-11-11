import type { InventorySource } from '../../integrations/inventory/inventory.port.ts';

export type StockStatus = 'in_stock' | 'out_of_stock' | 'unknown';

export interface ProductStockResponse {
  productId: string;
  sku: string;
  name: string;
  source: InventorySource;
  /** True when the figures are simulated and must not be presented as real stock. */
  isMock: boolean;
  availableToSell: number | null;
  status: StockStatus;
  requestedQuantity: number | null;
  /** Null when no quantity was requested or the SKU is unknown to the inventory system. */
  sufficient: boolean | null;
  asOf: Date;
  warning?: string;
}
