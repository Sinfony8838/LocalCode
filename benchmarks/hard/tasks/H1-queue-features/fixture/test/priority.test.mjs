import test from 'node:test';
import assert from 'node:assert/strict';
import { compareJobs } from '../src/priority.mjs';
import { createJob } from '../src/job.mjs';

test('higher priority first, then FIFO, then id', () => {
  const high = createJob({ id: 'b', payload: {}, priority: 5, createdAt: 2 });
  const low = createJob({ id: 'a', payload: {}, priority: 1, createdAt: 1 });
  assert.ok(compareJobs(high, low) < 0);
  const early = createJob({ id: 'z', payload: {}, createdAt: 1 });
  const late = createJob({ id: 'a', payload: {}, createdAt: 2 });
  assert.ok(compareJobs(early, late) < 0);
  const first = createJob({ id: 'a', payload: {}, createdAt: 1 });
  const second = createJob({ id: 'b', payload: {}, createdAt: 1 });
  assert.ok(compareJobs(first, second) < 0);
});
