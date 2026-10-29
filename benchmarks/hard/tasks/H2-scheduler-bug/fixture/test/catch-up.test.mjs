import test from 'node:test';
import assert from 'node:assert/strict';
import { missedOccurrences } from '../src/catch-up.mjs';

const JUNE_1 = Date.UTC(2026, 5, 1, 0, 0, 0);

test('interior missed occurrences are replayed in order', () => {
  const windowStart = JUNE_1 + 10 * 3_600_000;
  const windowEnd = JUNE_1 + 12 * 3_600_000 + 1_800_000;
  assert.deepEqual(
    missedOccurrences({ hour: 11, minute: 0 }, windowStart, windowEnd, 'UTC'),
    [JUNE_1 + 11 * 3_600_000],
  );
});

test('an empty window replays nothing', () => {
  assert.deepEqual(
    missedOccurrences({ hour: 11, minute: 0 }, JUNE_1, JUNE_1 + 3_600_000, 'UTC'),
    [],
  );
});

test('occurrences before the window are ignored', () => {
  const windowStart = JUNE_1 + 13 * 3_600_000;
  const windowEnd = JUNE_1 + 14 * 3_600_000;
  assert.deepEqual(missedOccurrences({ hour: 11, minute: 0 }, windowStart, windowEnd, 'UTC'), []);
});
