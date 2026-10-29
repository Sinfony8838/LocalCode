import test from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence } from '../src/next-run.mjs';

const JUNE_1 = Date.UTC(2026, 5, 1, 0, 0, 0);

test('UTC schedules land on the requested wall clock', () => {
  assert.equal(nextOccurrence({ hour: 9, minute: 0 }, JUNE_1, 'UTC'), JUNE_1 + 9 * 3_600_000);
  assert.equal(nextOccurrence({ hour: 9, minute: 0 }, JUNE_1 + 9 * 3_600_000, 'UTC'), JUNE_1 + 33 * 3_600_000);
});

test('occurrences are strictly after the given instant', () => {
  const at = JUNE_1 + 9 * 3_600_000 + 1;
  assert.equal(nextOccurrence({ hour: 9, minute: 0 }, at, 'UTC'), JUNE_1 + 33 * 3_600_000);
});

test('minute precision is preserved', () => {
  assert.equal(nextOccurrence({ hour: 23, minute: 59 }, JUNE_1, 'UTC'), JUNE_1 + (23 * 60 + 59) * 60_000);
});
