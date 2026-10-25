import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Saved synthetic sessions only: no model requests or production profile access.
const root = path.resolve(`../evidence/typography-${Date.now()}`);
const executable = process.argv[2];
await fs.mkdir(path.join(root, 'data'), { recursive: true });
const project = { id: randomUUID(), name: '排版预览', path: path.join(root, 'project'), createdAt: new Date().toISOString() };
await fs.mkdir(project.path);
const provider = { id: 'local', name: 'Qwen 3.5 · 9B 本地', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3.5:9b-agent', contextWindow: 8192, maxTokens: 1024, hasKey: false };
const coverageNote = '统计本轮可读取的项目文本及文件工具修改；不含依赖和构建产物，同时发生的外部编辑可能计入。';
const changes = ['scripts/acceptance-home.mjs', 'D:/LocalAI/LocalCode/README.md', 'package-lock.json', 'src/renderer/styles.css', 'src/renderer/RunSummary.tsx', 'src/renderer/App.tsx', '很长的目录/'.repeat(12) + '排版预览.tsx'].map((file, i) => ({ path: file, kind: 'modified', additions: i ? 7 : 159, deletions: i ? 2 : 0, source: 'file_tool' }));
const sessions = ['完成排版预览', '停止排版预览', '异常统计预览', '无文件修改预览'].map((title, i) => {
  const runId = randomUUID(), finalMessageId = randomUUID();
  const createdAt = `2026-10-25T10:0${i}:00.000Z`, endedAt = `2026-10-25T10:0${i}:30.000Z`;
  const status = i === 1 ? 'interrupted' : i === 2 ? 'failed' : 'completed';
  return { id: randomUUID(), projectId: project.id, title, createdAt, updatedAt: endedAt, providerId: 'local', status,
    messages: [{ id: randomUUID(), role: 'user', text: '检查正文、文件卡片和停止状态的排版。', createdAt, runId },
      { id: finalMessageId, role: 'assistant', text: i === 1 ? '已停止当前任务。' : '这是一段中文排版预览，用来核对正文的字号、行距和段间距。\n\n文件链接与普通正文保持同一基线，**重点内容使用半粗体**。\n\n修改卡片默认显示三个文件，展开后可以查看其余文件。\n\n关闭 LocalCode，再运行 `Start.cmd` 即可生效。', createdAt: endedAt, runId }], tools: [],
    runs: [{ runId, status, startedAt: createdAt, endedAt, durationMs: 524000, ...(status === 'completed' ? { finalMessageId } : {}), changes: i === 0 ? changes : [], changeScope: 'workspace_snapshot', coverageNote, ...(i === 2 ? { changesError: '部分文件读取失败，统计不完整。' } : {}) }] };
});
await fs.writeFile(path.join(root, 'data/index.json'), JSON.stringify({ version: 1, projects: [project], sessions, settings: { theme: 'light', fontSize: 14, defaultProviderId: 'local', providers: [provider] }, keys: {} }));
await fs.writeFile(path.join(root, 'data/pets.json'), JSON.stringify({ version: 1, enabled: false }));
const env = { ...process.env, LOCALCODE_HOME: root, LOCALCODE_SKIP_OLLAMA_START: '1' }; delete env.ELECTRON_RUN_AS_NODE;
let app;
const checks = [], errors = [], metrics = [];
try {
  app = await electron.launch({ executablePath: executable ? path.resolve(executable) : path.resolve('node_modules/electron/dist/electron.exe'), args: executable ? [] : [process.cwd()], env });
  let page;
  for (let n = 0; n < 200 && !page; n++) { page = app.windows().find(p => /\/index\.html$/.test(p.url())); if (!page) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(page, 'main window');
  page.on('pageerror', error => errors.push(error.stack));
  await page.getByLabel('任务输入').waitFor();
  await page.bringToFront();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && /\/index\.html$/.test(w.webContents.getURL()))?.setContentSize(1280, 900));
  const select = async title => { await page.locator('.session-button').filter({ hasText: title }).click(); await page.waitForFunction(title => document.querySelector('.workspace-heading h1')?.textContent === title, title); };
  await select('完成排版预览');
  assert.equal(await page.locator('.run-file-row').count(), 3);
  assert.equal(await page.getByText(coverageNote, { exact: true }).count(), 0);
  assert.equal(await page.locator('.run-timing').count(), 1);
  assert(await page.evaluate(() => Boolean(document.querySelector('.run-timing').compareDocumentPosition(document.querySelector('.assistant-message')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  metrics.push(await page.locator('.markdown-body').first().evaluate(el => ({ font: getComputedStyle(el).fontFamily, size: getComputedStyle(el).fontSize, lineHeight: getComputedStyle(el).lineHeight, paragraphMargin: getComputedStyle(el.querySelector('p')).marginBottom })));
  assert.equal(metrics[0].size, '14px'); assert.equal(metrics[0].lineHeight, '24px');
  assert.equal(await page.locator('.assistant-message .message-copy').count(), 0);
  assert.equal(await page.getByRole('button', { name: '复制回答', exact: true }).count(), 1);
  assert(await page.evaluate(() => Boolean(document.querySelector('.run-changes-card').compareDocumentPosition(document.querySelector('.message-copy')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  checks.push('final answer copy button follows the file card without adding a row between prose and card');
  await page.screenshot({ path: path.join(root, '01-completed.png') });
  await page.getByRole('button', { name: '再显示 4 个文件', exact: true }).click();
  assert.equal(await page.locator('.run-file-row').count(), 7);
  await page.locator('.run-summary-heading').click(); assert.equal(await page.locator('.run-file-row').count(), 0);
  await page.locator('.run-summary-heading').click(); assert.equal(await page.locator('.run-file-row').count(), 7);
  checks.push('completed: elapsed time before final reply; no repeated timing; three-file preview, expand and collapse');
  await select('停止排版预览');
  const stopped = page.locator('.run-summary');
  assert.match(await stopped.innerText(), /本轮已停止.*用时 8分钟44秒/s);
  assert.equal(await stopped.locator('button').count(), 0);
  const stoppedHeight = await stopped.evaluate(el => el.getBoundingClientRect().height);
  assert(stoppedHeight <= 30, `stopped row too tall: ${stoppedHeight}`);
  assert(!(await stopped.innerText()).includes('未记录到文件修改'));
  await page.screenshot({ path: path.join(root, '02-stopped.png') });
  checks.push(`stopped: single ${stoppedHeight}px row; no empty details or boilerplate`);
  await select('异常统计预览');
  assert.match(await page.locator('.run-summary').innerText(), /本轮运行失败/);
  assert.match(await page.locator('.run-summary-note').innerText(), /统计不完整/);
  checks.push('actual failures remain visible');
  await select('无文件修改预览');
  assert.equal(await page.locator('.run-summary').count(), 0); assert.equal(await page.locator('.run-timing').count(), 1);
  checks.push('completed without changes: only one timing line, no empty card');
  await select('完成排版预览');
  await page.evaluate(async () => { await window.localcode.setFontSize(20); await window.localcode.setTheme('dark'); });
  await page.reload(); await page.getByLabel('任务输入').waitFor(); await select('完成排版预览');
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => /\/index\.html$/.test(w.webContents.getURL()))?.setContentSize(960, 760));
  await page.getByRole('button', { name: '再显示 4 个文件', exact: true }).click();
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.message-list, .run-changes-card, .run-file-row, .composer')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.className));
  assert.deepEqual(overflow, []);
  await page.locator('.run-file-row').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, '03-dark-large-long-path.png') });
  checks.push('20px + dark theme + narrow window + long paths: no horizontal overflow');
  assert.deepEqual(errors, []);
  const report = { passed: true, executable: executable || 'source electron', root, productionDataUsedForTests: false, modelRequests: 0, checks, metrics, errors };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await app?.close(); }
