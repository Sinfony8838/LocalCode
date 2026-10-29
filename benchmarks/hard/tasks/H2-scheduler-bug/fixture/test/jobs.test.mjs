import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/jobs.mjs';

test('registry keeps insertion order and rejects duplicates', () => {
  const registry = createRegistry();
  registry.add({ id: 'a', hour: 1, minute: 0 });
  registry.add({ id: 'b', hour: 2, minute: 0 });
  assert.deepEqual(registry.all().map(job => job.id), ['a', 'b']);
  assert.throws(() => registry.add({ id: 'a', hour: 3, minute: 0 }), /duplicate/);
  assert.equal(registry.get('b').hour, 2);
  assert.equal(registry.get('zz'), null);
});
