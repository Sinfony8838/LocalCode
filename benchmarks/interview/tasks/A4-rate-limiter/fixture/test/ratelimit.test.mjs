import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../ratelimit.mjs';

test('consumes from a full bucket and reports remaining', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 5, refillPerSecond: 1, now: () => t });
  assert.deepEqual(rl.tryConsume('a'), { allowed: true, remaining: 4 });
  assert.deepEqual(rl.tryConsume('a'), { allowed: true, remaining: 3 });
});

test('buckets are independent per key', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => t });
  assert.equal(rl.tryConsume('a').allowed, true);
  assert.equal(rl.tryConsume('a').allowed, false);
  assert.equal(rl.tryConsume('b').allowed, true);
});

test('denied attempts report retryAfterMs', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => t });
  rl.tryConsume('a');
  rl.tryConsume('a');
  const result = rl.tryConsume('a');
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterMs, 1000);
});

test('reset restores the bucket', () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => t });
  rl.tryConsume('a');
  assert.equal(rl.tryConsume('a').allowed, false);
  rl.reset('a');
  assert.equal(rl.tryConsume('a').allowed, true);
});
