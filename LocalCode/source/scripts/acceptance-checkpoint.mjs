// Actual Windows Electron UI/IPC/filesystem fixture. No model or inference endpoint.
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const root = path.resolve(`../evidence/checkpoint-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const home = path.join(root, 'home'); const project = path.join(root, 'project');
await fs.mkdir(project, { recursive: true });
// Use production file-tool code to seed/edit the isolated project, not a model.
const helper = path.join(root, 'workspace.mjs');
await build({ entryPoints: ['src/core/workspace.ts'], outfile: helper, bundle: true, platform: 'node', format: 'esm' });
const { writeWorkspaceText } = await import(pathToFileURL(helper).href);
const file = path.join(project, 'code.ts'); const original = 'const value=1;\n'; const formatted = '\ufeffconst value = 2;\r\n';
await fs.writeFile(file, original);
const checks = [], errors = [];
const executable = process.argv[2];
const env = { ...process.env, LOCALCODE_HOME: home, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') }; delete env.ELECTRON_RUN_AS_NODE;
let app, page, sessionId, journalFile, context;
async function launch() {
  for (const directory of new Set([env.TEMP, env.TMP])) await fs.mkdir(directory, { recursive: true });
  const runtime = executable || process.env.LOCALCODE_ELECTRON_PATH || require('electron');
  assert.equal(typeof runtime, 'string', 'Electron runtime did not resolve');
  assert((await fs.stat(runtime)).isFile(), 'Electron runtime is missing');
  app = await electron.launch({ executablePath: runtime, args: executable ? [] : [process.cwd()], env, timeout: 60000 });
  for (let i = 0; i < 100; i++) { page = app.windows().find(p => /\/index\.html$/.test(p.url())); if (page) break; await new Promise(r => setTimeout(r, 100)); }
  assert(page); page.on('pageerror', e => errors.push(e.message)); await page.getByLabel('任务输入').waitFor();
}
const journal = async () => JSON.parse(await fs.readFile(journalFile, 'utf8'));
const dialog = () => page.getByRole('dialog', { name: '确认当前内容为新起点', exact: true });
const openPreview = async () => { await page.getByRole('button', { name: '预览并设为新起点', exact: true }).click(); await dialog().waitFor(); };
const cancel = async () => { await dialog().getByRole('button', { name: '取消', exact: true }).click(); await dialog().waitFor({ state: 'detached' }); };
const confirm = () => dialog().getByRole('button', { name: '确认并保留当前内容', exact: true });
const refresh = () => page.getByRole('button', { name: '刷新文件差异', exact: true }).click();
try {
  await launch();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await page.getByRole('button', { name: '打开项目文件夹', exact: true }).first().click();
  sessionId = await page.evaluate(async () => { const boot = await window.localcode.bootstrap(); return (await window.localcode.createSession(boot.projects[0].id)).id; });
  await app.close(); app = undefined;
  context = { projectPath: project, dataDir: path.join(home, 'data'), protectedRoots: ['data', 'cache', 'logs'].map(name => path.join(home, name)), sessionId, runId: randomUUID() };
  await writeWorkspaceText({ ...context, relativePath: 'code.ts', content: 'const value=2;\n' });
  journalFile = path.join(context.dataDir, 'changes', sessionId, 'index.json');
  const firstJournal = await journal();
  await fs.writeFile(file, formatted);
  await launch(); await page.getByRole('button', { name: '切换文件与修改面板', exact: true }).click();
  await openPreview();
  assert.equal(await dialog().getByLabel('当前文件完整内容').textContent(), formatted);
  assert.equal(await dialog().getByRole('button', { name: '取消', exact: true }).evaluate(el => document.activeElement === el), true);
  assert((await dialog().innerText()).includes(`${Buffer.byteLength(formatted)} 字节`));
  assert((await dialog().innerText()).includes((await page.evaluate(id => window.localcode.previewCheckpoint({ sessionId: id, path: 'code.ts' }), sessionId)).currentHash));
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '预览并设为新起点', exact: true }).evaluate(el => document.activeElement === el), true);
  assert.deepEqual(await journal(), firstJournal);
  checks.push('full current preview and exact hash; cancel-first focus; Escape restores focus and changes no journal');

  await openPreview(); await fs.writeFile(file, 'newer external edit'); await confirm().click();
  await dialog().getByRole('alert').filter({ hasText: '预览后已再次修改' }).waitFor();
  assert(await confirm().isDisabled()); await cancel();
  assert.equal(await fs.readFile(file, 'utf8'), 'newer external edit'); assert.deepEqual(await journal(), firstJournal);
  await fs.writeFile(file, formatted); await openPreview();
  const changedRecord = structuredClone(firstJournal); changedRecord.records[0].runId = randomUUID(); await fs.writeFile(journalFile, JSON.stringify(changedRecord));
  await confirm().click(); await dialog().getByRole('alert').filter({ hasText: '修改记录在预览后已变化' }).waitFor(); await cancel();
  assert.deepEqual(await journal(), changedRecord);
  await fs.writeFile(journalFile, JSON.stringify(firstJournal));
  checks.push('changed file and changed journal separately invalidate displayed approval without losing either edit');

  const pending = structuredClone(firstJournal); pending.records[0].pending = true; await fs.writeFile(journalFile, JSON.stringify(pending));
  await page.getByRole('button', { name: '预览并设为新起点', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '写入未完成' }).waitFor();
  assert.equal(await dialog().count(), 0); assert.deepEqual(await journal(), pending);
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click(); await fs.writeFile(journalFile, JSON.stringify(firstJournal));
  await openPreview();
  // Repeated activation must still produce exactly one explicit journal checkpoint.
  await confirm().evaluate(el => { el.click(); el.click(); }); await dialog().waitFor({ state: 'detached' });
  const checkpointed = await journal(); assert.equal(checkpointed.checkpoints.length, 1);
  assert.deepEqual(checkpointed.checkpoints[0].previous, firstJournal.records[0]);
  assert.deepEqual(checkpointed.runRecords, firstJournal.runRecords);
  assert.equal(await fs.readFile(file, 'utf8'), formatted);
  checks.push('pending write fails closed; repeated confirm archives once and preserves current bytes and original per-round evidence');

  await writeWorkspaceText({ ...context, runId: randomUUID(), relativePath: 'code.ts', expectedText: formatted, content: 'const value = 3;\n' });
  await refresh(); await page.getByRole('button', { name: '撤销此文件修改', exact: true }).click();
  await page.getByText('修改会显示在这里', { exact: true }).waitFor();
  assert.equal(await fs.readFile(file, 'utf8'), formatted);
  assert.deepEqual((await journal()).checkpoints, checkpointed.checkpoints);
  await app.close(); app = undefined; await launch();
  assert.equal(await fs.readFile(file, 'utf8'), formatted);
  assert.deepEqual((await journal()).checkpoints, checkpointed.checkpoints);
  assert.deepEqual(errors, []); await page.screenshot({ path: path.join(root, 'after-checkpoint-undo.png') });
  checks.push('same-session next edit works; UI undo restores approved formatting, not pre-format bytes; archive survives undo and app restart');
} catch (error) { errors.push(error.stack); if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally {
  await app?.close().catch(() => {});
  const result = { passed: errors.length === 0, root, executable: executable || 'source', checks, errors, modelRequests: 0, productionData: 'NOT_USED' };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (errors.length) process.exitCode = 1;
}
