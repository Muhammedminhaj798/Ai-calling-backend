import type { RequestHandler } from 'express';
import { inventoryService } from './inventory.service.ts';
import type { StockQuery } from './inventory.validation.ts';

const getProductStock: RequestHandler = async (_req, res) => {
  const { params, query } = res.locals['input'] as { params: { productId: string }; query: StockQuery };
  res.json(await inventoryService.getProductStock(params.productId, query.quantity));
};

export const inventoryController = { getProductStock };
