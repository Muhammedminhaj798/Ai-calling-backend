// Port for the client's inventory system (ARCHITECTURE.md §B.6). Services depend on this interface only.
// `mock.adapter.ts` simulates a provider against the local inventory table; `client.adapter.ts` is the
// production implementation and stays non-functional until the client documents its API (§G-3/4).

export type InventorySource = 'mock' | 'client_api';

export interface StockLevel {
  sku: string;
  /** Available-to-sell quantity; null when the inventory system does not know the SKU. */
  availableToSell: number | null;
  asOf: Date;
  source: InventorySource;
}

export interface ReserveLine {
  sku: string;
  quantity: number;
}

export type ReserveLineStatus =
  | 'reserved' // full quantity reserved
  | 'insufficient' // some stock, not enough
  | 'out_of_stock' // zero available
  | 'unknown' // SKU not known to the inventory system
  | 'not_reserved'; // available, but the provider reserved nothing because another line failed

export interface ReserveLineResult {
  sku: string;
  requested: number;
  reserved: number;
  availableToSell: number | null;
  status: ReserveLineStatus;
}

export interface ReserveResult {
  /** Provider's reference for this reservation; required to release it. */
  reservationRef: string;
  source: InventorySource;
  /** True only when the provider confirmed every line in full. */
  allReserved: boolean;
  lines: ReserveLineResult[];
}

export class InventoryAdapterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InventoryAdapterError';
  }
}

export interface InventoryAdapter {
  readonly source: InventorySource;
  /** True when the numbers are simulated and must never be shown as real stock. */
  readonly isMock: boolean;
  getStock(skus: string[]): Promise<StockLevel[]>;
  /**
   * Reserve every line. Providers that support it do this atomically (all or nothing); a provider that
   * cannot may report partial lines (`allReserved: false` with some `reserved > 0`) and the caller must
   * release them. Must be idempotent per `idempotencyKey`: a retry with the same key returns the same
   * result without reserving again.
   */
  reserve(lines: ReserveLine[], idempotencyKey: string): Promise<ReserveResult>;
  /** Release a reservation. Idempotent. `lines` carries the exact quantities for providers that need them. */
  release(reservationRef: string, lines: ReserveLine[]): Promise<void>;
}
