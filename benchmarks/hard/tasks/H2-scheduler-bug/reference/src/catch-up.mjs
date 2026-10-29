import { nextOccurrence } from './next-run.mjs';

// Occurrences missed while the scheduler was down. The recovery window is
// (windowStartMs, windowEndMs]: an occurrence exactly at the recovery moment
// is missed too and must be replayed (README: "up to and including").
export function missedOccurrences({ hour, minute }, windowStartMs, windowEndMs, zone) {
  const out = [];
  let t = nextOccurrence({ hour, minute }, windowStartMs, zone);
  while (t <= windowEndMs) {
    out.push(t);
    t = nextOccurrence({ hour, minute }, t, zone);
  }
  return out;
}
