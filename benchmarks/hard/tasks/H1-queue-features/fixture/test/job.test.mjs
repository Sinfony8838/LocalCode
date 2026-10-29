import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, transition, TRANSITIONS } from '../src/job.mjs';

test('new jobs start queued with attempt zero', () => {
  const job = createJob({ id: 'a', payload: { x: 1 }, maxAttempts: 2, createdAt: 7 });
  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, 0);
  assert.equal(job.updatedAt, 7);
  assert.equal(job.error, null);
});

test('legal transitions stamp updatedAt', () => {
  const job = createJob({ id: 'a', payload: {} });
  transition(job, 'running', 10);
  assert.equal(job.status, 'running');
  assert.equal(job.updatedAt, 10);
  transition(job, 'succeeded', 20);
  assert.equal(job.status, 'succeeded');
});

test('illegal transitions throw', () => {
  const job = createJob({ id: 'a', payload: {} });
  assert.throws(() => transition(job, 'failed'));
  transition(job, 'running');
  assert.throws(() => transition(job, 'queued'));
});

test('succeeded and cancelled are terminal statuses', () => {
  assert.deepEqual(TRANSITIONS.succeeded, []);
  assert.deepEqual(TRANSITIONS.cancelled, []);
});
