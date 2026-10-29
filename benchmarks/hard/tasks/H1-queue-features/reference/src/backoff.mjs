// Delay policies for re-running failed work. `attempt` is the retry number:
// 1 = delay before the first retry, 2 = before the second, and so on.
export const POLICIES = ['fixed', 'linear', 'exponential'];

export function computeDelay(policy, baseDelayMs, attempt) {
  if (!POLICIES.includes(policy)) throw new RangeError(`unknown backoff policy: ${policy}`);
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) throw new RangeError('baseDelayMs must be a non-negative finite number');
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError('attempt must be an integer >= 1');
  if (policy === 'fixed') return baseDelayMs;
  if (policy === 'linear') return baseDelayMs * attempt;
  return baseDelayMs * 2 ** (attempt - 1);
}
