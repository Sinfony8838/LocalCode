import test from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../src/metrics.mjs';

test('snapshot lists every shipped counter with zero defaults', () => {
  const metrics = new Metrics();
  const snapshot = metrics.snapshot();
  for (const name of ['enqueued', 'started', 'succeeded', 'failed', 'cancelled']) {
    assert.equal(snapshot[name], 0, name);
  }
});

test('inc accumulates', () => {
  const metrics = new Metrics();
  metrics.inc('started');
  metrics.inc('started', 2);
  assert.equal(metrics.snapshot().started, 3);
});

test('inc rejects non-positive amounts', () => {
  const metrics = new Metrics();
  assert.throws(() => metrics.inc('started', 0), TypeError);
});
