// Input validation for queue.add — throws TypeError with a clear message.
export function assertValidJobInput({ payload, handler, priority }) {
  if (payload === undefined) throw new TypeError('payload is required');
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  if (!Number.isInteger(priority)) throw new TypeError('priority must be an integer');
}
