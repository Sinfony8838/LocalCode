import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_OFFSET_MINUTES, DST_RULES, isWithinDstWindow } from '../src/timezone.mjs';

test('offset table holds the documented bases', () => {
  assert.equal(BASE_OFFSET_MINUTES.UTC, 0);
  assert.equal(BASE_OFFSET_MINUTES['Asia/Shanghai'], 480);
  assert.equal(BASE_OFFSET_MINUTES['America/New_York'], -300);
  assert.equal(BASE_OFFSET_MINUTES['Europe/Berlin'], 60);
});

test('DST windows are the documented month/day ranges', () => {
  assert.deepEqual(DST_RULES['America/New_York'], { startMonth: 3, startDay: 15, endMonth: 11, endDay: 5, offsetMinutes: 60 });
  assert.deepEqual(DST_RULES['Europe/Berlin'], { startMonth: 3, startDay: 29, endMonth: 10, endDay: 25, offsetMinutes: 60 });
});

test('window check is inclusive on both ends', () => {
  const rule = DST_RULES['America/New_York'];
  assert.equal(isWithinDstWindow(rule, new Date(Date.UTC(2026, 2, 15))), true);
  assert.equal(isWithinDstWindow(rule, new Date(Date.UTC(2026, 10, 5))), true);
  assert.equal(isWithinDstWindow(rule, new Date(Date.UTC(2026, 2, 14))), false);
  assert.equal(isWithinDstWindow(rule, new Date(Date.UTC(2026, 10, 6))), false);
});
