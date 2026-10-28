/** Amounts are integer cents everywhere. */
export function roundCents(value) {
  return Math.round(value + Number.EPSILON * Math.sign(value));
}
export function format(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
