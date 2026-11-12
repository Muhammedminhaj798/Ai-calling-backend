// In-memory implementations of the two engine seams (ToolBackend, SessionStore) for unit tests.
// They mirror the real services' rules closely enough to exercise the tool layer and orchestrator
// without a database: order states, revisions, read-back/confirmation binding, stock checks, exceptions.
import { AppError } from '../../src/middleware/error-handler.ts';
import type { CandidateProduct, CustomerSummary, OrderLineSnapshot, OrderSnapshot, SessionStore, ToolBackend } from '../../src/modules/ai/ai.types.ts';
import { buildReadbackText } from '../../src/modules/orders/orders.pricing.ts';
import type { ReadbackLine } from '../../src/modules/orders/orders.types.ts';
import { normalizePhone } from '../../src/utils/phone.ts';

export interface FakeProduct extends CandidateProduct {
  /** number = available-to-sell; null = unknown to inventory; 'error' = inventory API outage */
  stock: number | null | 'error';
}

export interface FakeOrder extends OrderSnapshot {
  callId: string;
  pendingRevision: number | null;
  confirmations: Array<{ revision: number; idempotencyKey: string | null }>;
  reserved: boolean;
}

export interface FakeBackend extends ToolBackend {
  readonly orders: FakeOrder[];
  readonly exceptions: Array<{ id: string; type: string; description: string; orderId: string | null; callId: string | null; details: unknown }>;
  readonly calls: Record<string, number>;
  readonly products: FakeProduct[];
}

export function customer(over: Partial<CustomerSummary> & { phone: string }): CustomerSummary {
  return {
    id: over.id ?? `cust-${over.phone.slice(-4)}`,
    externalCode: over.externalCode ?? `C-${over.phone.slice(-4)}`,
    name: over.name ?? 'Sample Medicals',
    status: over.status ?? 'active',
    preferredLanguage: over.preferredLanguage ?? 'en',
    phonePrimary: normalizePhone(over.phone) ?? over.phone,
    addresses: over.addresses ?? [{ id: `addr-${over.phone.slice(-4)}`, label: 'Shop', line1: '1 Market Road', line2: null, city: 'Kochi', state: 'Kerala', pincode: '682001', isDefault: true }],
  };
}

export function product(over: Partial<FakeProduct> & { name: string }): FakeProduct {
  const id = over.productId ?? `prod-${over.name.toLowerCase().replace(/\s+/g, '-')}`;
  return {
    productId: id,
    sku: over.sku ?? id.toUpperCase(),
    name: over.name,
    brand: over.brand ?? over.name.split(' ')[0] ?? null,
    strength: over.strength ?? '650 mg',
    form: over.form ?? 'tablet',
    packSize: over.packSize ?? '15x10',
    unit: over.unit ?? 'strip',
    exact: false,
    stock: over.stock === undefined ? 1000 : over.stock,
  };
}

