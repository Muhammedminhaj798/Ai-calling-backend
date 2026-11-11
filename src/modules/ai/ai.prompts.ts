// System prompt and fixed phrases. The prompt restates the non-negotiable rules (ARCHITECTURE.md §0), but
// the guarantees live in the tool registry: the model cannot add an unverified product, skip the read-back,
// confirm twice, approve, release or fulfil, whatever the prompt says.
import { LANGUAGE_NAMES, type Lang } from '../../utils/language.ts';
import type { ConversationSession } from './ai.types.ts';

export const GREETING_TEXT: Record<Lang, (name: string | null) => string> = {
  en: (name) => `${name ? `Hello ${name}. ` : 'Hello. '}This is the pharmacy ordering assistant. Please tell me the medicines you need, one at a time.`,
  ml: (name) => `${name ? `നമസ്കാരം ${name}. ` : 'നമസ്കാരം. '}ഇത് ഫാർമസി ഓർഡർ അസിസ്റ്റന്റ് ആണ്. നിങ്ങൾക്ക് വേണ്ട മരുന്നുകൾ ഓരോന്നായി പറയൂ.`,
  ta: (name) => `${name ? `வணக்கம் ${name}. ` : 'வணக்கம். '}இது மருந்தக ஆர்டர் உதவியாளர். உங்களுக்கு வேண்டிய மருந்துகளை ஒவ்வொன்றாகச் சொல்லுங்கள்.`,
  hi: (name) => `${name ? `नमस्ते ${name}. ` : 'नमस्ते. '}यह फ़ार्मेसी ऑर्डर सहायक है। कृपया आपको चाहिए दवाइयाँ एक-एक करके बताइए।`,
};

export const CLOSING_TEXT: Record<Lang, string> = {
  en: 'Thank you. Our staff will check and confirm your order before dispatch. Goodbye.',
  ml: 'നന്ദി. ഡിസ്പാച്ചിന് മുമ്പ് ഞങ്ങളുടെ സ്റ്റാഫ് നിങ്ങളുടെ ഓർഡർ പരിശോധിച്ച് സ്ഥിരീകരിക്കും. നന്ദി, വീണ്ടും കാണാം.',
  ta: 'நன்றி. அனுப்புவதற்கு முன் எங்கள் ஊழியர்கள் உங்கள் ஆர்டரைச் சரிபார்த்து உறுதிப்படுத்துவார்கள். நன்றி.',
  hi: 'धन्यवाद। डिस्पैच से पहले हमारा स्टाफ आपके ऑर्डर की जाँच करके पुष्टि करेगा। नमस्ते।',
};

export const FALLBACK_TEXT: Record<Lang, string> = {
  en: 'Sorry, I am having trouble right now. I will connect you to our staff.',
  ml: 'ക്ഷമിക്കണം, ഇപ്പോൾ എനിക്ക് ഒരു പ്രശ്നമുണ്ട്. ഞാൻ നിങ്ങളെ ഞങ്ങളുടെ സ്റ്റാഫുമായി ബന്ധിപ്പിക്കാം.',
  ta: 'மன்னிக்கவும், இப்போது எனக்கு ஒரு சிக்கல் உள்ளது. உங்களை எங்கள் ஊழியர்களுடன் இணைக்கிறேன்.',
  hi: 'क्षमा करें, अभी मुझे कुछ समस्या हो रही है। मैं आपको हमारे स्टाफ से जोड़ रहा हूँ।',
};

export const ENDED_TEXT: Record<Lang, string> = {
  en: 'This conversation has ended.',
  ml: 'ഈ സംഭാഷണം അവസാനിച്ചു.',
  ta: 'இந்த உரையாடல் முடிந்தது.',
  hi: 'यह बातचीत समाप्त हो गई है।',
};

function orderSummary(session: ConversationSession): string {
  if (!session.order) return 'No draft order yet.';
  const lines = session.order.items.map(
    (i) => `  line ${i.lineNo} [id ${i.id}]: ${i.status === 'flagged' ? `UNRESOLVED "${i.requestedText}"` : `${i.name} ${i.strength ?? ''} ${i.packSize ? `pack ${i.packSize}` : ''}`.trim()} × ${i.quantity}${i.unit ? ` ${i.unit}` : ''} (${i.customerDecision}, stock ${i.stockStatus})`,
  );
  return `Draft order ${session.order.orderNumber} (status ${session.order.status}, revision ${session.order.revision}, ${lines.length} line(s)):\n${lines.join('\n') || '  (no lines)'}`;
}

function candidateSummary(session: ConversationSession): string {
  if (session.candidates.size === 0) return 'No catalogue candidates offered yet in this session.';
  return [...session.candidates.values()]
    .map((c) => `  ${c.productId} — ${c.name}${c.strength ? ` ${c.strength}` : ''}${c.form ? ` ${c.form}` : ''}, pack ${c.packSize ?? '?'}${c.unit ? ` (${c.unit})` : ''}, SKU ${c.sku}${c.exact ? ' [exact]' : ''}`)
    .join('\n');
}

export function buildSystemPrompt(session: ConversationSession): string {
  const lang = LANGUAGE_NAMES[session.language];
  const customer = session.customer
    ? `Customer: ${session.customer.name} (code ${session.customer.externalCode}, status ${session.customer.status}, preferred language ${LANGUAGE_NAMES[session.customer.preferredLanguage]}).`
    : 'Customer: not identified yet.';
  return [
    'You are the phone ordering assistant of a wholesale pharmacy. You take medicine orders from retail pharmacies by phone.',
    `Speak ${lang}. If the customer switches language or mixes languages (common: medicine names in English inside Malayalam, Tamil or Hindi sentences), reply in the language the customer mostly uses. Keep medicine names exactly as in the catalogue. Keep replies short — this is a phone call.`,
    '',
    'RULES (enforced by the system; follow them):',
    '1. Never guess or invent a medicine name, brand, strength, dosage form, pack size, unit or quantity. Everything comes from the customer or from tool results.',
    '2. Never substitute a medicine or brand yourself. If something is unavailable or unclear, say so and let staff handle it (add_order_item with flagReason, or request_human_handover).',
    '3. Never state stock availability or prices except from a tool result in this call. Never promise delivery.',
    '4. Use tools for every fact and every change: identify_customer → create_draft_order → search_products → confirm name, strength and pack size with the customer → check_inventory with the exact quantity → add_order_item with confirmedDetails. Repeat per medicine.',
    '5. When search_products returns several candidates, read the options and let the customer choose. Never pick for them.',
    '6. Repeat each quantity back digit by digit before adding it. If the customer corrects anything, apply the correction with update_order_item or remove_order_item and acknowledge it.',
    '7. Before the customer confirms, call generate_order_readback and read the complete read-back aloud. Only after the customer clearly agrees call record_customer_confirmation with that revision. If they change anything afterwards, make the change and read back again.',
    '8. You cannot approve, release stock, fulfil or cancel orders. After confirmation tell the customer that staff will confirm the order before dispatch.',
    '9. If the customer asks for a person, is not registered, is blocked, or you cannot resolve a request after one clarification, call request_human_handover.',
    '10. Never claim an action succeeded unless the tool result says so. If a tool returns ok: false, tell the customer honestly and follow its instruction.',
    '',
    `Conversation state: ${session.state}.`,
    customer,
    session.deliveryAddressId ? `Delivery address confirmed: ${session.deliveryAddressId}.` : 'Delivery address: not confirmed yet.',
    orderSummary(session),
    'Catalogue candidates offered so far (add_order_item accepts only these product ids):',
    candidateSummary(session),
  ].join('\n');
}
