# RateLimiter — token bucket specification

Implement the `RateLimiter` class in `ratelimit.mjs`. No third-party dependencies.

```js
import { RateLimiter } from './ratelimit.mjs';

let t = 0;                                  // fake clock in milliseconds
const rl = new RateLimiter({ capacity: 10, refillPerSecond: 2, now: () => t });
rl.tryConsume('client-1');                  // { allowed: true, remaining: 9 }
rl.tryConsume('client-1', 9);               // { allowed: true, remaining: 0 }
rl.tryConsume('client-1');                  // { allowed: false, retryAfterMs: 500 }
t += 500;
rl.tryConsume('client-1');                  // { allowed: true, remaining: 0 }
```

Constructor: `new RateLimiter({ capacity, refillPerSecond, now })`

- `capacity` — bucket size in tokens, a positive finite number. Invalid (`<= 0`, `NaN`, `Infinity`) throws `RangeError`.
- `refillPerSecond` — tokens added per second, a non-negative finite number. Negative/`NaN`/`Infinity` throws `RangeError`.
- `now` — injectable clock returning elapsed milliseconds; defaults to `() => Date.now()`. Non-function throws `TypeError`.

Semantics:

1. Every key has its own bucket, created lazily and starting **full**. Buckets are independent.
2. Refill is continuous, not tick-based. While `elapsedMs` milliseconds passed since the bucket was last touched:
   `available = min(capacity, tokens + (elapsedMs / 1000) * refillPerSecond)`.
3. `tryConsume(key, tokens = 1)`:
   - `tokens` must be a positive finite number; `0`, negatives, `NaN` and `Infinity` throw `RangeError`.
   - If `tokens > capacity`, return `{ allowed: false, retryAfterMs: null }` (impossible until the capacity changes).
   - If `available >= tokens`: consume, persist the new level and timestamp, return `{ allowed: true, remaining: available - tokens }`.
   - Otherwise: persist the accrued level and timestamp, return `{ allowed: false, retryAfterMs: Math.ceil((tokens - available) / refillPerSecond * 1000) }`.
4. `refillPerSecond === 0`: a denied `tryConsume` returns `retryAfterMs: null` (nothing will ever refill); levels stay frozen.
5. `peek(key)` — reports `{ tokens: available, capacity }` **without** creating a bucket or changing any state: peeking an unknown key reports a full bucket, and peeking never consumes or extends a timestamp.
6. `reset(key)` — the key becomes full again on its next use. Resetting an unknown key does not throw.
