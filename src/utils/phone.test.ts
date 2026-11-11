import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isE164, normalizePhone } from './phone.ts';

describe('normalizePhone', () => {
  const cases: Array<[string, string | null]> = [
    ['+91 98470 12345', '+919847012345'],
    ['9847012345', '+919847012345'],
    ['09847012345', '+919847012345'],
    ['919847012345', '+919847012345'],
    ['0091 9847012345', '+919847012345'],
    ['(0484) 234-5678', '+914842345678'],
    ['+1 415 555 2671', '+14155552671'],
    ['12345', null],
    ['abc', null],
    ['+0 123456789', null],
    ['', null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => assert.equal(normalizePhone(input), expected));
  }
});

describe('isE164', () => {
  it('accepts normalised numbers and rejects everything else', () => {
    assert.equal(isE164('+919847012345'), true);
    assert.equal(isE164('9847012345'), false);
    assert.equal(isE164('+91 9847012345'), false);
  });
});
