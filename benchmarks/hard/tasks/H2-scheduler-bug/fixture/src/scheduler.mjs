import { parseSchedule } from './schedule.mjs';
import { createRegistry } from './jobs.mjs';
import { createFireLog } from './fire-log.mjs';
import { nextOccurrence } from './next-run.mjs';
import { missedOccurrences } from './catch-up.mjs';

// Orchestrates job firing. onFire(job, scheduledAtUtcMs) is awaited per firing.
export function createScheduler({ zone = 'UTC', onFire = async () => {}, now = () => Date.now() } = {}) {
  if (typeof onFire !== 'function') throw new TypeError('onFire must be a function');
  const registry = createRegistry();
  const fireLog = createFireLog();

  async function fire(job, scheduledAtUtcMs) {
    fireLog.record(job, scheduledAtUtcMs, now());
    await onFire(job, scheduledAtUtcMs);
  }

  return {
    zone,
    add({ id, hour, minute }) {
      const schedule = parseSchedule({ hour, minute });
      return registry.add({ id, ...schedule });
    },
    jobs: () => registry.all(),
    nextRun(job, fromUtcMs = now()) {
      return nextOccurrence(job, fromUtcMs, zone);
    },
    async resume(lastFiredAtMs, recoveredAtMs) {
      for (const job of registry.all()) {
        for (const scheduledAt of missedOccurrences(job, lastFiredAtMs, recoveredAtMs, zone)) {
          await fire(job, scheduledAt);
        }
      }
      return fireLog.all();
    },
    fireLog: () => fireLog.all(),
  };
}
