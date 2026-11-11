import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeCustomerImport, csvRowToCustomerInput, type ExistingCustomerRef } from './customers.import.ts';
import { isEligibleForAutomatedOrdering, normaliseDefaultAddress } from './customers.rules.ts';

const base = {
  external_code: 'C-100',
  name: 'Sample Medicals',
  phone_primary: '98470 12345',
  phone_alternates: '0484 2345678; 9000000002',
  email: 'Shop@Example.com',
  gstin: '32abcde1234f1z5',
  preferred_language: 'ML',
  status: '',
  address_line1: '1 Market Road',
  city: 'Kochi',
  state: 'Kerala',
  pincode: '682001',
};

const existing: ExistingCustomerRef[] = [
  { id: 'id-existing', externalCode: 'C-001', phones: ['+919111111111', '+919111111112'] },
];

describe('analyzeCustomerImport', () => {
  it('plans a create with normalised phones, lower-cased email, upper-cased GSTIN and a default address', () => {
    const plan = analyzeCustomerImport([base], existing);
    const row = plan.rows[0]!;
    assert.deepEqual(row.errors, []);
    assert.equal(row.action, 'create');
    assert.equal(row.input?.phonePrimary, '+919847012345');
    assert.deepEqual(row.input?.phoneAlternates, ['+914842345678', '+919000000002']);
    assert.equal(row.input?.email, 'shop@example.com');
    assert.equal(row.input?.gstin, '32ABCDE1234F1Z5');
    assert.equal(row.input?.preferredLanguage, 'ml');
    assert.equal(row.input?.status, 'active');
    assert.equal(row.input?.addresses[0]?.isDefault, true);
    assert.deepEqual(plan.summary, { total: 1, create: 1, update: 0, error: 0 });
  });

  it('plans an update when the external code already exists', () => {
    const plan = analyzeCustomerImport([{ ...base, external_code: 'c-001', phone_primary: '9111111111' }], existing);
    assert.equal(plan.rows[0]?.action, 'update');
    assert.equal(plan.rows[0]?.existingId, 'id-existing');
    assert.deepEqual(plan.rows[0]?.errors, []);
  });

  it('reports validation errors per field with the file line number', () => {
    const plan = analyzeCustomerImport([{ ...base, phone_primary: '12', pincode: '12' }], existing);
    const row = plan.rows[0]!;
    assert.equal(row.row, 2);
    assert.equal(row.action, undefined);
    assert.ok(row.errors.some((e) => e.field === 'phonePrimary'));
    assert.ok(row.errors.some((e) => e.field === 'addresses.0.pincode'));
    assert.equal(plan.summary.error, 1);
  });

  it('flags duplicate codes and phones within the file', () => {
    const plan = analyzeCustomerImport(
      [base, { ...base, external_code: 'C-200', phone_primary: '9847012345' }, { ...base, phone_primary: '9333333333', phone_alternates: '' }],
      existing,
    );
    assert.deepEqual(plan.rows[0]?.errors, []);
    assert.match(plan.rows[1]?.errors[0]?.message ?? '', /also appears on row 2/);
    assert.match(plan.rows[2]?.errors[0]?.message ?? '', /Duplicate external_code, first seen on row 2/);
  });

  it('flags a phone that belongs to another existing customer, but not to the row being updated', () => {
    const stolen = analyzeCustomerImport([{ ...base, phone_alternates: '9111111112' }], existing);
    assert.match(stolen.rows[0]?.errors[0]?.message ?? '', /registered to another customer/);

    const own = analyzeCustomerImport([{ ...base, external_code: 'C-001', phone_primary: '9111111111', phone_alternates: '' }], existing);
    assert.deepEqual(own.rows[0]?.errors, []);
  });

  it('maps blank optional columns to undefined and no address when address_line1 is empty', () => {
    const input = csvRowToCustomerInput({ external_code: 'X', name: 'Y', phone_primary: '9847012345', email: '', city: 'Kochi' }) as {
      email?: string;
      addresses: unknown[];
    };
    assert.equal(input.email, undefined);
    assert.deepEqual(input.addresses, []);
  });
});

describe('customer rules', () => {
  it('only active customers are eligible for automated ordering', () => {
    assert.equal(isEligibleForAutomatedOrdering({ status: 'active' }), true);
    assert.equal(isEligibleForAutomatedOrdering({ status: 'inactive' }), false);
    assert.equal(isEligibleForAutomatedOrdering({ status: 'blocked' }), false);
  });

  it('keeps exactly one default address', () => {
    assert.deepEqual(normaliseDefaultAddress([{ isDefault: false }, { isDefault: false }]), [{ isDefault: true }, { isDefault: false }]);
    assert.deepEqual(normaliseDefaultAddress([{ isDefault: true }, { isDefault: true }]), [{ isDefault: true }, { isDefault: false }]);
    assert.deepEqual(normaliseDefaultAddress([{ isDefault: false }, { isDefault: true }]), [{ isDefault: false }, { isDefault: true }]);
    assert.deepEqual(normaliseDefaultAddress([]), []);
  });
});
