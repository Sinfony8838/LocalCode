import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';

const root = path.resolve(`../evidence/sessions-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const project = path.join(root, 'project'); await fs.mkdir(project, { recursive: true });
const fixtures = await Promise.all(['A', 'B', 'C'].map(name => providerFixture(`session-fixture-${name}-not-real`)));
const checks = [], errors = [], gates = [];
const executable = process.argv[2];
const env = { ...process.env, LOCALCODE_HOME: root, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') }; delete env.ELECTRON_RUN_AS_NODE;
let app, page, projectId, a, b, c;
const hold = fixture => {
  let release; const gate = new Promise(resolve => { release = resolve; }); gates.push(release);
  fixture.queue.push({ gate, text: 'held response' }); return release;
};
async function poll(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
const state = () => page.evaluate(() => window.localcode.bootstrap());
async function session(id, status) { return poll(async () => { const s = (await state()).sessions.find(s => s.id === id); return (!status || s.status === status) && s; }, `session ${id} ${status || ''}`); }
async function select(id) { const s = await session(id); await page.locator('.session-button').filter({ hasText: s.title }).click(); }
async function sendUI(name, prompt) {
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: `Fixture ${name} · model-${name}`, exact: true }).click();
  await page.getByLabel('任务输入').fill(prompt); await page.getByRole('button', { name: '发送任务', exact: true }).click();
}
async function launch() {
  app = await electron.launch({ executablePath: executable || path.resolve('node_modules/electron/dist/electron.exe'), args: executable ? [] : [process.cwd()], env, timeout: 60000 });
  page = await poll(() => app.windows().find(p => /\/index\.html$/.test(p.url())), 'main window');
  page.on('pageerror', e => errors.push(e.message)); await page.getByLabel('任务输入').waitFor();
}
try {
  await launch();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await page.getByRole('button', { name: '打开项目文件夹', exact: true }).first().click();
  projectId = (await state()).projects[0].id;
  for (const [i, name] of ['A', 'B', 'C'].entries()) {
    await page.evaluate(({ name, baseUrl }) => window.localcode.saveProvider({ id: `fixture-${name}`, name: `Fixture ${name}`, kind: 'openai', baseUrl, model: `model-${name}`, contextWindow: 8192, maxTokens: 256, apiKey: `session-fixture-${name}-not-real` }), { name, baseUrl: fixtures[i].baseUrl });
  }
  await poll(async () => (await page.getByRole('button', { name: '选择模型' }).isEnabled()), 'provider UI');
  hold(fixtures[0]);
  await sendUI('A', 'SESSION_A_ONLY');
  a = await poll(async () => (await state()).sessions.find(s => s.title === 'SESSION_A_ONLY' && s.status === 'running'), 'A running');
  await poll(() => fixtures[0].requests.length, 'A inference started');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByRole('button', { name: '发送任务', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '停止任务', exact: true }).count(), 0);
  await page.getByLabel('任务输入').fill('SESSION_B_ONLY');
  assert(await page.getByRole('button', { name: '发送任务', exact: true }).isEnabled());
  await page.screenshot({ path: path.join(root, '01-idle-session-while-a-running.png') });
  checks.push('new idle session shows enabled send button while A runs; no global stop button');
  fixtures[1].queue.push({ tool: { name: 'powershell', args: { command: "[IO.File]::WriteAllText((Join-Path (Get-Location) 'began.txt'),'began'); Start-Sleep -Seconds 12; [IO.File]::WriteAllText((Join-Path (Get-Location) 'done.txt'),'done')" } } }, { text: 'SESSION_B_FINISHED' });
  await sendUI('B', 'SESSION_B_ONLY');
  b = await poll(async () => (await state()).sessions.find(s => s.title === 'SESSION_B_ONLY' && s.status === 'awaiting_approval'), 'B approval');
  assert.equal((await session(a.id)).status, 'running');
  await assert.rejects(page.evaluate(({ runId, approvalId }) => window.localcode.approve({ runId, approvalId, allow: true }), { runId: a.runId, approvalId: b.approval.id }), /审批/);
  const duplicate = await page.evaluate(async id => {
    try { await window.localcode.send({ sessionId: id, providerId: 'fixture-A', prompt: 'duplicate' }); return false; } catch { return true; }
  }, a.id); assert(duplicate);
  await select(a.id); await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await session(a.id, 'interrupted');
  assert.equal((await session(b.id)).approval.id, b.approval.id);
  await select(b.id); await page.getByRole('button', { name: '允许这一次', exact: true }).click();
  await poll(async () => fs.access(path.join(project, 'began.txt')).then(() => true, () => false), 'B command began');
  checks.push('A and B run concurrently; duplicate A rejected; cross-run approval rejected; stopping A preserves B approval');
  const owned = path.join(root, 'data/owned-commands');
  const records = await fs.readdir(owned); assert(records.some(n => n.endsWith('.json')));
  const commandRecord = JSON.parse(await fs.readFile(path.join(owned, records.find(n => n.endsWith('.json'))), 'utf8')); assert(commandRecord.workerPid);
  const before = await app.evaluate(({ app }) => app.getAppMetrics().map(m => m.pid));
  hold(fixtures[0]);
  await select(a.id); await page.getByLabel('任务输入').fill('SESSION_A_RESTART'); await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await poll(() => fixtures[0].requests.length >= 2, 'A restarted');
  const workerPid = await poll(async () => (await app.evaluate(({ app }) => app.getAppMetrics())).find(m => m.type === 'Utility' && m.name === 'LocalCode Agent' && !before.includes(m.pid))?.pid, 'A worker PID');
  await app.evaluate((_, pid) => process.kill(pid), workerPid);
  await session(a.id, 'interrupted');
  assert.equal((await session(b.id)).status, 'running');
  assert(await fs.access(path.join(owned, records.find(n => n.endsWith('.json')))).then(() => true, () => false));
  checks.push('crashing A cleans only A command ownership; B running PowerShell and ownership record survive');
  fixtures[2].queue.push({ text: 'SESSION_C_FINISHED' });
  await page.getByRole('button', { name: '新建任务', exact: true }).click(); await sendUI('C', 'SESSION_C_ONLY');
  c = await poll(async () => (await state()).sessions.find(s => s.title === 'SESSION_C_ONLY' && s.status === 'completed'), 'C completed');
  assert.equal((await session(b.id)).status, 'running');
  await select(b.id); await page.screenshot({ path: path.join(root, '02-b-survives-a-crash-and-c-completion.png') });
  await session(b.id, 'completed'); assert.equal(await fs.readFile(path.join(project, 'done.txt'), 'utf8'), 'done');
  for (const [id, forbidden] of [[a.id, 'SESSION_B_FINISHED'], [b.id, 'SESSION_C_FINISHED'], [c.id, 'SESSION_B_FINISHED']]) assert(!(await session(id)).messages.some(m => m.text.includes(forbidden)));
  checks.push('C completes while B runs; B command finishes successfully; messages and tools remain session-scoped');
  await app.close(); app = undefined;
  await launch();
  assert.equal((await session(a.id)).status, 'interrupted'); assert.equal((await session(b.id)).status, 'completed'); assert.equal((await session(c.id)).status, 'completed');
  assert.equal((await fs.readdir(owned)).length, 0);
  checks.push('restart persists independent statuses and transcripts; no abandoned command records');
} catch (e) { errors.push(e.stack); if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally {
  gates.forEach(release => release()); await app?.close().catch(() => {}); fixtures.forEach(f => f.close());
  const result = { passed: errors.length === 0, root, executable: executable || 'source', checks, errors, paidModelRequests: 0, productionData: 'NOT_USED' };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (errors.length) process.exitCode = 1;
}
