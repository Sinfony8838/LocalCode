import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage.mjs';
import { createJob } from '../src/job.mjs';

test('save/get/list/delete round trip', async () => {
  const storage = new MemoryStorage();
  const job = createJob({ id: 'a', payload: {} });
  await storage.save(job);
  assert.equal((await storage.get('a')).id, 'a');
  assert.equal((await storage.list()).length, 1);
  await storage.delete('a');
  assert.equal(await storage.get('a'), null);
});

test('countByStatus groups jobs', async () => {
  const storage = new MemoryStorage();
  await storage.save(createJob({ id: 'a', payload: {} }));
  const done = createJob({ id: 'b', payload: {} });
  done.status = 'succeeded';
  await storage.save(done);
  assert.deepEqual(await storage.countByStatus(), { queued: 1, succeeded: 1 });
});
