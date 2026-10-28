import test from 'node:test';
import assert from 'node:assert/strict';
import { totals } from '../cart.mjs';

test('taxes every unit of taxable items', () => {
  const items = [{ sku: 'book', unitCents: 1299, quantity: 3, taxable: false }, { sku: 'lamp', unitCents: 2450, quantity: 2, taxable: true }];
  assert.deepEqual(totals(items, { taxRate: 0.0825 }), { subtotal: 8797, discount: 0, tax: 404, total: 9201 });
});
test('percent discount rounds half up', () => {
  assert.equal(totals([{ sku: 'gum', unitCents: 11, quantity: 1, taxable: false }], { coupon: { type: 'percent', value: 10 } }).discount, 1);
});
test('fixed coupon never makes the total negative', () => {
  assert.deepEqual(totals([{ sku: 'pen', unitCents: 300, quantity: 1, taxable: true }], { taxRate: 0.1, coupon: { type: 'fixed', value: 500 } }), { subtotal: 300, discount: 300, tax: 0, total: 0 });
});
