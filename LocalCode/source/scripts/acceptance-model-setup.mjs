// Windows Electron acceptance with a synthetic read-only Ollama server.
// Never downloads models or calls an inference endpoint (local or cloud).
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const root = path.resolve(`../evidence/model-setup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const home = path.join(root, 'home');
const project = path.join(root, 'project'); await fs.mkdir(project, { recursive: true });
const checks = [], errors = [], requests = [];
let tags = [{ name: 'tiny:latest' }, { name: 'coder:latest' }];
const server = http.createServer((req, res) => {
  requests.push({ method: req.method, url: req.url });
  const data = req.url === '/api/tags' ? { models: tags } : req.url === '/api/version' ? { version: 'fixture-1' } : req.url === '/api/ps' ? { models: [] } : undefined;
  res.writeHead(req.method === 'GET' && data ? 200 : 405, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data ?? { error: 'Inference is forbidden in this fixture' }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
// Keep the offline probe port reserved, but terminate every request. A released
// ephemeral port could be reused by Electron and make this regression flaky.
const offline = http.createServer(req => req.socket.destroy());
await new Promise(resolve => offline.listen(0, '127.0.0.1', resolve));
const offlineUrl = `http://127.0.0.1:${offline.address().port}/v1`;
const executable = process.argv[2];
const env = { ...process.env, LOCALCODE_HOME: home, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') }; delete env.ELECTRON_RUN_AS_NODE;
let app, page, sessionId;
async function launch() {
  for (const directory of new Set([env.TEMP, env.TMP])) await fs.mkdir(directory, { recursive: true });
  const runtime = executable || process.env.LOCALCODE_ELECTRON_PATH || require('electron');
  assert.equal(typeof runtime, 'string', 'Electron runtime did not resolve');
  assert((await fs.stat(runtime)).isFile(), 'Electron runtime is missing');
  app = await electron.launch({ executablePath: runtime, args: executable ? [] : [process.cwd()], env, timeout: 60000 });
  for (let i = 0; i < 100; i++) { page = app.windows().find(p => /\/index\.html$/.test(p.url())); if (page) break; await new Promise(r => setTimeout(r, 100)); }
  assert(page); page.on('pageerror', e => errors.push(e.message)); await page.getByLabel('任务输入').waitFor();
}
const check = () => page.getByRole('button', { name: '检查服务并列出已安装模型', exact: true }).click();
const saved = () => page.getByRole('status').filter({ hasText: '本地配置已保存' }).waitFor();
try {
  await launch();
  await page.getByRole('region', { name: '模型配置指引' }).waitFor();
  assert((await page.locator('.model-setup-banner').innerText()).includes('Install-LocalModel.cmd'));
  assert.equal(requests.length, 0);
  assert.equal((await page.evaluate(() => window.localcode.health())).status, 'missing_runtime');
  checks.push('first-launch visible remedies: portable installer, source setup, existing Ollama, cloud API; no auto-start or inference');
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await page.getByRole('button', { name: '打开项目文件夹', exact: true }).first().click();
  sessionId = await page.evaluate(async () => { const boot = await window.localcode.bootstrap(); return (await window.localcode.createSession(boot.projects[0].id)).id; });
  await page.getByRole('button', { name: '配置模型与检查环境', exact: true }).click();
  await page.getByLabel('Ollama 服务来源').selectOption('existing');
  await page.getByLabel('Base URL', { exact: true }).fill(offlineUrl); await check();
  await page.getByRole('status').filter({ hasText: 'Ollama 无法连接' }).waitFor();
  await page.getByLabel('Base URL', { exact: true }).fill('http://example.invalid/v1'); await check();
  await page.getByRole('alert').filter({ hasText: '回环地址' }).waitFor();
  assert.equal(requests.length, 0);
  await page.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  await page.getByLabel('模型 ID', { exact: true }).fill('missing-model'); await check();
  await page.getByRole('status').filter({ hasText: '所选模型尚未安装' }).waitFor();
  await page.getByLabel('选择已安装模型').selectOption('tiny:latest');
  await page.getByLabel('上下文窗口', { exact: true }).fill('4096');
  await page.getByLabel('单次输出上限', { exact: true }).fill('512');
  await page.getByRole('button', { name: '保存配置', exact: true }).click(); await saved();
  let boot = await page.evaluate(() => window.localcode.bootstrap());
  assert.equal(boot.health.status, 'ready');
  assert.equal(boot.settings.providers[0].model, 'tiny:latest');
  assert.equal(boot.settings.providers[0].contextWindow, 4096);
  assert.equal(boot.settings.providers[0].maxTokens, 512);
  checks.push('offline versus missing-model diagnostics; loopback validation; installed model dropdown; editable saved budgets');
  // Dismiss an unsaved edit; returning to settings must show durable configuration.
  await page.getByLabel('模型 ID', { exact: true }).fill('discard-me');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  assert.equal(await page.getByLabel('模型 ID', { exact: true }).inputValue(), 'tiny:latest');
  await app.close(); app = undefined;
  // Fixture-only prior conversation: no inference request is needed to verify preservation.
  const indexPath = path.join(home, 'data/index.json'); const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  index.sessions.find(s => s.id === sessionId).messages.push({ id: 'fixture-history', role: 'user', text: '保留已有对话', createdAt: new Date().toISOString() });
  await fs.writeFile(indexPath, JSON.stringify(index));
  await launch(); boot = await page.evaluate(() => window.localcode.bootstrap());
  assert.equal(boot.settings.providers[0].ollamaMode, 'existing');
  assert.equal(boot.settings.providers[0].contextWindow, 4096);
  assert.equal(boot.sessions.find(s => s.id === sessionId).messages[0].text, '保留已有对话');
  checks.push('close/reopen discards unsaved edits; restart preserves model mode, name, budgets and history');
  // A saved cloud configuration must not require local service availability.
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await page.getByRole('button', { name: '自定义 API', exact: true }).click();
  await page.getByLabel('供应商名称', { exact: true }).fill('Cloud fixture');
  await page.getByLabel('Base URL', { exact: true }).fill(baseUrl);
  await page.getByLabel('模型 ID', { exact: true }).fill('cloud-fixture');
  await page.getByLabel('API Key', { exact: true }).fill('fixture-only-not-a-real-key');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '设置已保存。可在输入框' }).waitFor();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  tags = []; await page.getByRole('button', { name: '刷新模型连接', exact: true }).click();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: 'Cloud fixture · cloud-fixture', exact: true }).click();
  await page.getByText('云端模式 · 无需 Ollama', { exact: true }).waitFor();
  assert.equal(await page.locator('.model-setup-banner').count(), 0);
  assert(!JSON.stringify(await page.evaluate(() => window.localcode.bootstrap())).includes('fixture-only-not-a-real-key'));
  assert(requests.every(r => r.method === 'GET' && ['/api/tags', '/api/version', '/api/ps'].includes(r.url)));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'cloud-without-local.png') });
  checks.push('cloud mode removes local prerequisite warning; credentials remain private; fixture received only bounded read-only discovery GETs');
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ checks, requestCount: requests.length, errors }, null, 2));
  console.log(JSON.stringify({ root, checks }, null, 2));
} finally { await app?.close().catch(() => {}); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => offline.close(resolve)); }
