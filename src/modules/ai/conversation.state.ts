// Conversation state machine (ARCHITECTURE.md §A.4). The orchestrator moves between states as tools
// succeed; tool permissions per state are enforced here, on the backend, never by prompt alone.
import type { ConversationState } from '../../generated/prisma/enums.ts';
import { AppError } from '../../middleware/error-handler.ts';

export const TERMINAL_CONVERSATION_STATES: readonly ConversationState[] = ['completed', 'failed'];

/** Flow transitions. Every non-terminal state may also move to handover_required, completed or failed. */
const FLOW: Record<ConversationState, readonly ConversationState[]> = {
  initializing: ['identifying_customer'],
  identifying_customer: ['confirming_location'],
  confirming_location: ['collecting_items'],
  collecting_items: ['matching_products', 'checking_inventory', 'building_order', 'reading_back'],
  matching_products: ['collecting_items', 'checking_inventory', 'building_order'],
  checking_inventory: ['reviewing_shortages', 'building_order', 'collecting_items', 'matching_products'],
  reviewing_shortages: ['collecting_items', 'matching_products', 'checking_inventory', 'building_order'],
  building_order: ['collecting_items', 'matching_products', 'checking_inventory', 'reading_back'],
  reading_back: ['waiting_customer_confirmation', 'collecting_items'],
  waiting_customer_confirmation: ['collecting_items', 'matching_products', 'checking_inventory', 'reading_back'],
  handover_required: [],
  completed: [],
  failed: [],
};

const EXIT_STATES: readonly ConversationState[] = ['handover_required', 'completed', 'failed'];

export const CONVERSATION_TRANSITIONS: Readonly<Record<ConversationState, readonly ConversationState[]>> = Object.fromEntries(
  (Object.keys(FLOW) as ConversationState[]).map((from) => [
    from,
    TERMINAL_CONVERSATION_STATES.includes(from) ? [] : from === 'handover_required' ? ['completed', 'failed'] : [...FLOW[from], ...EXIT_STATES],
  ]),
) as unknown as Record<ConversationState, readonly ConversationState[]>;

export function canTransitionConversation(from: ConversationState, to: ConversationState): boolean {
  return CONVERSATION_TRANSITIONS[from].includes(to);
}

export function isTerminalConversation(state: ConversationState): boolean {
  return TERMINAL_CONVERSATION_STATES.includes(state);
}

export function assertConversationTransition(from: ConversationState, to: ConversationState): void {
  if (!canTransitionConversation(from, to)) {
    throw new AppError(409, 'INVALID_CONVERSATION_STATE', `Conversation cannot move from ${from} to ${to}`, { from, to });
  }
}

export const TOOL_NAMES = [
  'identify_customer',
  'get_customer_addresses',
  'search_products',
  'get_product_details',
  'check_inventory',
  'create_draft_order',
  'add_order_item',
  'update_order_item',
  'remove_order_item',
  'generate_order_readback',
  'record_customer_confirmation',
  'request_human_handover',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const ITEM_STATES: readonly ConversationState[] = [
  'collecting_items',
  'matching_products',
  'checking_inventory',
  'reviewing_shortages',
  'building_order',
  'reading_back',
  'waiting_customer_confirmation',
];
const ACTIVE_STATES: readonly ConversationState[] = ['initializing', 'identifying_customer', 'confirming_location', ...ITEM_STATES];

/** Which tools the model may call in each state. Disallowed tools are not even offered to the model. */
export const TOOL_PERMISSIONS: Readonly<Record<ToolName, readonly ConversationState[]>> = {
  identify_customer: ['initializing', 'identifying_customer'],
  get_customer_addresses: ['identifying_customer', 'confirming_location', ...ITEM_STATES],
  create_draft_order: ['confirming_location', 'collecting_items'],
  search_products: ITEM_STATES,
  get_product_details: ITEM_STATES,
  check_inventory: ITEM_STATES,
  add_order_item: ITEM_STATES,
  update_order_item: ITEM_STATES,
  remove_order_item: ITEM_STATES,
  generate_order_readback: ITEM_STATES,
  record_customer_confirmation: ['waiting_customer_confirmation'],
  request_human_handover: ACTIVE_STATES,
};

export function isToolAllowed(tool: ToolName, state: ConversationState): boolean {
  return TOOL_PERMISSIONS[tool].includes(state);
}
