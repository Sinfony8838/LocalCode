// Monotonic, prefix-scoped job ids.
export function createIdGenerator(prefix = 'job') {
  let counter = 0;
  return () => `${prefix}_${++counter}`;
}
