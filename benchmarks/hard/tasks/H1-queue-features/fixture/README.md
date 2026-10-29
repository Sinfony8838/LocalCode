# taskflow

A small in-memory job queue for Node.js with pluggable storage, an injectable
clock, priority scheduling, counters and events.

```js
import { TaskQueue, MemoryStorage, Metrics } from './src/index.mjs';

const metrics = new Metrics();
const queue = new TaskQueue({ concurrency: 2, storage: new MemoryStorage(), metrics });

await queue.add({ to: 'ada@example.com' }, {
  handler: async job => { /* deliver */ },
  priority: 5,
  maxAttempts: 1,
});
await queue.whenIdle();

console.log(queue.metrics.snapshot()); // { enqueued, started, succeeded, failed, cancelled }
console.log(await queue.counts());     // per-status job counts
```

## Module map

| File | Responsibility |
| --- | --- |
| `src/queue.mjs` | `TaskQueue`: add/run loop, concurrency, events, idle tracking |
| `src/job.mjs` | job records, `STATUSES`, legal `TRANSITIONS`, `transition()` |
| `src/storage.mjs` | `MemoryStorage` — the persistence interface TaskQueue uses |
| `src/metrics.mjs` | `Metrics` counters (`enqueued`, `started`, `succeeded`, `failed`, `cancelled`) |
| `src/backoff.mjs` | delay policies (`fixed`, `linear`) and `computeDelay` |
| `src/clock.mjs` | `createClock` — injectable time source with `now`, `delay`, timers |
| `src/priority.mjs` | `compareJobs` — priority order, FIFO tie-break |
| `src/limits.mjs` | `Semaphore` counting semaphore |
| `src/events.mjs` | `Emitter` |
| `src/validate.mjs` | input validation for `add` |
| `src/ids.mjs` | monotonic id generator |
| `src/index.mjs` | public exports |

## Conventions

- Handlers are async functions receiving the job record; throwing marks the
  attempt as failed.
- Every status change must go through `transition()` — illegal jumps throw.
- Time is always taken from the injected clock (`queue.#clock`), never from
  `Date.now()` or global timers, so tests can run without real waiting.
- Tests live in `test/` and run with `npm test` (Node's built-in test runner).

See `docs/FEATURE_REQUEST.md` for the next planned feature.
