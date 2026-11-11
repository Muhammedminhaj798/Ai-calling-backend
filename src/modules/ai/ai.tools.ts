// AI tool registry. Each tool validates its arguments with zod, is permitted only in specific conversation
// states, calls existing backend services through the ToolBackend seam, and never touches Prisma. Results
// carry an `instruction` for the model; the guarantees do not depend on the model following it.
import { z } from 'zod';
import type { ConversationState } from '../../generated/prisma/enums.ts';
import type { ToolCall, ToolDefinition } from '../../integrations/ai/ai.port.ts';
import { AppError } from '../../middleware/error-handler.ts';
import type { RequestMeta } from '../../utils/audit.ts';
import { extractQuantities } from '../../utils/language.ts';
import { AI_ACTOR, type CandidateProduct, type ConversationSession, type StockCheck, type ToolBackend, type ToolResult } from './ai.types.ts';
import { canTransitionConversation, isToolAllowed, TOOL_NAMES, type ToolName } from './conversation.state.ts';
import { HANDOVER_REASONS, triggerHandover } from './handover.ts';

export interface ToolContext {
  session: ConversationSession;
  backend: ToolBackend;
  meta: RequestMeta;
  now: () => number;
}

const STOCK_CHECK_MAX_AGE_MS = 5 * 60_000;
const MAX_IDENTIFICATION_ATTEMPTS = 2;

const ok = (data: unknown): ToolResult => ({ ok: true, data });
const fail = (code: string, error: string, details?: unknown): ToolResult => ({ ok: false, code, error, details });

function moveTo(session: ConversationSession, to: ConversationState): void {
  if (session.state !== to && canTransitionConversation(session.state, to)) session.state = to;
}

function requireCustomer(session: ConversationSession) {
  if (!session.customer) throw new AppError(409, 'CUSTOMER_NOT_IDENTIFIED', 'Identify the customer first with identify_customer');
  return session.customer;
}

function requireOrder(session: ConversationSession) {
  if (!session.orderId || !session.order) throw new AppError(409, 'ORDER_NOT_STARTED', 'Create the draft order first with create_draft_order');
  return session.order;
}

function requireCandidate(session: ConversationSession, productId: string): CandidateProduct {
  const candidate = session.candidates.get(productId);
  if (!candidate) {
    throw new AppError(422, 'PRODUCT_NOT_OFFERED', 'This product id was not returned by search_products in this call. Search the catalogue and let the customer choose.');
  }
  return candidate;
}

function requireFreshStockCheck(session: ConversationSession, productId: string, quantity: number, now: number): StockCheck {
  const check = session.stockChecks.get(productId);
  if (!check || check.quantity !== quantity || now - check.checkedAt > STOCK_CHECK_MAX_AGE_MS) {
    throw new AppError(409, 'STOCK_CHECK_REQUIRED', `Call check_inventory for this product with quantity ${quantity} first`);
  }
  if (check.sufficient !== true) {
    throw new AppError(409, 'STOCK_INSUFFICIENT', check.availableToSell === null
      ? 'The inventory system does not know this product. Record it for staff with flagReason out_of_stock, or skip it.'
      : `Only ${check.availableToSell} available. Ask the customer to choose a lower quantity, skip the item, or record it for staff with flagReason out_of_stock.`);
  }
  return check;
}

function quantityWarning(session: ConversationSession, quantity: number): string | undefined {
  const spoken = extractQuantities(session.lastCustomerUtterance);
  if (spoken.length === 0 || spoken.includes(quantity)) return undefined;
  return `The customer's last message mentioned ${spoken.join(' / ')} but you passed ${quantity}. Confirm the quantity with the customer.`;
}

function publicCandidate(c: CandidateProduct) {
  return { productId: c.productId, sku: c.sku, name: c.name, brand: c.brand, strength: c.strength, form: c.form, packSize: c.packSize, unit: c.unit, exact: c.exact };
}

// Ids are opaque to the model; the tools check them against this session's candidates / order lines and
// the backend services validate them further, so no format is assumed here.
const idSchema = z.string().min(1).max(64);

