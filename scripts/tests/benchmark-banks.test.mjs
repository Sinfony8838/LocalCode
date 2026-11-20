import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepare, scoreAgent, selfTest, selectTasks } from '../../benchmarks/run.mjs';
import { copyTree, hashTree } from '../../benchmarks/lib/common.mjs';
import { runProbe } from '../../benchmarks/lib/dom-probe.mjs';

test('benchmark banks: unsolved fixtures score low and reference solutions score 100', async () => {
  const tasks = await selectTasks();
  assert.ok(tasks.length >= 17, `expected the full tiered bank (L1-L4), found ${tasks.length} tasks`);
  assert.ok(tasks.some(task => task.tier === 'L1'), 'L1 bank missing');
  assert.ok(tasks.some(task => task.tier === 'L2'), 'L2 bank missing');
  assert.ok(tasks.some(task => task.tier === 'L3'), 'L3 bank missing');
  assert.ok(tasks.some(task => task.tier === 'L4'), 'L4 bank missing');

  const { agents, problems, skipped } = await selfTest();
  assert.deepEqual(problems, []);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].results.length, tasks.length);
  assert.equal(agents[1].results.length, tasks.length);
  if (skipped.length) console.log(`skipped: ${skipped.join('; ')}`);
});

test('dom-probe: supports dataset writes/deletes, global Element, and setSelectionRange', async () => {
  const html = `<!doctype html><html><body><div id="row"></div><input id="inp" value="hello"><script>
    const row = document.getElementById('row');
    row.dataset.itemId = '42';
    row.dataset.tempFlag = 'yes';
    delete row.dataset.tempFlag;
    const inp = document.getElementById('inp');
    inp.setSelectionRange(0, 5);
    window.__probeCheck = {
      isElement: row instanceof window.Element,
      attrId: row.getAttribute('data-item-id'),
      datasetId: row.dataset.itemId,
      tempRemoved: !row.hasAttribute('data-temp-flag'),
    };
  </script></body></html>`;
  const res = await runProbe('const p = loadPage(); return p.window.__probeCheck;', html);
  assert.deepEqual(res, {
    isElement: true,
    attrId: '42',
    datasetId: '42',
    tempRemoved: true,
  });
});

test('scoreAgent: runs verify in an isolated sandbox without mutating the workspace', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-bench-readonly-'));
  try {
    const tasks = await selectTasks({ tasks: 'H4' });
    const root = await prepare(out, 'test-agent', { lang: 'en', tasks: 'H4' });
    const h4Dir = path.join(root, 'H4-large-report');
    await copyTree(path.join(tasks[0].dir, 'reference'), h4Dir);
    // Ensure report.json is NOT in the workspace before scoring
    await fs.rm(path.join(h4Dir, 'report.json'), { force: true });
    const beforeHash = await hashTree(h4Dir);
    const results = await scoreAgent(root);
    const afterHash = await hashTree(h4Dir);
    assert.equal(results[0].score, 100);
    assert.deepEqual(afterHash, beforeHash, 'scoreAgent must not leave report.json or other artifacts in the evaluated workspace');
  } finally {
    await fs.rm(out, { recursive: true, force: true }).catch(() => {});
  }
});
