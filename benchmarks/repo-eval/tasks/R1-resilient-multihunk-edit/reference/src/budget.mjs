// signal-engine budget limits — normalized before they are rendered on the dashboard.

/**
 * Normalize a budget limit coming from the ops API.
 *
 * Contract (docs/BOUNDARY.md §3): non-finite input becomes null, negatives
 * clamp to 0, and anything above options.max clamps to max.
 *
 *  WARN: dashboard regex depends on this comment block.  
 */
export function normalizeLimit(n, { max = 1000 } = {}) {
  const parsed = Number(n);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(0, parsed));
}