const confirmedDetailsSchema = z
  .object({
    name: z.string().min(1).max(200).describe('Medicine name as confirmed with the customer'),
    strength: z.string().min(1).max(50).optional().describe('Strength as confirmed, e.g. "650 mg"'),
    packSize: z.string().min(1).max(50).optional().describe('Pack size as confirmed, e.g. "15x10"'),
  })
  .describe('What the customer confirmed; the system checks it against the catalogue product');

const flagReasonSchema = z.enum(['product_not_found', 'ambiguous_product', 'out_of_stock', 'stock_unverified']);

interface ToolSpec<S extends z.ZodType> {
  name: ToolName;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

function spec<S extends z.ZodType>(s: ToolSpec<S>): ToolSpec<z.ZodType> {
  return s as unknown as ToolSpec<z.ZodType>;
}

export const TOOLS: Record<ToolName, ToolSpec<z.ZodType>> = {
  identify_customer: spec({
    name: 'identify_customer',
    description: 'Look up the registered customer by phone number. Use the caller number first; ask for a registered number only if that fails.',
    schema: z.object({ phone: z.string().min(5).max(20).describe('Phone number as given') }),
    async run(args, ctx) {
      const { session, backend } = ctx;
      session.identificationAttempts++;
      const customer = await backend.findCustomerByPhone(args.phone);
      if (!customer) {
        if (session.identificationAttempts >= MAX_IDENTIFICATION_ATTEMPTS) {
          const handover = await triggerHandover(session, backend, 'customer_not_registered', `no customer registered for ${args.phone}`);
          return fail('CUSTOMER_NOT_FOUND', 'No registered customer has this number. Handing over to staff.', { handover: true, exceptionId: handover.exceptionId });
        }
        return fail('CUSTOMER_NOT_FOUND', 'No registered customer has this phone number. Ask for the pharmacy\'s registered phone number once; if that also fails, call request_human_handover.');
      }
      if (customer.status !== 'active') {
        const handover = await triggerHandover(session, backend, 'customer_not_eligible', `customer ${customer.externalCode} is ${customer.status}`);
        return fail('CUSTOMER_NOT_ELIGIBLE', `Customer ${customer.name} is ${customer.status}; automated ordering is not allowed. Handing over to staff.`, { handover: true, exceptionId: handover.exceptionId });
      }
      session.customer = customer;
      moveTo(session, 'confirming_location');
      const defaultAddress = customer.addresses.find((a) => a.isDefault) ?? customer.addresses[0] ?? null;
      return ok({
        customerId: customer.id,
        name: customer.name,
        externalCode: customer.externalCode,
        preferredLanguage: customer.preferredLanguage,
        addresses: customer.addresses.map((a) => ({ addressId: a.id, label: a.label, line1: a.line1, city: a.city, isDefault: a.isDefault })),
        defaultAddressId: defaultAddress?.id ?? null,
        instruction: defaultAddress
          ? `Greet ${customer.name} by name and confirm delivery to "${defaultAddress.label}: ${defaultAddress.line1}, ${defaultAddress.city}". Then call create_draft_order with that addressId.`
          : `Greet ${customer.name}. No delivery address is on file: call create_draft_order without an address and note that staff will confirm the delivery location.`,
      });
    },
  }),

  get_customer_addresses: spec({
    name: 'get_customer_addresses',
    description: 'List the delivery addresses on file for the identified customer.',
    schema: z.object({}),
    async run(_args, ctx) {
      const customer = requireCustomer(ctx.session);
      return ok({ addresses: customer.addresses.map((a) => ({ addressId: a.id, label: a.label, line1: a.line1, line2: a.line2, city: a.city, state: a.state, pincode: a.pincode, isDefault: a.isDefault })) });
    },
  }),

  create_draft_order: spec({
    name: 'create_draft_order',
    description: 'Create the draft order for this call once the customer is identified and the delivery location is confirmed. Idempotent: returns the existing draft if one exists.',
    schema: z.object({
      deliveryAddressId: idSchema.optional().describe('Confirmed delivery address id from identify_customer'),
      customerPoReference: z.string().min(1).max(64).optional().describe('Customer purchase-order reference, if they gave one'),
    }),
    async run(args, ctx) {
      const { session, backend, meta } = ctx;
      const customer = requireCustomer(session);
      if (session.order) {
        moveTo(session, 'collecting_items');
        return ok({ orderId: session.order.id, orderNumber: session.order.orderNumber, existing: true, instruction: 'The draft already exists. Continue collecting medicines.' });
      }
      let deliveryAddressId = args.deliveryAddressId;
      if (deliveryAddressId && !customer.addresses.some((a) => a.id === deliveryAddressId)) {
        return fail('ADDRESS_NOT_FOUND', 'That address id does not belong to this customer. Use one from identify_customer or get_customer_addresses.');
      }
      if (!deliveryAddressId) deliveryAddressId = (customer.addresses.find((a) => a.isDefault) ?? customer.addresses[0])?.id;
      const existing = await backend.findOrderByCall(session.callId);
      const order = existing ?? (await backend.createDraftOrder({ customerId: customer.id, callId: session.callId, deliveryAddressId, customerPoReference: args.customerPoReference }, AI_ACTOR, meta, `call:${session.callId}:order`));
      session.order = order;
      session.orderId = order.id;
      session.deliveryAddressId = deliveryAddressId ?? null;
      moveTo(session, 'collecting_items');
      return ok({ orderId: order.id, orderNumber: order.orderNumber, existing: Boolean(existing), instruction: 'Ask the customer for the first medicine: name, strength, pack size and quantity.' });
    },
  }),

  search_products: spec({
    name: 'search_products',
    description: 'Search the catalogue for a medicine the customer named. Returns ranked candidates; an exact match is flagged. Never choose between several candidates yourself.',
    schema: z.object({
      query: z.string().min(2).max(100).describe('Medicine or brand name as the customer said it, optionally with strength'),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    async run(args, ctx) {
      const { session, backend } = ctx;
      requireOrder(session);
      const result = await backend.searchProducts(args.query, args.limit);
      const candidates = result.candidates.map((c): CandidateProduct => ({ productId: c.id, sku: c.externalCode, name: c.name, brand: c.brand, strength: c.strength, form: c.form, packSize: c.packSize, unit: c.unit, exact: c.exact }));
      for (const c of candidates) session.candidates.set(c.productId, c);
      moveTo(session, 'matching_products');
      const exact = result.exactMatch ? candidates.find((c) => c.productId === result.exactMatch!.id) ?? null : null;
      const instruction = exact
        ? `One exact match. Read back "${exact.name}${exact.strength ? ` ${exact.strength}` : ''}${exact.form ? ` ${exact.form}` : ''}, pack ${exact.packSize ?? 'unknown'}" and ask the customer to confirm it and the quantity before check_inventory.`
        : candidates.length > 0
          ? `${candidates.length} catalogue products match. Read the options (name, strength, pack size) and let the customer choose. Do not pick one yourself.`
          : 'No catalogue match. Ask the customer to repeat or spell the name once. If it is still unresolved, call add_order_item with flagReason product_not_found so staff can review it.';
      return ok({ query: args.query, exactMatch: exact ? publicCandidate(exact) : null, candidates: candidates.map(publicCandidate), instruction });
    },
  }),

  get_product_details: spec({
    name: 'get_product_details',
    description: 'Full catalogue details of a candidate product returned by search_products.',
    schema: z.object({ productId: idSchema }),
    async run(args, ctx) {
      const candidate = requireCandidate(ctx.session, args.productId);
      const stock = ctx.session.stockChecks.get(args.productId);
      return ok({ product: publicCandidate(candidate), lastStockCheck: stock ? { quantity: stock.quantity, availableToSell: stock.availableToSell, sufficient: stock.sufficient, isMock: stock.isMock } : null });
    },
  }),

  check_inventory: spec({
    name: 'check_inventory',
    description: 'Check available-to-sell stock for a candidate product and the exact quantity the customer wants. Required before add_order_item.',
    schema: z.object({ productId: idSchema, quantity: z.number().int().min(1).max(100_000) }),
    async run(args, ctx) {
      const { session, backend, now } = ctx;
      requireOrder(session);
      const candidate = requireCandidate(session, args.productId);
      moveTo(session, 'checking_inventory');
      let stock;
      try {
        stock = await backend.getStock(args.productId, args.quantity);
      } catch (err) {
        if (err instanceof AppError && err.status === 503) {
          session.stockChecks.delete(args.productId);
          return fail('INVENTORY_UNAVAILABLE', `Stock for ${candidate.name} cannot be confirmed right now. Tell the customer honestly. You may record the line for staff with add_order_item flagReason stock_unverified, or offer a handover.`);
        }
        throw err;
      }
      const check: StockCheck = { productId: args.productId, quantity: args.quantity, availableToSell: stock.availableToSell, sufficient: stock.sufficient, status: stock.status, isMock: stock.isMock, checkedAt: now() };
      session.stockChecks.set(args.productId, check);
      moveTo(session, check.sufficient ? 'building_order' : 'reviewing_shortages');
      const instruction = check.sufficient
        ? `${args.quantity} ${candidate.unit ? candidate.unit + '(s) ' : ''}of ${candidate.name} can be supplied. Confirm name, strength, pack and quantity with the customer, then call add_order_item with confirmedDetails.`
        : check.availableToSell === null
          ? `The inventory system does not know ${candidate.name}. Tell the customer it cannot be confirmed; offer to record it for staff (add_order_item with flagReason out_of_stock) or skip it.`
          : check.availableToSell === 0
            ? `${candidate.name} is out of stock. Tell the customer. Offer to record the request for staff (add_order_item with flagReason out_of_stock) or skip it. Do not suggest another brand.`
            : `Only ${check.availableToSell} of ${candidate.name} available, not ${args.quantity}. Tell the customer the exact number. They may take ${check.availableToSell} (check_inventory again with that quantity), skip it, or have it recorded for staff.`;
      return ok({ productId: args.productId, requestedQuantity: args.quantity, availableToSell: check.availableToSell, sufficient: check.sufficient, status: check.status, isMock: check.isMock, instruction });
    },
  }),

  add_order_item: spec({
    name: 'add_order_item',
    description: 'Add a line to the draft order. For a catalogue product: requires a fresh sufficient check_inventory for the same quantity and confirmedDetails. For an unresolved or unavailable request: pass flagReason instead of productId so staff review it.',
    schema: z
      .object({
        productId: idSchema.optional(),
        requestedText: z.string().min(1).max(300).describe("The customer's words for this item"),
        quantity: z.number().int().min(1).max(100_000),
        confirmedDetails: confirmedDetailsSchema.optional(),
        flagReason: flagReasonSchema.optional(),
      })
      .refine((a) => Boolean(a.productId) !== Boolean(a.flagReason), { message: 'Provide productId (with confirmedDetails) or flagReason, not both' })
      .refine((a) => !a.productId || Boolean(a.confirmedDetails), { message: 'confirmedDetails is required when adding a catalogue product' }),
    async run(args, ctx) {
      const { session, backend, meta, now } = ctx;
      const order = requireOrder(session);
      if (args.productId) {
        const candidate = requireCandidate(session, args.productId);
        requireFreshStockCheck(session, args.productId, args.quantity, now());
        const updated = await backend.addItem(order.id, { productId: args.productId, requestedText: args.requestedText, quantity: args.quantity, confirmedDetails: args.confirmedDetails }, AI_ACTOR, meta);
        session.order = updated;
        session.readbackRevision = null;
        moveTo(session, 'collecting_items');
        const line = updated.items.find((i) => i.productId === args.productId);
        return ok({ itemId: line?.id ?? null, lineNo: line?.lineNo ?? null, product: publicCandidate(candidate), quantity: args.quantity, lines: updated.items.length, warning: quantityWarning(session, args.quantity), instruction: 'Confirm the line was added and ask whether the customer needs anything else.' });
      }
      const updated = await backend.addItem(order.id, { requestedText: args.requestedText, quantity: args.quantity, flagReason: args.flagReason! }, AI_ACTOR, meta);
      session.order = updated;
      session.readbackRevision = null;
      moveTo(session, 'collecting_items');
      const line = updated.items.find((i) => i.status === 'flagged' && i.requestedText === args.requestedText);
      return ok({ itemId: line?.id ?? null, flagged: true, flagReason: args.flagReason, lines: updated.items.length, instruction: 'Tell the customer this item is noted for staff to review and will not be read back as a confirmed product. Ask whether they need anything else.' });
    },
  }),

  update_order_item: spec({
    name: 'update_order_item',
    description: 'Correct a line: change its quantity (needs a fresh sufficient check_inventory for the new quantity) or resolve an unresolved line to a candidate product.',
    schema: z
      .object({
        itemId: idSchema,
        quantity: z.number().int().min(1).max(100_000).optional(),
        productId: idSchema.optional(),
        confirmedDetails: confirmedDetailsSchema.optional(),
        requestedText: z.string().min(1).max(300).optional(),
      })
      .refine((a) => a.quantity !== undefined || a.productId !== undefined || a.requestedText !== undefined, { message: 'Nothing to update' }),
    async run(args, ctx) {
      const { session, backend, meta, now } = ctx;
      const order = requireOrder(session);
      const line = order.items.find((i) => i.id === args.itemId);
      if (!line) return fail('ITEM_NOT_FOUND', 'No such line on this order. Use the line ids from the order summary.');
      const productId = args.productId ?? line.productId;
      const quantity = args.quantity ?? line.quantity;
      if (args.productId) requireCandidate(session, args.productId);
      if (productId && (args.quantity !== undefined || args.productId)) requireFreshStockCheck(session, productId, quantity, now());
      const updated = await backend.updateItem(order.id, args.itemId, { quantity: args.quantity, productId: args.productId, confirmedDetails: args.confirmedDetails, requestedText: args.requestedText }, AI_ACTOR, meta);
      session.order = updated;
      session.readbackRevision = null;
      moveTo(session, 'collecting_items');
      return ok({ itemId: args.itemId, quantity, warning: args.quantity !== undefined ? quantityWarning(session, args.quantity) : undefined, instruction: 'Acknowledge the correction to the customer. If a read-back was already given, read the order back again before confirmation.' });
    },
  }),

  remove_order_item: spec({
    name: 'remove_order_item',
    description: 'Remove a line the customer no longer wants.',
    schema: z.object({ itemId: idSchema }),
    async run(args, ctx) {
      const { session, backend, meta } = ctx;
      const order = requireOrder(session);
      if (!order.items.some((i) => i.id === args.itemId)) return fail('ITEM_NOT_FOUND', 'No such line on this order.');
      session.order = await backend.removeItem(order.id, args.itemId, AI_ACTOR, meta);
      session.readbackRevision = null;
      moveTo(session, 'collecting_items');
      return ok({ removed: args.itemId, lines: session.order.items.length, instruction: 'Confirm the removal to the customer.' });
    },
  }),

  generate_order_readback: spec({
    name: 'generate_order_readback',
    description: 'Produce the complete read-back of the draft order (every line with name, strength, form, pack size and quantity). Read it to the customer before asking for confirmation.',
    schema: z.object({}),
    async run(_args, ctx) {
      const { session, backend, meta } = ctx;
      const order = requireOrder(session);
      if (!order.items.some((i) => i.status === 'active')) return fail('ORDER_EMPTY', 'There are no resolved lines to read back yet.');
      const readback = await backend.readback(order.id, AI_ACTOR, meta);
      session.readbackRevision = readback.revision;
      session.order = { ...order, status: 'pending_customer_confirmation', revision: readback.revision };
      moveTo(session, 'reading_back');
      moveTo(session, 'waiting_customer_confirmation');
      return ok({ revision: readback.revision, readbackText: readback.readbackText, lines: readback.lines, flaggedRequests: readback.flaggedRequests, instruction: `Read this complete list to the customer in ${session.language === 'en' ? 'English' : 'their language'}, then ask them to confirm or say what to change. When they clearly confirm, call record_customer_confirmation with revision ${readback.revision}.` });
    },
  }),

  record_customer_confirmation: spec({
    name: 'record_customer_confirmation',
    description: 'Record the customer\'s answer to the read-back for the given revision. confirmed=true places the order with staff for approval; confirmed=false reopens the order for changes.',
    schema: z.object({
      revision: z.number().int().min(1).describe('Revision from generate_order_readback'),
      confirmed: z.boolean(),
      declinedItemIds: z.array(idSchema).default([]).describe('Lines the customer declined during the read-back'),
    }),
    async run(args, ctx) {
      const { session, backend, meta } = ctx;
      const order = requireOrder(session);
      if (session.readbackRevision === null || args.revision !== session.readbackRevision) {
        return fail('STALE_REVISION', `The read-back revision is ${session.readbackRevision ?? 'none'}. Call generate_order_readback and read it again before confirming.`);
      }
      if (!args.confirmed) {
        session.readbackRevision = null;
        moveTo(session, 'collecting_items');
        return ok({ confirmed: false, instruction: 'Ask the customer what to change, apply it, then read the order back again.' });
      }
      const confirmed = await backend.confirm(order.id, { revision: args.revision, source: 'phone_ai', declinedItemIds: args.declinedItemIds, idempotencyKey: `call:${session.callId}:confirm:${args.revision}` }, AI_ACTOR, meta);
      session.order = confirmed;
      let reservation: { outcome: string; detail: string };
      try {
        const outcome = await backend.reserve(order.id, `call:${session.callId}:reserve:${args.revision}`, AI_ACTOR, meta);
        reservation = outcome.outcome === 'reserved'
          ? { outcome: 'reserved', detail: 'Stock reserved; order is with staff for approval.' }
          : { outcome: 'failed', detail: `Reservation failed (${outcome.reason}); staff will review.` };
      } catch (err) {
        reservation = { outcome: 'failed', detail: err instanceof AppError ? `${err.code}: staff will review` : 'staff will review' };
      }
      moveTo(session, 'completed');
      return ok({ confirmed: true, orderNumber: confirmed.orderNumber, revision: args.revision, reservation, instruction: `Thank the customer and tell them order ${confirmed.orderNumber} will be confirmed by staff before dispatch. Do not say it is approved or dispatched. Then say goodbye.` });
    },
  }),

  request_human_handover: spec({
    name: 'request_human_handover',
    description: 'Hand the call to staff: the customer asked for a person, is not registered or not eligible, or the request cannot be resolved.',
    schema: z.object({ reason: z.enum(HANDOVER_REASONS), details: z.string().max(500).optional() }),
    async run(args, ctx) {
      const outcome = await triggerHandover(ctx.session, ctx.backend, args.reason, args.details);
      return ok({ handover: true, exceptionId: outcome.exceptionId, instruction: `Say exactly this and nothing else: "${outcome.message}"` });
    },
  }),
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

/** Tool definitions offered to the model in the given state — disallowed tools are not even visible. */
export function toolDefinitionsFor(state: ConversationState): ToolDefinition[] {
  return TOOL_NAMES.filter((name) => isToolAllowed(name, state)).map((name) => {
    const t = TOOLS[name];
    return { name: t.name, description: t.description, parameters: jsonSchema(t.schema) };
  });
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Validates, authorises and runs one tool call. Never throws: every failure becomes an ok:false result. */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const { session } = ctx;
  const previous = session.executedToolCalls.get(call.id);
  if (previous) return previous.ok ? ok(previous.result) : (previous.result as ToolResult);

  let result: ToolResult;
  if (!isToolName(call.name)) {
    result = fail('UNKNOWN_TOOL', `Unknown tool ${call.name}`);
  } else if (!isToolAllowed(call.name, session.state)) {
    result = fail('TOOL_NOT_ALLOWED', `${call.name} is not allowed while the conversation is ${session.state}`);
  } else {
    let raw: unknown;
    try {
      raw = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
    } catch {
      raw = undefined;
    }
    const parsed = raw === undefined ? null : TOOLS[call.name].schema.safeParse(raw);
    if (!parsed || !parsed.success) {
      result = fail('INVALID_ARGUMENTS', 'Tool arguments are invalid', parsed ? parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) : 'arguments are not valid JSON');
    } else {
      try {
        result = await TOOLS[call.name].run(parsed.data, ctx);
      } catch (err) {
        result = err instanceof AppError ? fail(err.code, err.message, err.details) : fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
    }
  }
  session.executedToolCalls.set(call.id, { toolCallId: call.id, name: call.name, ok: result.ok, result: result.ok ? result.data : result });
  return result;
}
