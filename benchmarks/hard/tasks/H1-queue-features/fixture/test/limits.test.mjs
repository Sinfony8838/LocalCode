import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/limits.mjs';

test('permits cap concurrent holders', async () => {
  const semaphore = new Semaphore(2);
  const first = await semaphore.acquire();
  const second = await semaphore.acquire();
  assert.equal(semaphore.available, 0);
  let thirdAcquired = false;
  const third = semaphore.acquire().then(release => { thirdAcquired = true; return release; });
  await Promise.resolve();
  assert.equal(thirdAcquired, false);
  second();
  const releaseThird = await third;
  assert.equal(thirdAcquired, true);
  first();
  releaseThird();
  assert.equal(semaphore.available, 2);
});
