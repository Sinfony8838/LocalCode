// Timezone support: a fixed offset table plus DST windows for two zones.
// Offsets are in minutes east of UTC. DST windows are inclusive month/day
// ranges evaluated on the UTC calendar date of the candidate day (documented
// simplification — all shipped zones agree between the two).
export const BASE_OFFSET_MINUTES = {
  UTC: 0,
  'Asia/Shanghai': 8 * 60,
  'America/New_York': -5 * 60,
  'Europe/Berlin': 60,
};

export const DST_RULES = {
  'America/New_York': { startMonth: 3, startDay: 15, endMonth: 11, endDay: 5, offsetMinutes: 60 },
  'Europe/Berlin': { startMonth: 3, startDay: 29, endMonth: 10, endDay: 25, offsetMinutes: 60 },
};

export function baseOffsetMinutes(zone) {
  return BASE_OFFSET_MINUTES[zone] ?? 0;
}

export function dstRule(zone) {
  return DST_RULES[zone] ?? null;
}

export function isWithinDstWindow(rule, utcDate) {
  if (!rule) return false;
  const month = utcDate.getUTCMonth() + 1;
  const day = utcDate.getUTCDate();
  const afterStart = month > rule.startMonth || (month === rule.startMonth && day >= rule.startDay);
  const beforeEnd = month < rule.endMonth || (month === rule.endMonth && day <= rule.endDay);
  return afterStart && beforeEnd;
}

export function offsetMinutes(zone, utcMs) {
  const base = baseOffsetMinutes(zone);
  const rule = dstRule(zone);
  const dstShift = isWithinDstWindow(rule, new Date(utcMs)) ? rule.offsetMinutes : 0;
  return base - dstShift;
}

export const MS_PER_DAY = 86_400_000;

export function utcDayStart(utcMs) {
  return Math.floor(utcMs / MS_PER_DAY) * MS_PER_DAY;
}
