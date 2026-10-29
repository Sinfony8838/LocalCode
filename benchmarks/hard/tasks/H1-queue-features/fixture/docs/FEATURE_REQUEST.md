# Feature request: automatic retries with exponential backoff and a dead-letter queue

Support asks: "jobs fail because of transient errors and we lose them."
Product wants failed jobs retried automatically with growing delays, and jobs
that keep failing collected in a dead-letter list instead of being lost.

## Requirements

R1. Per-queue retry defaults on the constructor: `retry: { maxAttempts, policy, baseDelayMs }`
    (default `maxAttempts: 1`, `policy: 'fixed'`, `baseDelayMs: 0`). `add()` may
    override per job with the same shape. `maxAttempts` counts TOTAL attempts,
    so `maxAttempts: 3` means at most one initial run plus two retries.

R2. Delay before retry number `k` (1st retry → `k = 1`) comes from
    `computeDelay(policy, baseDelayMs, k)`:
    - `fixed`: `baseDelayMs`
    - `linear`: `baseDelayMs * k`
    - `exponential`: `baseDelayMs * 2^(k - 1)` — NEW policy, add it to `backoff.mjs`
      and `POLICIES`.

R3. Retries must go through the **injected clock** (`clock.delay`), exactly like
    everything else that waits. Waiting for a retry counts as work in progress:
    `whenIdle()` must not resolve while any job is waiting for its retry.

R4. A retrying job: `attempts` counts every started attempt; after a failed
    attempt with retries left, the job goes back to `queued` (extend
    `TRANSITIONS` in `job.mjs` accordingly), then runs again when the delay
    elapses. Its `error` field keeps the most recent error message.

R5. When the final attempt fails, the job becomes **dead**: add a `dead` status
    (legal from `failed`), stamp `deadAt` with the current clock time, increment
    a new `dead` counter, and emit a new `job:dead` event with the job record.
    The existing `failed` counter still increments once per failed ATTEMPT.

R6. `queue.deadLetters()` returns dead jobs oldest-first (by `deadAt`).

R7. Backwards compatibility: with `maxAttempts: 1` (the default) behaviour is
    exactly as today — a failed job keeps status `failed`, no dead-letter, no
    `job:dead` event, no retry delays, `whenIdle()` unchanged. All existing
    tests must keep passing unmodified.

## Acceptance checks

The acceptance suite drives a fake clock (see `test/queue.test.mjs` for the
existing fake-clock pattern) and verifies:

- exponential delays of exactly 100 ms then 200 ms before retries 1 and 2
  (`maxAttempts: 3`, `baseDelayMs: 100`);
- `attempts === 3`, status `dead`, `deadAt` set, `deadLetters()` order,
  snapshot `{ failed: 3, retries: 2, dead: 1 }`;
- `fixed` and `linear` policies compute the documented delays;
- a job that succeeds on attempt 2 is not a dead letter and reports
  `{ failed: 1, retries: 1, dead: 0 }`;
- `maxAttempts: 1` behaves exactly like the current code.
