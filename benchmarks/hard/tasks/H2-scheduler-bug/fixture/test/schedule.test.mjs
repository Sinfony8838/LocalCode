import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule } from '../src/schedule.mjs';

test('valid schedules pass through', () => {
  assert.deepEqual(parseSchedule({ hour: 9, minute: 0 }), { hour: 9, minute: 0 });
  assert.deepEqual(parseSchedule({ hour: 0, minute: 59 }), { hour: 0, minute: 59 });
});

test('out-of-range or non-integer fields throw RangeError', () => {
  assert.throws(() => parseSchedule({ hour: 24, minute: 0 }), RangeError);
  assert.throws(() => parseSchedule({ hour: 9, minute: 60 }), RangeError);
  assert.throws(() => parseSchedule({ hour: 1.5, minute: 0 }), RangeError);
});
