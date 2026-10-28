import { roundCents } from './money.mjs';

/** Percentage coupons apply to the pre-tax subtotal; fixed coupons cannot make it negative. */
export function applyCoupon(subtotalCents, coupon) {
  if (!coupon) return subtotalCents;
  if (coupon.type === 'percent') return subtotalCents - roundCents(subtotalCents * coupon.value / 100);
  if (coupon.type === 'fixed') return Math.max(0, subtotalCents - coupon.value);
  throw new Error(`Unknown coupon type: ${coupon.type}`);
}