export function createFakeBackend(seed: { customers?: CustomerSummary[]; products?: FakeProduct[] } = {}): FakeBackend {
  const customers = seed.customers ?? [];
  const products = seed.products ?? [];
  const orders: FakeOrder[] = [];
  const exceptions: FakeBackend['exceptions'] = [];
  const calls: Record<string, number> = {};
  let seq = 0;
  const count = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);

  const find = (orderId: string): FakeOrder => {
    const o = orders.find((x) => x.id === orderId);
    if (!o) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    return o;
  };
  const editable = (o: FakeOrder) => {
    if (o.status !== 'draft' && o.status !== 'pending_customer_confirmation') throw new AppError(409, 'ORDER_LOCKED', 'Lines can only be changed before the customer confirms the order');
  };
  const afterLineChange = (o: FakeOrder) => {
    o.revision++;
    if (o.status === 'pending_customer_confirmation') o.status = 'draft';
    o.pendingRevision = null;
  };
  const snap = (o: FakeOrder): OrderSnapshot => ({ id: o.id, orderNumber: o.orderNumber, status: o.status, revision: o.revision, totalPaise: o.totalPaise, items: o.items.map((i) => ({ ...i })) });

  return {
    orders,
    exceptions,
    calls,
    products,

    async findCustomerByPhone(phone) {
      count('findCustomerByPhone');
      const n = normalizePhone(phone);
      return customers.find((c) => c.phonePrimary === n) ?? null;
    },

    async findOrderByCall(callId) {
      const o = orders.find((x) => x.callId === callId);
      return o ? snap(o) : null;
    },

    async createDraftOrder(input, _actor, _meta, idempotencyKey) {
      count('createDraftOrder');
      const existing = orders.find((o) => o.callId === input.callId);
      if (existing) return snap(existing);
      void idempotencyKey;
      const o: FakeOrder = { id: `order-${++seq}`, orderNumber: `PO-TEST-${seq}`, status: 'draft', revision: 1, totalPaise: 0, items: [], callId: input.callId, pendingRevision: null, confirmations: [], reserved: false };
      orders.push(o);
      return snap(o);
    },

    async searchProducts(query, limit) {
      count('searchProducts');
      const q = query.toLowerCase();
      const matches = products.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase() === q).slice(0, limit);
      const candidates = matches.map((p) => ({ id: p.productId, externalCode: p.sku, name: p.name, brand: p.brand, genericName: null, strength: p.strength, form: p.form, packSize: p.packSize, unit: p.unit, manufacturer: null, status: 'active' as const, score: 0.9, exact: p.name.toLowerCase() === q || p.sku.toLowerCase() === q }));
      const exact = candidates.filter((c) => c.exact);
      return { query, exactMatch: exact.length === 1 ? exact[0]! : null, candidates };
    },

    async getProduct(productId) {
      const p = products.find((x) => x.productId === productId);
      return p ? { ...p } : null;
    },

    async getStock(productId, quantity) {
      count('getStock');
      const p = products.find((x) => x.productId === productId);
      if (!p) throw new AppError(404, 'NOT_FOUND', 'Product not found');
      if (p.stock === 'error') throw new AppError(503, 'INVENTORY_UNAVAILABLE', 'Inventory system did not respond');
      const available = p.stock;
      return {
        productId,
        sku: p.sku,
        name: p.name,
        source: 'mock' as const,
        isMock: true,
        availableToSell: available,
        status: available === null ? ('unknown' as const) : available > 0 ? ('in_stock' as const) : ('out_of_stock' as const),
        requestedQuantity: quantity,
        sufficient: available === null ? null : available >= quantity,
        asOf: new Date(),
        warning: 'mock',
      };
    },

    async addItem(orderId, input) {
      count('addItem');
      const o = find(orderId);
      editable(o);
      if (o.items.length >= 15) throw new AppError(422, 'ORDER_ITEM_LIMIT', 'Orders are limited to 15 lines');
      const line: OrderLineSnapshot = { id: `item-${++seq}`, lineNo: o.items.length + 1, productId: null, name: null, strength: null, packSize: null, unit: null, quantity: input.quantity, requestedText: input.requestedText, status: 'flagged', customerDecision: 'pending', stockStatus: 'unchecked' };
      if (input.productId) {
        const p = products.find((x) => x.productId === input.productId);
        if (!p) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Catalogue product not found');
        if (o.items.some((i) => i.productId === p.productId)) throw new AppError(409, 'DUPLICATE_ORDER_ITEM', `${p.name} is already on this order`);
        const c = input.confirmedDetails;
        const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
        if (c && ((c.name && norm(c.name) !== norm(p.name)) || (c.strength && norm(c.strength) !== norm(p.strength)) || (c.packSize && norm(c.packSize) !== norm(p.packSize)))) {
          throw new AppError(422, 'PRODUCT_IDENTITY_MISMATCH', 'Confirmed medicine details do not match the catalogue product');
        }
        Object.assign(line, { productId: p.productId, name: p.name, strength: p.strength, packSize: p.packSize, unit: p.unit, status: 'active' });
      } else {
        exceptions.push({ id: `ex-${++seq}`, type: input.flagReason!, description: `flagged ${input.requestedText}`, orderId, callId: o.callId, details: null });
      }
      o.items.push(line);
      afterLineChange(o);
      return snap(o);
    },

    async updateItem(orderId, itemId, input) {
      count('updateItem');
      const o = find(orderId);
      editable(o);
      const line = o.items.find((i) => i.id === itemId);
      if (!line) throw new AppError(404, 'NOT_FOUND', 'Order line not found');
      if (input.productId) {
        const p = products.find((x) => x.productId === input.productId);
        if (!p) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Catalogue product not found');
        Object.assign(line, { productId: p.productId, name: p.name, strength: p.strength, packSize: p.packSize, unit: p.unit, status: 'active' });
      }
      if (input.quantity !== undefined) line.quantity = input.quantity;
      if (input.requestedText !== undefined) line.requestedText = input.requestedText;
      afterLineChange(o);
      return snap(o);
    },

    async removeItem(orderId, itemId) {
      count('removeItem');
      const o = find(orderId);
      editable(o);
      const idx = o.items.findIndex((i) => i.id === itemId);
      if (idx < 0) throw new AppError(404, 'NOT_FOUND', 'Order line not found');
      o.items.splice(idx, 1);
      afterLineChange(o);
      return snap(o);
    },

    async readback(orderId) {
      count('readback');
      const o = find(orderId);
      editable(o);
      const active = o.items.filter((i) => i.status === 'active');
      if (active.length === 0) throw new AppError(422, 'ORDER_EMPTY', 'Add at least one resolved line before reading the order back');
      const lines: ReadbackLine[] = active.map((i) => ({ itemId: i.id, lineNo: i.lineNo, productId: i.productId!, sku: products.find((p) => p.productId === i.productId)?.sku ?? '', name: i.name ?? i.requestedText, strength: i.strength, form: null, packSize: i.packSize, unit: i.unit, quantity: i.quantity }));
      o.status = 'pending_customer_confirmation';
      o.pendingRevision = o.revision;
      return { confirmationId: `conf-${++seq}`, orderId, revision: o.revision, status: 'pending_customer_confirmation', lines, flaggedRequests: o.items.filter((i) => i.status === 'flagged').map((i) => ({ itemId: i.id, requestedText: i.requestedText, quantity: i.quantity, flagReason: 'product_not_found' })), readbackText: buildReadbackText(lines) };
    },

    async confirm(orderId, input) {
      count('confirm');
      const o = find(orderId);
      if (o.status !== 'draft' && o.status !== 'pending_customer_confirmation') {
        if (input.idempotencyKey && o.confirmations.some((c) => c.idempotencyKey === input.idempotencyKey)) return snap(o);
        throw new AppError(409, 'ORDER_ALREADY_CONFIRMED', 'Customer confirmation was already recorded');
      }
      if (o.status === 'draft') throw new AppError(409, 'READBACK_REQUIRED', 'Read the order back first');
      if (input.revision !== o.revision || o.pendingRevision !== o.revision) throw new AppError(409, 'STALE_REVISION', 'Read-back revision is stale');
      for (const i of o.items) if (i.status === 'active') i.customerDecision = input.declinedItemIds.includes(i.id) ? 'declined' : 'accepted';
      o.status = 'customer_confirmed';
      o.confirmations.push({ revision: input.revision, idempotencyKey: input.idempotencyKey ?? null });
      return snap(o);
    },

    async reserve(orderId) {
      count('reserve');
      const o = find(orderId);
      if (o.status !== 'customer_confirmed') throw new AppError(409, 'CUSTOMER_UNCONFIRMED', 'Customer confirmation is required before stock can be reserved');
      const accepted = o.items.filter((i) => i.status === 'active' && i.customerDecision === 'accepted');
      const short = accepted.filter((i) => {
        const p = products.find((x) => x.productId === i.productId);
        return !p || p.stock === 'error' || p.stock === null || p.stock < i.quantity;
      });
      if (short.length > 0) {
        exceptions.push({ id: `ex-${++seq}`, type: 'insufficient_stock', description: 'reservation failed', orderId, callId: o.callId, details: null });
        return { outcome: 'failed', orderStatus: 'customer_confirmed', reason: 'insufficient_stock', source: 'mock', isMock: true, lines: [], exceptionId: `ex-${seq}` };
      }
      o.status = 'pending_staff_approval';
      o.reserved = true;
      return { outcome: 'reserved', orderStatus: 'pending_staff_approval', replay: false, source: 'mock', isMock: true, expiresAt: new Date(), lines: [], reservations: [] };
    },

    async raiseException(input) {
      count('raiseException');
      const id = `ex-${++seq}`;
      exceptions.push({ id, type: input.type, description: input.description, orderId: input.orderId ?? null, callId: input.callId ?? null, details: input.details });
      return { id };
    },
  };
}

export interface FakeStore extends SessionStore {
  readonly transcripts: Array<{ speaker: string; text: string; language: string; toolCalls?: unknown }>;
  readonly events: Array<{ type: string; fromState?: string; toState?: string; toolName?: string; ok?: boolean; data?: unknown }>;
  readonly patches: Array<Record<string, unknown>>;
  readonly usage: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number }>;
}

export function createFakeStore(): FakeStore {
  const transcripts: FakeStore['transcripts'] = [];
  const events: FakeStore['events'] = [];
  const patches: FakeStore['patches'] = [];
  const usage: FakeStore['usage'] = [];
  return {
    transcripts,
    events,
    patches,
    usage,
    async recordTranscript(_callId, entry) {
      transcripts.push({ speaker: entry.speaker, text: entry.text, language: entry.language, toolCalls: entry.toolCalls });
    },
    async recordEvent(_callId, event) {
      events.push({ type: event.type, fromState: event.fromState, toState: event.toState, toolName: event.toolName, ok: event.ok, data: event.data });
    },
    async updateCall(_callId, patch) {
      patches.push({ ...patch });
    },
    async recordUsage(_callId, u) {
      usage.push({ provider: u.provider, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens });
    },
  };
}
