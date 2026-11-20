import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMs, truncateLabel } from '../src/format.mjs';

test('formatMs renders whole milliseconds', () => {
  assert.equal(formatMs(149.4), '149ms');
  assert.equal(formatMs(0), '0ms');
});

test('truncateLabel keeps short labels and ellipsates long ones', () => {
  assert.equal(truncateLabel('queue-a'), 'queue-a');
  assert.equal(truncateLabel('x'.repeat(30)), `${'x'.repeat(23)}…`);
});
