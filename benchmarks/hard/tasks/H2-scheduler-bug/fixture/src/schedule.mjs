// Validates and normalizes daily schedules.
export function parseSchedule({ hour, minute }) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError('hour must be an integer 0-23');
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError('minute must be an integer 0-59');
  return { hour, minute };
}
