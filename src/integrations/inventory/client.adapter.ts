// Production adapter for the client's inventory API. The client has not supplied API documentation or
// credentials yet (ARCHITECTURE.md §G-3/4), so this adapter is wired but every call fails loudly instead
// of guessing endpoints. The contract the client API must satisfy is documented in ARCHITECTURE.md §B.6:
//   - stock lookup by SKU list (available-to-sell, as-of timestamp)
//   - atomic reservation of a line list with a caller-supplied idempotency key, returning a reservation
//     reference and per-line confirmed quantities (all-or-nothing, or explicit partial results)
//   - release by reservation reference, idempotent
// Implementing those three calls here is the only change needed to replace the mock.
import { InventoryAdapterError, type InventoryAdapter } from './inventory.port.ts';

export interface ClientInventoryConfig {
  baseUrl: string;
  apiKey: string;
}

export function createClientInventoryAdapter(_config: ClientInventoryConfig): InventoryAdapter {
  const notConfigured = () =>
    new InventoryAdapterError('Client inventory API integration is not implemented: endpoint contract pending from the client (ARCHITECTURE.md §B.6, §G-3)');
  return {
    source: 'client_api',
    isMock: false,
    async getStock() {
      throw notConfigured();
    },
    async reserve() {
      throw notConfigured();
    },
    async release() {
      throw notConfigured();
    },
  };
}
