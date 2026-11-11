import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeProductImport, rupeesToPaise, type ExistingProductRef } from './products.import.ts';
import { isExactProductMatch, productDuplicateKey } from './products.rules.ts';

const base = {
  sku: 'DOLO-650',
  name: 'Dolo 650',
  brand: 'Dolo',
  generic_name: 'Paracetamol',
  strength: '650 mg',
  form: 'Tablet',
  pack_size: '15x10',
  unit: 'Strip',
  manufacturer: 'Micro Labs',
  mrp: '₹32.50',
  ptr: '26',
  gst_rate: '12%',
  status: '',
};

const existing: ExistingProductRef[] = [
  { id: 'p-1', externalCode: 'CAL-650', duplicateKey: productDuplicateKey({ name: 'Calpol 650', strength: '650 mg', packSize: '15x10', manufacturer: 'GSK' }) },
  { id: 'p-2', externalCode: 'DOLO-500', duplicateKey: productDuplicateKey({ name: 'Dolo 500', strength: '500 mg', packSize: '15x10', manufacturer: 'Micro Labs' }) },
];

describe('rupeesToPaise', () => {
  it('converts rupee text to integer paise and leaves blanks undefined', () => {
    assert.equal(rupeesToPaise('32.50'), 3250);
    assert.equal(rupeesToPaise('₹1,250'), 125000);
    assert.equal(rupeesToPaise(''), undefined);
    assert.equal(rupeesToPaise(undefined), undefined);
    assert.ok(Number.isNaN(rupeesToPaise('abc')));
  });
});

describe('analyzeProductImport', () => {
  it('plans a create with normalised prices, form, unit and status', () => {
    const plan = analyzeProductImport([base], existing);
    const row = plan.rows[0]!;
    assert.deepEqual(row.errors, []);
    assert.equal(row.action, 'create');
    assert.equal(row.input?.mrpPaise, 3250);
    assert.equal(row.input?.ptrPaise, 2600);
    assert.equal(row.input?.gstRate, 12);
    assert.equal(row.input?.form, 'tablet');
    assert.equal(row.input?.unit, 'strip');
    assert.equal(row.input?.status, 'active');
  });

  it('plans an update for an existing SKU even when its identity is unchanged', () => {
    const plan = analyzeProductImport([{ ...base, sku: 'dolo-500', name: 'Dolo 500', strength: '500 mg' }], existing);
    assert.equal(plan.rows[0]?.action, 'update');
    assert.equal(plan.rows[0]?.existingId, 'p-2');
    assert.deepEqual(plan.rows[0]?.errors, []);
  });

  it('rejects a new SKU that describes an existing product', () => {
    const plan = analyzeProductImport([{ ...base, sku: 'NEW-1', name: 'calpol 650', manufacturer: 'gsk' }], existing);
    assert.match(plan.rows[0]?.errors[0]?.message ?? '', /Same product as existing SKU CAL-650/);
  });

  it('flags duplicate SKUs and duplicate identities within the file', () => {
    const plan = analyzeProductImport([base, { ...base, sku: 'DOLO-650-B' }, { ...base, name: 'Other' }], existing);
    assert.deepEqual(plan.rows[0]?.errors, []);
    assert.match(plan.rows[1]?.errors[0]?.message ?? '', /Same product .* as row 2/);
    assert.match(plan.rows[2]?.errors[0]?.message ?? '', /Duplicate sku, first seen on row 2/);
    assert.deepEqual(plan.summary, { total: 3, create: 1, update: 0, error: 2 });
  });

  it('reports invalid numbers and missing required columns per row', () => {
    const plan = analyzeProductImport([{ ...base, mrp: 'free', pack_size: '' }], existing);
    const fields = plan.rows[0]!.errors.map((e) => e.field);
    assert.ok(fields.includes('mrpPaise'));
    assert.ok(fields.includes('packSize'));
  });
});

describe('product rules', () => {
  it('duplicate key ignores case and whitespace', () => {
    const a = productDuplicateKey({ name: ' Dolo  650 ', strength: '650 MG', packSize: '15x10', manufacturer: 'Micro Labs' });
    const b = productDuplicateKey({ name: 'dolo 650', strength: '650 mg', packSize: '15X10', manufacturer: 'micro labs' });
    assert.equal(a, b);
    assert.notEqual(a, productDuplicateKey({ name: 'Dolo 650', strength: '650 mg', packSize: '10x10', manufacturer: 'Micro Labs' }));
  });

  it('exact match requires the full SKU or full name, never a partial', () => {
    const p = { externalCode: 'DOLO-650', name: 'Dolo 650' };
    assert.equal(isExactProductMatch(p, 'dolo 650'), true);
    assert.equal(isExactProductMatch(p, 'DOLO-650'), true);
    assert.equal(isExactProductMatch(p, 'Dolo'), false);
    assert.equal(isExactProductMatch(p, 'Dolo 65'), false);
  });
});
