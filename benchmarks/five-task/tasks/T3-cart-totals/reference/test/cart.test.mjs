import test from 'node:test';
import assert from 'node:assert/strict';
import { totals } from '../cart.mjs';

test('no coupon, no tax', () => {
  assert.deepEqual(totals([{ sku: 'a', unitCents: 250, quantity: 2, taxable: false }]), { subtotal: 500, discount: 0, tax: 0, total: 500 });
});
