// Token-bucket rate limiter. See README.md for the exact specification.
export class RateLimiter {
  #capacity;
  #refillPerSecond;
  #now;
  #buckets = new Map();

  constructor({ capacity, refillPerSecond, now = () => Date.now() }) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new RangeError('capacity must be a positive finite number');
    if (!Number.isFinite(refillPerSecond) || refillPerSecond < 0) throw new RangeError('refillPerSecond must be a non-negative finite number');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#capacity = capacity;
    this.#refillPerSecond = refillPerSecond;
    this.#now = now;
  }

  #touch(key) {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.#capacity, updatedAt: this.#now() };
      this.#buckets.set(key, bucket);
    }
    return bucket;
  }

  #accrued(bucket) {
    const t = this.#now();
    const elapsedMs = Math.max(0, t - bucket.updatedAt);
    const available = this.#refillPerSecond === 0
      ? bucket.tokens
      : Math.min(this.#capacity, bucket.tokens + (elapsedMs / 1000) * this.#refillPerSecond);
    return { t, available };
  }

  tryConsume(key, tokens = 1) {
    if (!Number.isFinite(tokens) || tokens <= 0) throw new RangeError('tokens must be a positive finite number');
    if (tokens > this.#capacity) return { allowed: false, retryAfterMs: null };
    const bucket = this.#touch(key);
    const { t, available } = this.#accrued(bucket);
    if (available >= tokens) {
      bucket.tokens = available - tokens;
      bucket.updatedAt = t;
      return { allowed: true, remaining: bucket.tokens };
    }
    bucket.tokens = available;
    bucket.updatedAt = t;
    const retryAfterMs = this.#refillPerSecond === 0
      ? null
      : Math.ceil((tokens - available) / this.#refillPerSecond * 1000);
    return { allowed: false, retryAfterMs };
  }

  peek(key) {
    const bucket = this.#buckets.get(key);
    if (!bucket) return { tokens: this.#capacity, capacity: this.#capacity };
    const { available } = this.#accrued(bucket);
    return { tokens: available, capacity: this.#capacity };
  }

  reset(key) {
    this.#buckets.delete(key);
  }
}
