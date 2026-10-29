import test from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from '../src/clock.mjs';

test('clock exposes an injectable time source', () => {
  let now = 42;
  const clock = createClock({ nowMs: () => now });
  assert.equal(clock.now(), 42);
  now = 50;
  assert.equal(clock.now(), 50);
});

test('clock.delay resolves through the injected timer', async () => {
  const clock = createClock({ nowMs: () => 0, setTimer: (fn, ms) => { if (ms === 5) fn(); } });
  await clock.delay(5);
});

test('rejects a non-function nowMs', () => {
  assert.throws(() => createClock({ nowMs: 'x' }), TypeError);
});
