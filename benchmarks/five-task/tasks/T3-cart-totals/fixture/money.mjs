/** Amounts are integer cents everywhere. */
export function roundCents(value) {
  return Math.floor(value);
}
export function format(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
