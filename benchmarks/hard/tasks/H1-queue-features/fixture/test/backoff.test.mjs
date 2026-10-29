import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDelay, POLICIES } from '../src/backoff.mjs';

test('fixed policy returns the base delay', () => {
  assert.equal(computeDelay('fixed', 100, 1), 100);
  assert.equal(computeDelay('fixed', 100, 3), 100);
});

test('linear policy scales with the retry number', () => {
  assert.equal(computeDelay('linear', 100, 1), 100);
  assert.equal(computeDelay('linear', 100, 3), 300);
});

test('unknown policies and bad arguments throw RangeError', () => {
  assert.throws(() => computeDelay('fibonacci', 100, 1), RangeError);
  assert.throws(() => computeDelay('fixed', -1, 1), RangeError);
  assert.throws(() => computeDelay('fixed', 100, 0), RangeError);
});

test('fixed and linear are shipped policies', () => {
  for (const policy of ['fixed', 'linear']) assert.ok(POLICIES.includes(policy), policy);
});
