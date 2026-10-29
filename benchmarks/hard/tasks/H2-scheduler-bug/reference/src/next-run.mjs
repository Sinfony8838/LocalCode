import { offsetMinutes, utcDayStart, MS_PER_DAY } from './timezone.mjs';

// Next occurrence of a daily HH:MM schedule in `zone`, strictly after fromUtcMs.
// See README "How occurrences are computed" for the exact algorithm.
export function nextOccurrence({ hour, minute }, fromUtcMs, zone) {
  let dayStartUtc = utcDayStart(fromUtcMs);
  for (;;) {
    const offset = offsetMinutes(zone, dayStartUtc);
    const candidate = dayStartUtc - offset * 60_000 + (hour * 60 + minute) * 60_000;
    if (candidate > fromUtcMs) return candidate;
    dayStartUtc += MS_PER_DAY;
  }
}
