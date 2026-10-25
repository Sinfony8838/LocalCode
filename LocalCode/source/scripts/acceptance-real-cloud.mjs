// Explicit opt-in paid acceptance. Reads provider metadata only. The user enters
// credentials in the isolated desktop; source credentials/profiles are never copied.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { values } = parseArgs({ options: { 'provider-index': { type: 'string' }, executable: { type: 'string' } } });
assert(values['provider-index'], 'Explicit --provider-index is required; this script makes real cloud requests.');
const originalBytes = await fs.readFile(values['provider-index']);
const source = JSON.parse(originalBytes.toString('utf8').replace(/^\uFEFF/, ''));
const selected = source.settings.providers.find(provider => provider.kind === 'anthropic' && provider.baseUrl.replace(/\/$/, '') === 'https://ark.cn-beijing.volces.com/api/coding' && provider.model === 'ark-code-latest');
assert(selected, 'Requested saved Ark Coding Plan configuration was not found.');
const model = selected.models?.find(item => item.id === 'ark-code-latest') ?? { id: selected.model, contextWindow: selected.contextWindow, maxTokens: selected.maxTokens, enabled: true };
const provider = { ...selected, model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, enabled: true, models: [{ ...model, enabled: true }], hasKey: false };
const root = path.resolve(`../evidence/real-cloud-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const home = path.join(root, 'home'); const project = path.join(root, 'project');
await fs.mkdir(path.join(home, 'data'), { recursive: true }); await fs.mkdir(project);
const local = { id: 'local', name: 'Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'localcode-agent:latest', contextWindow: 8192, maxTokens: 1024, hasKey: false };
await fs.writeFile(path.join(home, 'data/index.json'), JSON.stringify({ version: 1, projects: [], sessions: [], settings: { theme: 'light', fontSize: 14, defaultProviderId: provider.id, providers: [local, provider] }, keys: {} }), { mode: 0o600, flag: 'wx' });
const fixtureRoot = path.resolve('../../scripts/acceptance/project');
for (const name of ['numbers.ps1', 'Test-Numbers.ps1']) await fs.copyFile(path.join(fixtureRoot, name), path.join(project, name));
const env = { ...process.env, LOCALCODE_HOME: home, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], runs = [];
const evidence = { provider: provider.name, kind: provider.kind, baseUrl: provider.baseUrl, requestedModel: provider.model,
  contextWindow: provider.contextWindow, maxTokens: provider.maxTokens, cost: null, costStatus: 'UNKNOWN: subscription/provider billing not exposed by the application', connectionCalls: 0,
  startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirtySource: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()), originalConfigurationModified: false };
let app, page, projectId;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(work, label, timeout = 240000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await work(); if (value) return value; await sleep(150); } throw new Error(`Timed out: ${label}`); }
const state = id => page.evaluate(id => window.localcode.openSession(id), id);
async function runTask(label, prompt, approvalMode) {
  const session = await page.evaluate(id => window.localcode.createSession(id), projectId);
  const receipt = await page.evaluate(input => window.localcode.send(input), { sessionId: session.id, providerId: provider.id, modelId: provider.model, prompt });
  const approvals = []; const seen = new Set(); let cancelled = false;
  const final = await poll(async () => {
    const current = await state(session.id);
    if (current.approval && !seen.has(current.approval.id)) {
      const approval = current.approval; seen.add(approval.id);
      const command = approval.command.trim();
      const allow = approvalMode === 'test' ? /^(?:powershell(?:\.exe)?\s+-NoProfile\s+-File\s+)?(?:\.\\|\.\/)?Test-Numbers\.ps1$/i.test(command)
        : approvalMode === 'cancel' && /^Start-Sleep\s+-Seconds\s+30$/i.test(command);
      assert.equal(path.resolve(approval.cwd).toLowerCase(), project.toLowerCase(), 'Unexpected approval cwd');
      approvals.push({ command, allowed: Boolean(allow) });
      await page.evaluate(input => window.localcode.approve(input), { runId: receipt.runId, approvalId: approval.id, allow: Boolean(allow) });
      if (approvalMode === 'cancel' && allow) {
        await sleep(1200); await page.evaluate(id => window.localcode.stop(id), session.id); cancelled = true;
      }
    }
    if (['completed', 'failed', 'interrupted'].includes(current.status)) return current;
  }, label);
  const summary = final.runs?.find(run => run.runId === receipt.runId);
  runs.push({ label, sessionId: session.id, runId: receipt.runId, status: final.status, error: final.error, approvals, tools: final.tools.map(tool => ({ name: tool.name, status: tool.status, isError: tool.isError })), summary });
  if (approvalMode === 'cancel') { assert(cancelled, 'No approved sleep was cancelled'); assert.equal(final.status, 'interrupted', final.error); }
  else assert.equal(final.status, 'completed', final.error);
  console.log(`Completed real-cloud case: ${label} (${final.status})`);
  return final;
}
try {
  await fs.mkdir(env.TEMP, { recursive: true });
  app = await electron.launch({ executablePath: values.executable || process.env.LOCALCODE_ELECTRON_PATH || require('electron'), args: values.executable ? [] : [process.cwd()], env, timeout: 60000 });
  page = await poll(() => app.windows().find(window => /\/index\.html$/.test(window.url())), 'main window', 30000);
  await app.evaluate(() => {
    globalThis.__cloudConnection = { calls: 0, models: [], usage: [] };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (new URL(typeof input === 'string' ? input : input.url ?? input.href).hostname !== 'ark.cn-beijing.volces.com') return originalFetch(input, init);
      globalThis.__cloudConnection.calls++;
      const response = await originalFetch(input, init);
      if (response.ok) {
        const data = await response.clone().json();
        if (data.model) globalThis.__cloudConnection.models.push(data.model);
        if (data.usage) globalThis.__cloudConnection.usage.push(data.usage);
      }
      return response;
    };
  });
  page.on('pageerror', error => errors.push(error.message)); await page.getByLabel('任务输入').waitFor();
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await page.getByRole('button', { name: provider.name, exact: true }).click();
  console.log('WAITING_FOR_MANUAL_KEY: Enter the Ark API Key in this isolated LocalCode Settings window and click Save. Do not send the key in chat.');
  await poll(async () => page.evaluate(id => window.localcode.bootstrap().then(state => state.settings.providers.find(item => item.id === id)?.hasKey === true), provider.id), 'manual credential entry and save', 20 * 60 * 1000);
  await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor();
  await page.getByRole('button', { name: '测试模型 1', exact: true }).click();
  await poll(async () => {
    if (await page.getByRole('status').filter({ hasText: '连接测试成功' }).count()) return true;
    const message = await page.locator('.form-feedback.error').textContent().catch(() => ''); if (message) throw new Error(message);
  }, 'real cloud connection test', 45000);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  const projectView = await page.evaluate(() => window.localcode.pickProject()); projectId = projectView.id;
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: `${provider.name} · ${provider.model}`, exact: true }).click();
  await page.getByText('云端模式 · 无需 Ollama', { exact: true }).waitFor();
  checks.push('saved encrypted provider configuration, tested real connection, selected ark-code-latest in the Electron UI');

  const fixed = await runTask('read-edit-test-summary', '这是仅含虚构文件的验收项目。请先用文件工具读取 numbers.ps1 和 Test-Numbers.ps1，修复 Add-Numbers 的加法错误，保持测试文件不变。随后只请求执行这个精确终端命令：powershell.exe -NoProfile -File .\\Test-Numbers.ps1。等待批准，实际运行测试，再总结修改和测试结果；不要把收到回复等同于测试通过。', 'test');
  assert(fixed.tools.some(tool => tool.name === 'read_file' && !tool.isError)); assert(fixed.tools.some(tool => ['edit_file', 'write_file'].includes(tool.name) && !tool.isError));
  assert(fixed.tools.some(tool => tool.name === 'powershell' && !tool.isError && /PASS: 3 addition cases/.test(tool.result || '')));
  assert(fixed.messages.some(message => message.role === 'assistant' && message.text && !message.partial));
  const testResult = execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(project, 'Test-Numbers.ps1')], { encoding: 'utf8' }); assert.match(testResult, /PASS: 3 addition cases/);
  assert.equal(await fs.readFile(path.join(project, 'Test-Numbers.ps1'), 'utf8'), await fs.readFile(path.join(fixtureRoot, 'Test-Numbers.ps1'), 'utf8'));
  checks.push('real tool reads, file edit, explicit approved terminal test and post-tool summary; independent test also passed');

  const denied = await runTask('denied-command', '验收命令拒绝流程。只请求用 PowerShell 终端创建 denied.txt。若用户拒绝，立即结束并说明命令未执行；不得换工具、换命令或自动重试创建文件。', 'deny');
  assert(runs.at(-1).approvals.length > 0 && runs.at(-1).approvals.every(approval => !approval.allowed));
  assert(!denied.tools.some(tool => ['edit_file', 'write_file'].includes(tool.name)));
  await assert.rejects(fs.stat(path.join(project, 'denied.txt')), { code: 'ENOENT' });
  checks.push('denied real-model terminal request did not execute or fall back to file tools');

  const interrupted = await runTask('cancel-command', '验收取消流程。首先只请求执行精确终端命令 Start-Sleep -Seconds 30，等待用户批准。它成功结束后才用文件工具创建 after-cancel.txt。若任务被取消，不得继续任何工具操作。', 'cancel');
  const afterStop = JSON.stringify(interrupted.tools); await sleep(10000);
  assert.equal(JSON.stringify((await state(interrupted.id)).tools), afterStop);
  await assert.rejects(fs.stat(path.join(project, 'after-cancel.txt')), { code: 'ENOENT' });
  checks.push('approved command cancelled; ten-second observation found no later tool execution or file creation');
  assert.deepEqual(errors, []);
} catch (error) { errors.push(error.stack); }
finally {
  const connection = await app?.evaluate(() => globalThis.__cloudConnection).catch(() => undefined);
  evidence.connectionCalls = connection?.calls ?? 0;
  await app?.close().catch(() => {});
  const usage = [], responses = new Set(connection?.models ?? []); let taskRequests = 0;
  for (const name of await fs.readdir(path.join(home, 'data/logs')).catch(() => [])) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
    for (const line of (await fs.readFile(path.join(home, 'data/logs', name), 'utf8')).split('\n').filter(Boolean)) { const item = JSON.parse(line); if (item.type === 'request_start') taskRequests++; }
  }
  const index = JSON.parse(await fs.readFile(path.join(home, 'data/index.json'), 'utf8'));
  for (const session of index.sessions) if (session.piFile) {
    for (const line of (await fs.readFile(session.piFile, 'utf8')).split('\n').filter(Boolean)) {
      const item = JSON.parse(line); const message = item.message;
      if (message?.role !== 'assistant') continue;
      if (message.model) responses.add(message.model);
      if (message.usage) usage.push({ input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite, totalTokens: message.usage.totalTokens });
    }
  }
  evidence.originalConfigurationModified = !(await fs.readFile(values['provider-index'])).equals(originalBytes);
  if (evidence.originalConfigurationModified) errors.push('Source configuration changed during acceptance; it was not written by this script.');
  const report = { ...evidence, passed: errors.length === 0 && checks.length === 4, root, executable: values.executable || 'source', checks, runs, taskRequests, totalRequests: taskRequests + evidence.connectionCalls, requestCountBasis: 'Connection fetch calls plus worker request_start attempts; provider billing confirmation unavailable', connectionUsage: connection?.usage ?? [], responseModels: [...responses], responseModelVersionStatus: 'Only provider-returned model identifiers are recorded; mutable alias underlying version may be undisclosed.', usage, errors, endedAt: new Date().toISOString(), releaseReady: false, productionHistoriesUsed: false };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.resolve('../evidence/real-cloud-latest.json'), JSON.stringify({ root, report: path.join(root, 'report.json'), passed: report.passed }, null, 2));
  console.log(JSON.stringify({ passed: report.passed, report: path.join(root, 'report.json'), checks, totalRequests: report.totalRequests, responseModels: report.responseModels, errors }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
