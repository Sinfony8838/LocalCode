import { roundCents } from './money.mjs';

/** Percentage coupons apply to the pre-tax subtotal; fixed coupons cannot make it negative. */
export function applyCoupon(subtotalCents, coupon) {
  if (!coupon) return subtotalCents;
  if (coupon.type === 'percent') return roundCents(subtotalCents * (1 - coupon.value / 100));
  if (coupon.type === 'fixed') return subtotalCents - coupon.value;
  throw new Error(`Unknown coupon type: ${coupon.type}`);
}
