// Wires the configured inventory adapter and answers stock questions for one product.
// Other modules (orders, reservations, AI tools) must go through getInventoryAdapter(), never the repository.
import { env } from '../../config/env.ts';
import { createClientInventoryAdapter } from '../../integrations/inventory/client.adapter.ts';
import { InventoryAdapterError, type InventoryAdapter } from '../../integrations/inventory/inventory.port.ts';
import { createMockInventoryAdapter } from '../../integrations/inventory/mock.adapter.ts';
import { AppError } from '../../middleware/error-handler.ts';
import { productsRepository } from '../products/products.repository.ts';
import { inventoryRepository } from './inventory.repository.ts';
import type { ProductStockResponse, StockStatus } from './inventory.types.ts';

const MOCK_WARNING = 'Simulated stock from the mock inventory adapter — not real inventory.';

function buildAdapter(): InventoryAdapter {
  switch (env.INVENTORY_ADAPTER) {
    case 'mock':
      return createMockInventoryAdapter({
        lookup: inventoryRepository.findStockBySkus,
        reserve: (lines) => inventoryRepository.reserveLocal(lines),
        release: (lines) => inventoryRepository.releaseLocal(lines),
      });
    case 'client_api':
      return createClientInventoryAdapter({ baseUrl: env.CLIENT_INVENTORY_BASE_URL!, apiKey: env.CLIENT_INVENTORY_API_KEY! });
  }
}

const adapter = buildAdapter();

export function getInventoryAdapter(): InventoryAdapter {
  return adapter;
}

/** Maps a provider outage to the API error every caller should surface. */
export function inventoryUnavailable(err: unknown): AppError {
  if (err instanceof InventoryAdapterError) {
    return new AppError(503, 'INVENTORY_UNAVAILABLE', 'Inventory system did not respond; stock cannot be confirmed right now');
  }
  return err instanceof AppError ? err : new AppError(500, 'INTERNAL_ERROR', 'Unexpected inventory error');
}

export const inventoryService = {
  async getProductStock(productId: string, quantity?: number): Promise<ProductStockResponse> {
    const product = await productsRepository.findById(productId);
    if (!product) throw new AppError(404, 'NOT_FOUND', 'Product not found');

    let level;
    try {
      [level] = await adapter.getStock([product.externalCode]);
    } catch (err) {
      throw inventoryUnavailable(err);
    }
    if (!level) throw new AppError(502, 'INVENTORY_BAD_RESPONSE', 'Inventory adapter returned no data for this product');

    const available = level.availableToSell;
    const status: StockStatus = available === null ? 'unknown' : available > 0 ? 'in_stock' : 'out_of_stock';
    return {
      productId: product.id,
      sku: product.externalCode,
      name: product.name,
      source: level.source,
      isMock: adapter.isMock,
      availableToSell: available,
      status,
      requestedQuantity: quantity ?? null,
      sufficient: quantity !== undefined && available !== null ? available >= quantity : null,
      asOf: level.asOf,
      ...(adapter.isMock ? { warning: MOCK_WARNING } : {}),
    };
  },
};
