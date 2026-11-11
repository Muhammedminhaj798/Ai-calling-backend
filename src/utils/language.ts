// Language handling for the four supported languages. Detection is script-based (Malayalam, Tamil and
// Devanagari are unambiguous Unicode blocks; Latin letters are treated as English). The model does the
// real understanding; these helpers choose speech locales, prompts and sanity-check quantities.
import type { Language } from '../generated/prisma/enums.ts';

export type Lang = Language;
export const LANGS: readonly Lang[] = ['en', 'ml', 'ta', 'hi'];

export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', ml: 'Malayalam', ta: 'Tamil', hi: 'Hindi' };
/** BCP-47 locales used by Google Speech-to-Text and Text-to-Speech. */
export const SPEECH_LOCALES: Record<Lang, string> = { en: 'en-IN', ml: 'ml-IN', ta: 'ta-IN', hi: 'hi-IN' };

const SCRIPT_RANGES: Record<Lang, RegExp> = {
  ml: /[ഀ-ൿ]/g,
  ta: /[஀-௿]/g,
  hi: /[ऀ-ॿ]/g,
  en: /[A-Za-z]/g,
};

export interface LanguageDetection {
  /** Dominant language by letter count, or null when the text has no letters (digits/punctuation only). */
  primary: Lang | null;
  /** True when a second language accounts for at least 20 % of the letters (code-switching). */
  mixed: boolean;
  shares: Record<Lang, number>;
  lettersCounted: number;
}

export function detectLanguage(text: string): LanguageDetection {
  const counts = Object.fromEntries(LANGS.map((l) => [l, (text.match(SCRIPT_RANGES[l]) ?? []).length])) as Record<Lang, number>;
  const total = LANGS.reduce((n, l) => n + counts[l], 0);
  const shares = Object.fromEntries(LANGS.map((l) => [l, total === 0 ? 0 : counts[l] / total])) as Record<Lang, number>;
  if (total === 0) return { primary: null, mixed: false, shares, lettersCounted: 0 };
  const ranked = [...LANGS].sort((a, b) => shares[b] - shares[a]);
  return { primary: ranked[0]!, mixed: (shares[ranked[1]!] ?? 0) >= 0.2, shares, lettersCounted: total };
}

/**
 * Which language the session should speak after an utterance. A non-Latin script wins outright; Latin text
 * (English, or a transliterated Indian language) keeps the current session language, then the customer's
 * preferred language, then the configured default.
 */
export function resolveSessionLanguage(detected: LanguageDetection, current: Lang | null, preferred: Lang | null, fallback: Lang): Lang {
  if (detected.primary && detected.primary !== 'en') return detected.primary;
  return current ?? preferred ?? fallback;
}

const NATIVE_DIGITS: Array<[RegExp, number]> = [
  [/[०-९]/g, 0x0966], // Devanagari ०-९
  [/[௦-௯]/g, 0x0be6], // Tamil ௦-௯
  [/[൦-൯]/g, 0x0d66], // Malayalam ൦-൯
];

/** Rewrites Devanagari, Tamil and Malayalam digits as ASCII digits. */
export function normalizeDigits(text: string): string {
  let out = text;
  for (const [re, base] of NATIVE_DIGITS) out = out.replace(re, (ch) => String(ch.charCodeAt(0) - base));
  return out;
}

// Common spoken quantities. Only exact words are matched; the model remains responsible for understanding.
const NUMBER_WORDS: Record<Lang, Record<string, number>> = {
  en: { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 },
  hi: { एक: 1, दो: 2, तीन: 3, चार: 4, पांच: 5, पाँच: 5, छह: 6, सात: 7, आठ: 8, नौ: 9, दस: 10, बारह: 12, पंद्रह: 15, बीस: 20, तीस: 30, चालीस: 40, पचास: 50, सौ: 100 },
  ta: { ஒன்று: 1, இரண்டு: 2, மூன்று: 3, நான்கு: 4, ஐந்து: 5, ஆறு: 6, ஏழு: 7, எட்டு: 8, ஒன்பது: 9, பத்து: 10, பன்னிரண்டு: 12, பதினைந்து: 15, இருபது: 20, முப்பது: 30, நாற்பது: 40, ஐம்பது: 50, நூறு: 100 },
  ml: { ഒന്ന്: 1, രണ്ട്: 2, മൂന്ന്: 3, നാല്: 4, അഞ്ച്: 5, ആറ്: 6, ഏഴ്: 7, എട്ട്: 8, ഒമ്പത്: 9, പത്ത്: 10, പന്ത്രണ്ട്: 12, പതിനഞ്ച്: 15, ഇരുപത്: 20, മുപ്പത്: 30, നാൽപ്പത്: 40, അമ്പത്: 50, നൂറ്: 100 },
};

/** Every explicit quantity in an utterance: ASCII/native digits plus common number words in all four languages. */
export function extractQuantities(text: string): number[] {
  const normalised = normalizeDigits(text);
  const found: number[] = [];
  for (const m of normalised.matchAll(/\d{1,6}/g)) found.push(Number(m[0]));
  const tokens = normalised.toLowerCase().split(/[\s,.;:!?()]+/).filter(Boolean);
  for (const token of tokens) {
    for (const lang of LANGS) {
      const n = NUMBER_WORDS[lang][token];
      if (n !== undefined) found.push(n);
    }
  }
  return found;
}
