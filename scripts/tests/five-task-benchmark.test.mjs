import test from 'node:test';
import assert from 'node:assert/strict';
import { selfTest } from '../../benchmarks/five-task/run.mjs';

test('five-task benchmark: unsolved fixtures score low and reference solutions score 100', async () => {
  const { agents, problems, skipped } = await selfTest();
  assert.deepEqual(problems, []);
  assert.equal(agents.length, 2);
  for (const { results } of agents) assert.equal(results.length, 5);
  if (skipped.length) console.log(`skipped: ${skipped.join('; ')}`);
});
