import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectLanguage, extractQuantities, normalizeDigits, resolveSessionLanguage, SPEECH_LOCALES } from './language.ts';

describe('detectLanguage', () => {
  it('recognises each supported script', () => {
    assert.equal(detectLanguage('I need twenty strips of Dolo 650').primary, 'en');
    assert.equal(detectLanguage('എനിക്ക് ഡോളോ 650 ഇരുപത് സ്ട്രിപ്പ് വേണം').primary, 'ml');
    assert.equal(detectLanguage('எனக்கு டோலோ 650 இருபது ஸ்ட்ரிப் வேண்டும்').primary, 'ta');
    assert.equal(detectLanguage('मुझे डोलो 650 के बीस स्ट्रिप चाहिए').primary, 'hi');
  });

  it('flags code-switching: medicine names in English inside a Malayalam sentence', () => {
    const d = detectLanguage('Dolo 650 രണ്ട് strip വേണം, Calpol ഒന്ന്');
    assert.equal(d.primary, 'en'); // more Latin letters than Malayalam here
    assert.equal(d.mixed, true);
    const ml = detectLanguage('എനിക്ക് Dolo 650 strip വേണം');
    assert.equal(ml.primary, 'ml');
    assert.equal(ml.mixed, true);
    const pure = detectLanguage('എനിക്ക് ഡോളോ അറുനൂറ്റി അമ്പത് വേണം');
    assert.equal(pure.mixed, false);
  });

  it('returns null for text without letters', () => {
    const d = detectLanguage('650 / 15 * 10');
    assert.equal(d.primary, null);
    assert.equal(d.mixed, false);
  });
});

describe('resolveSessionLanguage', () => {
  it('switches to a non-Latin script immediately and keeps the current language for Latin text', () => {
    assert.equal(resolveSessionLanguage(detectLanguage('வணக்கம்'), 'en', 'ml', 'en'), 'ta');
    assert.equal(resolveSessionLanguage(detectLanguage('hello'), 'ml', 'ml', 'en'), 'ml', 'transliterated Malayalam keeps the session language');
    assert.equal(resolveSessionLanguage(detectLanguage('hello'), null, 'hi', 'en'), 'hi', 'falls back to the customer preference');
    assert.equal(resolveSessionLanguage(detectLanguage('hello'), null, null, 'en'), 'en');
    assert.equal(resolveSessionLanguage(detectLanguage('650'), 'ta', null, 'en'), 'ta', 'digits only never change the language');
  });

  it('maps every language to an Indian speech locale', () => {
    assert.deepEqual(SPEECH_LOCALES, { en: 'en-IN', ml: 'ml-IN', ta: 'ta-IN', hi: 'hi-IN' });
  });
});

describe('digits and quantities', () => {
  it('normalises Devanagari, Tamil and Malayalam digits', () => {
    assert.equal(normalizeDigits('२० strips और ५ bottles'), '20 strips और 5 bottles');
    assert.equal(normalizeDigits('௧௫ ஸ்ட்ரிப்'), '15 ஸ்ட்ரிப்');
    assert.equal(normalizeDigits('൧൦ bottle'), '10 bottle');
  });

  it('extracts explicit quantities in all four languages', () => {
    assert.deepEqual(extractQuantities('twenty strips of Dolo and 5 bottles'), [5, 20]);
    assert.deepEqual(extractQuantities('डोलो बीस स्ट्रिप'), [20]);
    assert.deepEqual(extractQuantities('டோலோ இருபது ஸ்ட்ரிப்'), [20]);
    assert.deepEqual(extractQuantities('ഡോളോ ഇരുപത് സ്ട്രിപ്പ്'), [20]);
    assert.deepEqual(extractQuantities('Dolo 650 രണ്ട് strip'), [650, 2]);
    assert.deepEqual(extractQuantities('no numbers here'), []);
  });
});
