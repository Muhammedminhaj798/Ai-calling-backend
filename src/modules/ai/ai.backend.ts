// The real ToolBackend: every tool call lands in the existing services (customers, products, inventory,
// orders, reservations, exceptions). No business rule is re-implemented here and nothing touches Prisma
// directly except read-only lookups through the repositories.
import type { Prisma } from '../../generated/prisma/client.ts';
import { normalizePhone } from '../../utils/phone.ts';
import { customersRepository } from '../customers/customers.repository.ts';
import { exceptionsService } from '../exceptions/exceptions.service.ts';
import { inventoryService } from '../inventory/inventory.service.ts';
import { ordersRepository, type OrderDetailRecord } from '../orders/orders.repository.ts';
import { ordersService } from '../orders/orders.service.ts';
import { reservationsService } from '../orders/reservations.service.ts';
import { productsRepository } from '../products/products.repository.ts';
import { productsService } from '../products/products.service.ts';
import type { CustomerSummary, OrderSnapshot, ToolBackend } from './ai.types.ts';

type CustomerRecord = NonNullable<Awaited<ReturnType<typeof customersRepository.findByPhone>>>;

function toCustomerSummary(c: CustomerRecord): CustomerSummary {
  return {
    id: c.id,
    externalCode: c.externalCode,
    name: c.name,
    status: c.status,
    preferredLanguage: c.preferredLanguage,
    phonePrimary: c.phonePrimary,
    addresses: c.addresses.map((a) => ({ id: a.id, label: a.label, line1: a.line1, line2: a.line2, city: a.city, state: a.state, pincode: a.pincode, isDefault: a.isDefault })),
  };
}

export function snapshotOrder(order: Pick<OrderDetailRecord, 'id' | 'orderNumber' | 'status' | 'revision' | 'totalPaise' | 'items'>): OrderSnapshot {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    revision: order.revision,
    totalPaise: order.totalPaise,
    items: order.items.map((i) => ({
      id: i.id,
      lineNo: i.lineNo,
      productId: i.productId,
      name: i.nameSnapshot,
      strength: i.strengthSnapshot,
      packSize: i.packSizeSnapshot,
      unit: i.unitSnapshot,
      quantity: i.quantity,
      requestedText: i.requestedText,
      status: i.status,
      customerDecision: i.customerDecision,
      stockStatus: i.stockStatus,
    })),
  };
}

export const serviceToolBackend: ToolBackend = {
  async findCustomerByPhone(phone) {
    const normalised = normalizePhone(phone);
    if (!normalised) return null;
    const customer = await customersRepository.findByPhone(normalised);
    return customer ? toCustomerSummary(customer) : null;
  },

  async findOrderByCall(callId) {
    const existing = await ordersRepository.findByCallId(callId);
    return existing ? snapshotOrder(await ordersService.getDetail(existing.id)) : null;
  },

  createDraftOrder: (input, actor, meta, idempotencyKey) =>
    ordersService.create({ customerId: input.customerId, callId: input.callId, deliveryAddressId: input.deliveryAddressId, customerPoReference: input.customerPoReference, items: [] }, actor, meta, idempotencyKey).then(snapshotOrder),

  searchProducts: (query, limit) => productsService.search({ q: query, limit, includeInactive: false }),

  async getProduct(productId) {
    const p = await productsRepository.findById(productId);
    if (!p || p.status !== 'active') return null;
    return { productId: p.id, sku: p.externalCode, name: p.name, brand: p.brand, strength: p.strength, form: p.form, packSize: p.packSize, unit: p.unit, exact: false };
  },

  getStock: (productId, quantity) => inventoryService.getProductStock(productId, quantity),
  addItem: (orderId, input, actor, meta) => ordersService.addItem(orderId, input, actor, meta).then(snapshotOrder),
  updateItem: (orderId, itemId, input, actor, meta) => ordersService.updateItem(orderId, itemId, input, actor, meta).then(snapshotOrder),
  removeItem: (orderId, itemId, actor, meta) => ordersService.removeItem(orderId, itemId, actor, meta).then(snapshotOrder),
  readback: (orderId, actor, meta) => ordersService.readback(orderId, actor, meta),
  confirm: (orderId, input, actor, meta) => ordersService.confirm(orderId, input, actor, meta).then(snapshotOrder),
  reserve: (orderId, idempotencyKey, actor, meta) => reservationsService.reserve(orderId, idempotencyKey, actor, meta),
  raiseException: (input, actor) => exceptionsService.raise(input, actor).then((e) => ({ id: e.id })),
};

export type { Prisma };
