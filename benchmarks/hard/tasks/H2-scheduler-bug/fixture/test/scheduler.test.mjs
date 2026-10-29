import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, createTestClock } from '../src/index.mjs';

const JUNE_1 = Date.UTC(2026, 5, 1, 0, 0, 0);

test('nextRun honors the scheduler zone (UTC smoke)', () => {
  const clock = createTestClock(JUNE_1);
  const scheduler = createScheduler({ zone: 'UTC', now: clock.now });
  scheduler.add({ id: 'a', hour: 9, minute: 0 });
  const [job] = scheduler.jobs();
  assert.equal(scheduler.nextRun(job), JUNE_1 + 9 * 3_600_000);
});

test('fires are recorded in the log with wall-clock times', async () => {
  const clock = createTestClock(JUNE_1 + 12 * 3_600_000);
  const fired = [];
  const scheduler = createScheduler({ zone: 'UTC', now: clock.now, onFire: async job => fired.push(job.id) });
  scheduler.add({ id: 'a', hour: 11, minute: 0 });
  await scheduler.resume(JUNE_1, JUNE_1 + 12 * 3_600_000);
  assert.deepEqual(fired, ['a']);
  assert.deepEqual(scheduler.fireLog().map(entry => entry.scheduledAt), [JUNE_1 + 11 * 3_600_000]);
});

test('resume is a no-op when nothing was missed', async () => {
  const clock = createTestClock(JUNE_1);
  const scheduler = createScheduler({ zone: 'UTC', now: clock.now });
  scheduler.add({ id: 'a', hour: 11, minute: 0 });
  await scheduler.resume(JUNE_1 + 11 * 3_600_000, JUNE_1 + 11 * 3_600_000);
  assert.equal(scheduler.fireLog().length, 0);
});
