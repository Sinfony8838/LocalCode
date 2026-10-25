import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';

const root = path.resolve(`../evidence/providers-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const project = path.join(root, 'project'); await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(project, 'check.txt'), '原有用户内容\n');
const secret = 'provider-fixture-secret-NOT-A-REAL-KEY';
const fixture = await providerFixture(secret);
const checks = [], errors = [];
const executable = process.argv[2];
const env = { ...process.env, LOCALCODE_HOME: root, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') }; delete env.ELECTRON_RUN_AS_NODE;
let app, page, providerId, projectId;
async function launch() {
  app = await electron.launch({ executablePath: executable || path.resolve('node_modules/electron/dist/electron.exe'), args: executable ? [] : [process.cwd()], env, timeout: 60000 });
  for (let i = 0; i < 100; i++) { page = app.windows().find(p => /\/index\.html$/.test(p.url())); if (page) break; await new Promise(r => setTimeout(r, 100)); }
  assert(page); page.on('pageerror', e => errors.push(e.message));
  await page.getByLabel('任务输入').waitFor();
}
async function settings() { await page.getByRole('button', { name: '应用设置', exact: true }).click(); }
async function save() { await page.getByRole('button', { name: '保存配置', exact: true }).click(); await page.getByText('设置已保存。可在输入框下方手动选择此模型。', { exact: true }).waitFor(); }
async function waitSession(id, status = 'completed') {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const session = await page.evaluate(id => window.localcode.openSession(id), id);
    if (['completed', 'failed', 'interrupted'].includes(session.status)) { assert.equal(session.status, status, session.error); return session; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Session did not settle');
}

try {
  await launch();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await page.getByRole('button', { name: '打开项目文件夹', exact: true }).first().click();
  projectId = (await page.evaluate(() => window.localcode.bootstrap())).projects[0].id;
  await settings(); await page.getByRole('button', { name: '添加供应商', exact: true }).click();
  assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), 'https://ark.cn-beijing.volces.com/api/coding');
  await page.getByLabel('API 格式').selectOption('openai');
  assert.equal(await page.getByLabel('Base URL', { exact: true }).inputValue(), 'https://ark.cn-beijing.volces.com/api/coding/v3');
  await page.getByLabel('API 格式').selectOption('anthropic');
  assert.equal(fixture.requests.length, 0); checks.push('Ark preset protocol URLs; saving and editing never call provider');
  await page.getByLabel('供应商名称').fill('火山方舟（本机模拟）');
  await page.getByLabel('Base URL', { exact: true }).fill(fixture.baseUrl + '/api/coding');
  await page.getByLabel('API Key', { exact: true }).fill(secret);
  await page.getByRole('button', { name: '显示输入的密钥' }).click(); assert.equal(await page.getByLabel('API Key', { exact: true }).getAttribute('type'), 'text');
  await page.getByRole('button', { name: '隐藏输入的密钥' }).click();
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('模型 ID 2', { exact: true }).fill('second-model');
  await page.getByLabel('上下文窗口 2', { exact: true }).fill('65536');
  await save();
  let boot = await page.evaluate(() => window.localcode.bootstrap()); providerId = boot.settings.providers.find(p => p.kind === 'anthropic').id;
  assert.equal(fixture.requests.length, 0); assert(!JSON.stringify(boot).includes(secret));
  assert(!(await fs.readFile(path.join(root, 'data/index.json'), 'utf8')).includes(secret));
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  await page.locator('.settings-content').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.join(root, '01-model-settings.png') });
  await page.getByRole('button', { name: '测试模型 1', exact: true }).click();
  await page.getByText('连接测试成功。已收到模型响应；工具调用需在任务中验证。', { exact: true }).waitFor();
  assert.equal(fixture.requests.length, 1); assert.equal(fixture.requests[0].url, '/api/coding/v1/messages');
  checks.push('UI multiple models, Windows encrypted key, explicit saved-credential connection test');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: '火山方舟（本机模拟） · second-model', exact: true }).click();
  fixture.queue.push({ tool: { name: 'read_file', args: { path: 'check.txt' } } }, { text: '已读取原有用户内容，第二模型验证通过。' });
  await page.getByLabel('任务输入').fill('读取 check.txt，报告内容。'); await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
  boot = await page.evaluate(() => window.localcode.bootstrap());
  const first = await waitSession(boot.sessions[0].id); assert.equal(first.modelId, 'second-model'); assert(first.tools.some(t => t.name === 'read_file' && t.result.includes('原有用户内容')));
  assert.equal(fixture.requests.at(-1).body.model, 'second-model');
  assert(JSON.stringify(fixture.requests.at(-1).body.messages).includes('原有用户内容'));
  checks.push('Anthropic real SDK streaming + read tool + result roundtrip; chat selects second model');
  for (const kind of ['openai', 'responses']) {
    await settings(); await page.getByRole('button', { name: '火山方舟（本机模拟）', exact: true }).click();
    await page.getByLabel('API 格式').selectOption(kind); await page.getByLabel('Base URL', { exact: true }).fill(fixture.baseUrl + '/api/coding/v3');
    await save(); await page.getByRole('button', { name: '测试模型 2', exact: true }).click();
    await page.getByText('连接测试成功。已收到模型响应；工具调用需在任务中验证。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    // Continue the same pi transcript across transports.
    fixture.queue.push({ tool: { name: 'edit_file', args: { path: 'check.txt', oldText: kind === 'openai' ? '原有用户内容' : 'OpenAI 修改', newText: kind === 'openai' ? 'OpenAI 修改' : 'Responses 修改' } } }, { text: `${kind} 工具链完成。` });
    await page.evaluate(({ id, providerId, kind }) => window.localcode.send({ sessionId: id, providerId, modelId: 'second-model', prompt: `${kind} 修改测试` }), { id: first.id, providerId, kind });
    const session = await waitSession(first.id);
    assert(session.messages.at(-1).text.includes(kind)); assert.equal(fixture.requests.at(-1).kind, kind);
    assert.equal(fixture.requests.at(-1).body.model, 'second-model');
    assert((await fs.readFile(path.join(project, 'check.txt'), 'utf8')).includes(kind === 'openai' ? 'OpenAI 修改' : 'Responses 修改'));
    checks.push(`${kind}: saved-key probe, SDK streaming, edit tool, transcript resumed across protocols`);
  }
  // Remote errors must not echo credentials to the renderer, logs or pi JSONL.
  fixture.queue.push({ error: 401 });
  await page.evaluate(({ id, providerId }) => window.localcode.send({ sessionId: id, providerId, modelId: 'second-model', prompt: '模拟错误' }), { id: first.id, providerId });
  const failed = await waitSession(first.id, 'failed'); assert(!JSON.stringify(failed).includes(secret));
  await settings(); await page.getByRole('button', { name: '火山方舟（本机模拟）', exact: true }).click();
  fixture.queue.push({ error: 401 }); await page.getByRole('button', { name: '测试模型 1', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'HTTP 401' }).waitFor();
  assert(!(await page.locator('body').innerText()).includes(secret));
  const pi = await fs.readFile(failed.piFile, 'utf8'); assert(!pi.includes(secret));
  for (const name of await fs.readdir(path.join(root, 'data/logs'))) assert(!(await fs.readFile(path.join(root, 'data/logs', name), 'utf8')).includes(secret));
  checks.push('provider 401 is failed, credentials redacted from UI, logs and pi transcript');
  // Enabled flags are enforced in main process, independently of dropdown visibility.
  await page.getByLabel('启用模型 2', { exact: true }).uncheck(); await save();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '选择模型', exact: true }).innerText(), '请选择可用模型');
  await page.getByLabel('任务输入').fill('停用模型不得静默切换');
  assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isDisabled(), true);
  await settings(); await page.getByRole('button', { name: '火山方舟（本机模拟）', exact: true }).click();
  await assert.rejects(page.evaluate(({ id, providerId }) => window.localcode.send({ sessionId: id, providerId, modelId: 'second-model', prompt: 'must not run' }), { id: first.id, providerId }), /停用/);
  await page.getByLabel('启用供应商', { exact: true }).uncheck(); await save();
  await assert.rejects(page.evaluate(({ id, providerId }) => window.localcode.send({ sessionId: id, providerId, prompt: 'must not run' }), { id: first.id, providerId }), /停用/);
  await page.getByLabel('启用供应商', { exact: true }).check(); await save();
  await app.close(); await launch(); await settings(); await page.getByRole('button', { name: '火山方舟（本机模拟）', exact: true }).click();
  assert.equal(await page.getByLabel('启用模型 2', { exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel('API 格式').inputValue(), 'responses');
  assert((await page.evaluate(() => window.localcode.bootstrap())).settings.providers.find(p => p.id === providerId).hasKey);
  checks.push('restart preserves models, protocol, enabled flags and encrypted credentials');
  await page.getByRole('button', { name: '外观', exact: true }).click(); await page.getByRole('button', { name: '深色', exact: true }).click(); await page.getByLabel('字号', { exact: true }).selectOption('20');
  await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByRole('button', { name: '火山方舟（本机模拟）', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => /\/index\.html$/.test(w.webContents.getURL())).setSize(1050, 700));
  await page.waitForTimeout(250);
  assert(await page.evaluate(() => { const el = document.querySelector('.settings-content'); return el.scrollWidth <= el.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; }));
  await page.screenshot({ path: path.join(root, '02-dark-compact-font20.png') });
  checks.push('1050x700 dark model settings at font 20: no horizontal overflow');
  await page.getByRole('button', { name: '删除供应商', exact: true }).click(); await page.getByRole('button', { name: '取消', exact: true }).click();
  assert((await page.evaluate(() => window.localcode.bootstrap())).settings.providers.some(p => p.id === providerId));
  await page.getByRole('button', { name: '删除供应商', exact: true }).click(); await page.getByRole('button', { name: '确认删除供应商', exact: true }).click();
  await page.getByRole('button', { name: '火山方舟（本机模拟）', exact: true }).waitFor({ state: 'detached' });
  boot = await page.evaluate(() => window.localcode.bootstrap()); assert(boot.sessions.some(s => s.id === first.id)); assert(!JSON.parse(await fs.readFile(path.join(root, 'data/index.json'), 'utf8')).keys[providerId]);
  checks.push('delete confirmation cancellation + provider/key removal preserves history');
  assert.deepEqual(fixture.errors, []);
} catch (e) { errors.push(e.stack); console.error(e.stack); if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally {
  await app?.close().catch(() => {}); fixture.close();
  const result = { passed: errors.length === 0, root, executable: executable || 'source', checks, errors, requests: fixture.requests.map(r => ({ kind: r.kind, url: r.url, model: r.body.model, stream: r.body.stream })), realArkApi: 'UNRUN: no user key provided; all calls use localhost' };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (errors.length) process.exitCode = 1;
}
