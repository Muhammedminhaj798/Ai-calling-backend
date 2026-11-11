import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProductSchema, updateProductSchema } from '../products/products.validation.ts';
import { addressSchema, createCustomerSchema, updateAddressSchema, updateCustomerSchema } from './customers.validation.ts';

// Regression for a real bug: `.partial()` on a schema whose fields carry `.default()` still applied the
// defaults, so PATCH { name } reset status to `active` and cleared alternate phones.
describe('update schemas carry no defaults', () => {
  it('customer create applies defaults, customer update sends only the given keys', () => {
    const created = createCustomerSchema.parse({ externalCode: 'C1', name: 'A', phonePrimary: '9847012345' });
    assert.equal(created.status, 'active');
    assert.equal(created.preferredLanguage, 'en');
    assert.deepEqual(created.phoneAlternates, []);

    const update = updateCustomerSchema.parse({ name: 'B' });
    assert.deepEqual(Object.keys(update), ['name']);
    assert.equal(updateCustomerSchema.safeParse({}).success, false);
    assert.deepEqual(updateCustomerSchema.parse({ phoneAlternates: ['09847012345'] }), { phoneAlternates: ['+919847012345'] });
  });

  it('product create applies the status default, product update does not', () => {
    assert.equal(createProductSchema.parse({ externalCode: 'S', name: 'N', packSize: '10x10' }).status, 'active');
    assert.deepEqual(Object.keys(updateProductSchema.parse({ ptrPaise: 100 })), ['ptrPaise']);
    assert.equal(updateProductSchema.safeParse({}).success, false);
  });

  it('address create defaults label/isDefault, address update does not touch isDefault', () => {
    const created = addressSchema.parse({ line1: 'x', city: 'c', state: 's', pincode: '682001' });
    assert.equal(created.label, 'Default');
    assert.equal(created.isDefault, false);
    assert.deepEqual(Object.keys(updateAddressSchema.parse({ label: 'Shop' })), ['label']);
  });
});
