// Shapes shared by the conversation engine: the in-memory session, the backend seam the tools call, and
// the persistence seam the orchestrator writes through. Two implementations exist for each seam — the real
// services/database and in-memory fakes for unit tests.
import type { ConversationState, CustomerStatus, ItemStockStatus, OrderStatus } from '../../generated/prisma/enums.ts';
import type { ChatMessage } from '../../integrations/ai/ai.port.ts';
import type { RequestMeta } from '../../utils/audit.ts';
import type { Lang } from '../../utils/language.ts';
import type { RaiseExceptionInput } from '../exceptions/exceptions.types.ts';
import type { ProductStockResponse } from '../inventory/inventory.types.ts';
import type { Actor, ReadbackResult, ReservationOutcome } from '../orders/orders.types.ts';
import type { AddItemInput, ConfirmOrderInput, UpdateItemInput } from '../orders/orders.validation.ts';
import type { ProductSearchResult } from '../products/products.types.ts';

export const AI_ACTOR: Actor = { type: 'ai', id: null };

export interface CustomerSummary {
  id: string;
  externalCode: string;
  name: string;
  status: CustomerStatus;
  preferredLanguage: Lang;
  phonePrimary: string;
  addresses: Array<{ id: string; label: string; line1: string; line2: string | null; city: string; state: string; pincode: string; isDefault: boolean }>;
}

export interface OrderLineSnapshot {
  id: string;
  lineNo: number;
  productId: string | null;
  name: string | null;
  strength: string | null;
  packSize: string | null;
  unit: string | null;
  quantity: number;
  requestedText: string;
  status: 'active' | 'flagged';
  customerDecision: 'pending' | 'accepted' | 'declined';
  stockStatus: ItemStockStatus;
}

export interface OrderSnapshot {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  revision: number;
  items: OrderLineSnapshot[];
  totalPaise: number;
}

export interface CandidateProduct {
  productId: string;
  sku: string;
  name: string;
  brand: string | null;
  strength: string | null;
  form: string | null;
  packSize: string | null;
  unit: string | null;
  exact: boolean;
}

export interface StockCheck {
  productId: string;
  quantity: number;
  availableToSell: number | null;
  sufficient: boolean | null;
  status: 'in_stock' | 'out_of_stock' | 'unknown';
  isMock: boolean;
  checkedAt: number;
}

export interface ToolExecutionRecord {
  toolCallId: string;
  name: string;
  ok: boolean;
  result: unknown;
}

export interface ConversationSession {
  callId: string;
  provider: string;
  providerCallSid: string;
  fromNumber: string;
  state: ConversationState;
  language: Lang;
  customer: CustomerSummary | null;
  deliveryAddressId: string | null;
  orderId: string | null;
  /** Latest order snapshot returned by the backend; tools validate item ids against it. */
  order: OrderSnapshot | null;
  /** Catalogue candidates offered to the model in this session; add_order_item accepts only these ids. */
  candidates: Map<string, CandidateProduct>;
  /** Latest stock answer per product; add/update require a fresh, sufficient check. */
  stockChecks: Map<string, StockCheck>;
  /** Duplicate-execution guard: tool call id → result already returned. */
  executedToolCalls: Map<string, ToolExecutionRecord>;
  readbackRevision: number | null;
  identificationAttempts: number;
  handover: { reason: string; exceptionId: string | null } | null;
  /** Model-visible history (system prompt excluded); bounded by AI_HISTORY_MESSAGES. */
  messages: ChatMessage[];
  lastCustomerUtterance: string;
  turns: number;
  createdAt: number;
  lastActivityAt: number;
}

/** Everything the tools need from the backend. The real implementation delegates to the existing services. */
export interface ToolBackend {
  findCustomerByPhone(phone: string): Promise<CustomerSummary | null>;
  findOrderByCall(callId: string): Promise<OrderSnapshot | null>;
  createDraftOrder(input: { customerId: string; callId: string; deliveryAddressId?: string; customerPoReference?: string }, actor: Actor, meta: RequestMeta, idempotencyKey: string): Promise<OrderSnapshot>;
  searchProducts(query: string, limit: number): Promise<ProductSearchResult>;
  getProduct(productId: string): Promise<CandidateProduct | null>;
  getStock(productId: string, quantity: number): Promise<ProductStockResponse>;
  addItem(orderId: string, input: AddItemInput, actor: Actor, meta: RequestMeta): Promise<OrderSnapshot>;
  updateItem(orderId: string, itemId: string, input: UpdateItemInput, actor: Actor, meta: RequestMeta): Promise<OrderSnapshot>;
  removeItem(orderId: string, itemId: string, actor: Actor, meta: RequestMeta): Promise<OrderSnapshot>;
  readback(orderId: string, actor: Actor, meta: RequestMeta): Promise<ReadbackResult>;
  confirm(orderId: string, input: ConfirmOrderInput, actor: Actor, meta: RequestMeta): Promise<OrderSnapshot>;
  reserve(orderId: string, idempotencyKey: string, actor: Actor, meta: RequestMeta): Promise<ReservationOutcome>;
  raiseException(input: RaiseExceptionInput, actor: Actor): Promise<{ id: string }>;
}

/** What the orchestrator records about a session. The real implementation writes calls, transcripts, call_events, usage_costs. */
export interface SessionStore {
  recordTranscript(callId: string, entry: { speaker: 'customer' | 'agent' | 'system'; text: string; language: Lang; confidence?: number | null; toolCalls?: unknown }): Promise<void>;
  recordEvent(callId: string, event: { type: string; fromState?: ConversationState; toState?: ConversationState; toolName?: string; toolCallId?: string; ok?: boolean; data?: unknown }): Promise<void>;
  updateCall(callId: string, patch: { conversationState?: ConversationState; status?: 'in_progress' | 'completed' | 'handed_over' | 'failed'; language?: Lang; customerId?: string | null; handoverReason?: string | null; endedAt?: Date; aiSummary?: string | null }): Promise<void>;
  recordUsage(callId: string, usage: { provider: string; model: string; inputTokens: number; outputTokens: number }): Promise<void>;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; code: string; error: string; details?: unknown };

export interface TurnResult {
  reply: string;
  language: Lang;
  state: ConversationState;
  toolCalls: Array<{ name: string; ok: boolean }>;
  ended: boolean;
}
