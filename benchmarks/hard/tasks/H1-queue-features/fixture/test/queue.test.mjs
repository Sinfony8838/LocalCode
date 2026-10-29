import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../src/queue.mjs';
import { createClock } from '../src/clock.mjs';
import { MemoryStorage } from '../src/storage.mjs';
import { Metrics } from '../src/metrics.mjs';

// The fake-clock pattern used across queue tests: no real time ever passes.
export function makeFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = [];
  const clock = createClock({
    nowMs: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, at: now + Math.max(0, ms), fn }); return id; },
    clearTimer: id => { const index = timers.findIndex(timer => timer.id === id); if (index !== -1) timers.splice(index, 1); },
  });
  return {
    clock,
    get now() { return now; },
    set now(value) { now = value; },
    pending() { return timers.length; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        timers.splice(timers.findIndex(timer => timer.id === due.id), 1);
        due.fn();
        await new Promise(resolve => setImmediate(resolve));
      }
      now = end;
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('runs a job to success and records counters', async () => {
  const fake = makeFakeClock();
  const metrics = new Metrics();
  const queue = new TaskQueue({ clock: fake.clock, metrics, storage: new MemoryStorage() });
  const seen = [];
  await queue.add({ n: 1 }, { handler: async job => { seen.push(job.payload.n); } });
  await queue.whenIdle();
  assert.deepEqual(seen, [1]);
  assert.equal(metrics.snapshot().succeeded, 1);
  assert.equal((await queue.counts()).succeeded, 1);
});

test('respects the concurrency limit', async () => {
  const fake = makeFakeClock();
  const queue = new TaskQueue({ concurrency: 2, clock: fake.clock, storage: new MemoryStorage() });
  let running = 0;
  let peak = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = async () => {
    running++;
    peak = Math.max(peak, running);
    await gate;
    running--;
  };
  for (let i = 0; i < 5; i++) await queue.add({ i }, { handler });
  release();
  await queue.whenIdle();
  assert.equal(peak, 2);
});

test('higher priority jobs run first', async () => {
  const fake = makeFakeClock();
  const queue = new TaskQueue({ concurrency: 1, clock: fake.clock, storage: new MemoryStorage() });
  const order = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  await queue.add({}, { handler: async () => { await gate; order.push(0); }, priority: 1 });
  const second = queue.add({}, { handler: async job => { order.push(job.priority); }, priority: 9 });
  const third = queue.add({}, { handler: async job => { order.push(job.priority); }, priority: 5 });
  releaseFirst();
  await queue.whenIdle();
  await second;
  await third;
  assert.deepEqual(order, [0, 9, 5]);
});

test('a failing job is marked failed and emits job:failed', async () => {
  const fake = makeFakeClock();
  const queue = new TaskQueue({ clock: fake.clock, storage: new MemoryStorage() });
  const failures = [];
  queue.on('job:failed', job => failures.push(job.id));
  await queue.add({}, { handler: async () => { throw new Error('boom'); } });
  await queue.whenIdle();
  const [job] = await queue.jobs();
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'boom');
  assert.equal(failures.length, 1);
  assert.equal(queue.metrics.snapshot().failed, 1);
});

test('whenIdle resolves when there is no work', async () => {
  const fake = makeFakeClock();
  const queue = new TaskQueue({ clock: fake.clock, storage: new MemoryStorage() });
  await queue.whenIdle();
  await queue.add({}, { handler: async () => {} });
  await queue.whenIdle();
  assert.equal(fake.pending(), 0);
});
