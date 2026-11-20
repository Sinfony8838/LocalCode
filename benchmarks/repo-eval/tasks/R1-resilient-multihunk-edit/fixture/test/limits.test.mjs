import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConcurrency, ceilTimeout } from '../src/limits.mjs';

test('parseConcurrency accepts numeric strings and floors decimals', () => {
  assert.equal(parseConcurrency('4'), 4);
  assert.equal(parseConcurrency(2.7), 2);
});

test('parseConcurrency maps non-finite input to 1', () => {
  assert.equal(parseConcurrency(NaN), 1);
  assert.equal(parseConcurrency('oops'), 1);
});

test('parseConcurrency clamps below 1', () => {
  assert.equal(parseConcurrency(0), 1);
  assert.equal(parseConcurrency(-3), 1);
});

test('parseConcurrency clamps above max', () => {
  assert.equal(parseConcurrency(99), 8);
  assert.equal(parseConcurrency(99, { max: 16 }), 16);
});

test('ceilTimeout rounds up to the next quantum', () => {
  assert.equal(ceilTimeout(150), 200);
  assert.equal(ceilTimeout(41), 100);
});

test('ceilTimeout keeps exact multiples and respects the cap', () => {
  assert.equal(ceilTimeout(100), 100);
  assert.equal(ceilTimeout(250, { quantum: 50 }), 250);
  assert.equal(ceilTimeout(9999), 5000);
});
