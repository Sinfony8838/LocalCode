import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdGenerator } from '../src/ids.mjs';

test('ids are monotonic and prefixed', () => {
  const nextId = createIdGenerator('task');
  assert.equal(nextId(), 'task_1');
  assert.equal(nextId(), 'task_2');
  assert.equal(createIdGenerator('other')(), 'other_1');
});
