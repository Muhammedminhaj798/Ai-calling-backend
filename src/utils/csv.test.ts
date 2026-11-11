import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvCell, parseCsv, parseCsvRecords, toCsv } from './csv.ts';

describe('parseCsvRecords', () => {
  it('handles quotes, escaped quotes, CRLF, BOM and blank lines', () => {
    const text = '﻿a,b,c\r\n1,"two, with comma","say ""hi"""\r\n\r\nx,,z\n';
    assert.deepEqual(parseCsvRecords(text), [
      ['a', 'b', 'c'],
      ['1', 'two, with comma', 'say "hi"'],
      ['x', '', 'z'],
    ]);
  });

  it('keeps newlines inside quoted fields', () => {
    assert.deepEqual(parseCsvRecords('a\n"line1\nline2"'), [['a'], ['line1\nline2']]);
  });

  it('returns no records for empty input', () => {
    assert.deepEqual(parseCsvRecords(''), []);
  });
});

describe('parseCsv', () => {
  it('lower-cases headers, trims cells and pads short rows', () => {
    const { headers, rows } = parseCsv(' SKU ,Name\nA1, Dolo 650 \nB2');
    assert.deepEqual(headers, ['sku', 'name']);
    assert.deepEqual(rows, [
      { sku: 'A1', name: 'Dolo 650' },
      { sku: 'B2', name: '' },
    ]);
  });
});

describe('csvCell / toCsv', () => {
  it('neutralises spreadsheet formula injection', () => {
    assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
    assert.equal(csvCell('+1234'), "'+1234");
    assert.equal(csvCell('-5'), "'-5");
    assert.equal(csvCell('@cmd'), "'@cmd");
  });

  it('quotes only when needed and serialises null as empty', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell(null), '');
    assert.equal(toCsv(['a', 'b'], [[1, 'x,y']]), 'a,b\r\n1,"x,y"\r\n');
  });
});
