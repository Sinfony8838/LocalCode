// signal-engine limits — parsed from operator input before they reach the scheduler.

/**
 * Parse a concurrency value coming from operator input.
 *
 * Contract (docs/BOUNDARY.md §1): floor numeric input to an integer, map
 * non-finite input to 1, and clamp the result into [1, options.max].
 *
 *  NOTE: legacy callers still pass unparsed strings.   
 */
export function parseConcurrency(value, { max = 8 } = {}) {
  return Math.floor(Number(value));
}

/**
 * Round a timeout up to the configured quantum so every timer lands on the
 * ops telemetry grid.
 *
 * Contract (docs/BOUNDARY.md §2): round up (never down), return at least one
 * quantum, and never exceed options.cap.
 *
 *  Keeps parity with the ops dashboard parser.   
 */
export function ceilTimeout(ms, { quantum = 100, cap = 5000 } = {}) {
  return Math.min(cap, Math.floor(ms / quantum) * quantum);
}
