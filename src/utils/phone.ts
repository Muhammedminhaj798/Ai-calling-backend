// Phone normalisation to E.164. India is the default market: 10-digit mobiles (6–9 prefix) and
// 0-prefixed landlines become +91…; anything already written with a country code is validated as-is.
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(input: string): string | null {
  let s = input.trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) return E164.test(s) ? s : null;
  if (/^0?[6-9]\d{9}$/.test(s)) return `+91${s.slice(-10)}`; // mobile, optional trunk 0
  if (/^91[6-9]\d{9}$/.test(s)) return `+${s}`; // mobile with country code but no plus
  if (/^0\d{10}$/.test(s)) return `+91${s.slice(1)}`; // landline: trunk 0 + STD code + number
  return null;
}

export function isE164(value: string): boolean {
  return E164.test(value);
}
