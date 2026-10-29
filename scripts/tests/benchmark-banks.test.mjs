import test from 'node:test';
import assert from 'node:assert/strict';
import { selfTest, selectTasks } from '../../benchmarks/run.mjs';

test('benchmark banks: unsolved fixtures score low and reference solutions score 100', async () => {
  const tasks = await selectTasks();
  assert.ok(tasks.length >= 14, `expected the full tiered bank, found ${tasks.length} tasks`);
  assert.ok(tasks.some(task => task.tier === 'L1'), 'L1 bank missing');
  assert.ok(tasks.some(task => task.tier === 'L2'), 'L2 bank missing');
  assert.ok(tasks.some(task => task.tier === 'L3'), 'L3 bank missing');

  const { agents, problems, skipped } = await selfTest();
  assert.deepEqual(problems, []);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].results.length, tasks.length);
  assert.equal(agents[1].results.length, tasks.length);
  if (skipped.length) console.log(`skipped: ${skipped.join('; ')}`);
});
