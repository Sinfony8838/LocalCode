# cronlite

A tiny timezone-aware scheduler for daily jobs, with recovery replay after
downtime. Zero dependencies.

```js
import { createScheduler, createTestClock } from './src/index.mjs';

const clock = createTestClock(Date.UTC(2026, 5, 1, 0, 0, 0));
const scheduler = createScheduler({
  zone: 'Asia/Shanghai',
  now: clock.now,
  onFire: async (job, scheduledAtUtcMs) => { /* deliver */ },
});
scheduler.add({ id: 'morning-report', hour: 9, minute: 0 });
const at = scheduler.nextRun(scheduler.jobs()[0]); // UTC ms of the next 09:00 in Shanghai
await scheduler.resume(lastFiredAtMs, recoveredAtMs); // replay missed occurrences after downtime
```

## How occurrences are computed

For a job scheduled at local `HH:MM` in `zone`, the UTC time of an occurrence
is computed from a candidate UTC day `D` (starting with the UTC day containing
`fromUtcMs`):

1. `offset = base(zone) + (zone has a DST rule and D is inside the inclusive
   month/day window ? rule.offsetMinutes : 0)`
2. `candidate = utcMidnight(D) − offset·60000 + (hour·60 + minute)·60000`
3. If `candidate ≤ fromUtcMs`, repeat with the next UTC day; otherwise the
   candidate is the occurrence.

`base(zone)` comes from the offset table; **zones without an entry fall back to
UTC** (documented behaviour). DST windows: America/New_York from March 15 to
November 5, Europe/Berlin from March 29 to October 25 (both inclusive).

## Recovery replay

After downtime, `resume(lastFiredAtMs, recoveredAtMs)` replays every occurrence
whose scheduled time is **after** `lastFiredAtMs` and **at or before**
`recoveredAtMs` — an occurrence scheduled exactly at the recovery moment is
missed and must be replayed. Firings are recorded in the fire log in replay
order (jobs in registry order, occurrences oldest-first within a job).
