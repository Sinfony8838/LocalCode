import { applyCoupon } from './discount.mjs';
import { roundCents } from './money.mjs';

/**
 * items: [{ sku, unitCents, quantity, taxable }]
 * Tax applies only to taxable items, after the coupon is distributed
 * proportionally across the subtotal.
 */
export function totals(items, { taxRate = 0, coupon } = {}) {
  const subtotal = items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
  const taxableSubtotal = items.filter(item => item.taxable).reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
  const discounted = applyCoupon(subtotal, coupon);
  const ratio = subtotal === 0 ? 0 : discounted / subtotal;
  const tax = roundCents(taxableSubtotal * ratio * taxRate);
  return { subtotal, discount: subtotal - discounted, tax, total: discounted + tax };
}
