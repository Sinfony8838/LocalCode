import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';

const root = path.resolve(`../evidence/task-projects-${Date.now()}`), executable = process.argv[2];
const projectA = path.join(root, '项目甲'), projectB = path.join(root, '项目乙');
await fs.mkdir(path.join(root, 'data'), { recursive: true });
await fs.mkdir(projectA); await fs.mkdir(projectB);
await fs.writeFile(path.join(root, 'data/pets.json'), JSON.stringify({ version: 1, enabled: false }));
const fixture = await providerFixture('task-projects-fixture-not-real');
const env = { ...process.env, LOCALCODE_HOME: root, LOCALCODE_SKIP_OLLAMA_START: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = []; let app, page, release;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label) { const end = Date.now() + 30000; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(80); } throw new Error(`Timed out: ${label}`); }
const state = () => page.evaluate(() => window.localcode.bootstrap());
const chat = id => page.evaluate(id => window.localcode.openSession(id), id);
const input = () => page.getByLabel('任务输入', { exact: true });
async function launch() {
  app = await electron.launch({ executablePath: executable ? path.resolve(executable) : path.resolve('node_modules/electron/dist/electron.exe'), args: executable ? [] : [process.cwd()], env, timeout: 60000 });
  page = await poll(() => app.windows().find(p => /\/index\.html$/.test(p.url())), 'main window');
  page.on('pageerror', error => errors.push(error.stack)); await input().waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => /\/index\.html$/.test(w.webContents.getURL()))?.setContentSize(1280, 900));
}
async function send(prompt) { await input().fill(prompt); await page.getByRole('button', { name: '发送任务', exact: true }).click(); }
async function settled(id) { return poll(async () => { const s = await chat(id); if (s.status === 'failed' || s.status === 'interrupted') throw new Error(s.error || s.status); return s.status === 'completed' && s; }, 'task completed'); }
async function taskMenu(id) { await page.locator(`.session-row[data-session-id="${id}"] .session-more`).click(); }
const projectMenu = name => page.getByRole('button', { name: `项目选项 ${name}`, exact: true }).click();
try {
  await launch(); assert.equal(await input().isEnabled(), true); assert.equal((await state()).projects.length, 0);
  await app.evaluate(({ dialog }, folder) => { globalThis.__pickerCount = 0; globalThis.__folder = folder; dialog.showOpenDialog = async () => { globalThis.__pickerCount++; return { canceled: false, filePaths: [globalThis.__folder] }; }; }, projectA);
  await page.evaluate(baseUrl => window.localcode.saveProvider({ id: 'task-fixture', name: '任务测试', kind: 'openai', baseUrl, model: 'mock', contextWindow: 16384, maxTokens: 1024, apiKey: 'task-projects-fixture-not-real' }), fixture.baseUrl);
  await page.reload(); await input().waitFor();
  await page.getByRole('button', { name: '选择模型', exact: true }).click(); await page.getByRole('option').filter({ hasText: 'mock' }).click();
  fixture.queue.push({ text: '无需项目也可以对话。' }); await send('初始自由对话');
  const first = await poll(async () => (await state()).sessions[0], 'first projectless session'); await settled(first.id);
  assert.equal((await chat(first.id)).projectId, null); assert.equal((await state()).projects.length, 0);
  assert.equal(await app.evaluate(() => globalThis.__pickerCount), 0);
  assert.equal(fixture.requests[0].body.tools?.length || 0, 0);
  assert.deepEqual(await page.evaluate(id => window.localcode.changes(id), first.id), []);
  fixture.queue.push({ text: '我记得上一轮说过无需项目也可以对话。' }); await send('继续刚才的讨论'); await settled(first.id);
  assert.equal((await state()).sessions.length, 1); assert.equal(fixture.requests.length, 2);
  assert(JSON.stringify(fixture.requests[1].body.messages).includes('无需项目也可以对话'));
  checks.push('fresh install sends and continues a persistent projectless task, without a folder picker, workspace tools or file snapshot');
  await page.screenshot({ path: path.join(root, '01-projectless-chat.png') });

  await taskMenu(first.id); await page.getByRole('menuitem', { name: '移入项目', exact: true }).click();
  await page.getByRole('button', { name: '取消移动', exact: true }).click(); assert.equal((await chat(first.id)).projectId, null);
  const historyBeforeMove = (await chat(first.id)).messages;
  await taskMenu(first.id); await page.getByRole('menuitem', { name: '移入项目', exact: true }).click();
  await page.getByRole('button', { name: '新建项目并移入', exact: true }).click();
  const a = await poll(async () => { const s = await chat(first.id); return s.projectId && (await state()).projects.find(p => p.id === s.projectId); }, 'same task moved to new project');
  assert.equal(a.path, projectA); assert.deepEqual((await chat(first.id)).messages, historyBeforeMove);
  assert.equal((await state()).sessions.length, 1);
  await page.getByRole('dialog', { name: '移入项目', exact: true }).waitFor({ state: 'hidden' });
  fixture.queue.push({ tool: { name: 'write_file', args: { path: 'moved.txt', content: 'Same task, selected project only.\n' } } }, { text: '已在项目中创建 `moved.txt`。' });
  await send('把刚才讨论的内容写入文件'); const moved = await settled(first.id);
  assert.equal(await fs.readFile(path.join(projectA, 'moved.txt'), 'utf8'), 'Same task, selected project only.\n');
  assert.deepEqual(await fs.readdir(projectB), []); assert.equal(moved.id, first.id);
  assert(fixture.requests[2].body.tools.some(t => t.function.name === 'write_file'));
  assert(JSON.stringify(fixture.requests[2].body.messages).includes('无需项目也可以对话'));
  assert(moved.piFile); assert.equal(moved.runs.length, 3); assert.equal(moved.runs[0].changes.length, 0); assert.equal(moved.runs[2].changes.length, 1);
  checks.push('cancel is safe; moving into a newly added project preserves task identity, transcript and context, and enables project-scoped tools for the next round');

  await app.evaluate(({ dialog }) => {
    globalThis.__folder = globalThis.__folder.replace('项目甲', '项目乙');
    globalThis.__pickerEntered = false;
    const gate = new Promise(resolve => { globalThis.__releasePicker = resolve; });
    dialog.showOpenDialog = async () => { globalThis.__pickerEntered = true; await gate; return { canceled: false, filePaths: [globalThis.__folder] }; };
  });
  await page.getByRole('button', { name: '打开项目文件夹', exact: true }).first().click();
  await poll(() => app.evaluate(() => globalThis.__pickerEntered), 'delayed project picker entered');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await app.evaluate(() => globalThis.__releasePicker());
  const b = await poll(async () => (await state()).projects.find(p => p.path === projectB), 'second project');
  await page.locator(`.project-group[data-project-id="${b.id}"]`).waitFor();
  assert.equal((await state()).sessions.length, 1); assert.match(await page.getByRole('button', { name: '选择工作项目', exact: true }).innerText(), /不在项目中工作/);
  await input().fill('尚未发送的任务草稿');
  await page.getByRole('button', { name: '选择工作项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill('项目甲'); await page.getByRole('option', { name: '项目甲', exact: true }).click();
  assert.equal(await input().inputValue(), '尚未发送的任务草稿');
  assert.equal((await state()).sessions.length, 1);
  await page.getByRole('button', { name: '选择工作项目', exact: true }).click(); await page.getByRole('option', { name: '不在项目中工作', exact: true }).click();
  assert.equal(await input().inputValue(), '尚未发送的任务草稿');
  assert.equal((await state()).sessions.length, 1);
  const held = new Promise(resolve => { release = resolve; }); fixture.queue.push({ gate: held, text: '独立任务完成。' });
  await send('第二个独立任务');
  const second = await poll(async () => (await state()).sessions.find(s => s.title === '第二个独立任务'), 'second projectless task');
  await poll(() => fixture.requests.length === 5, 'projectless request reached fixture');
  assert.equal(fixture.requests[4].body.tools?.length || 0, 0);
  const rejectedMove = await page.evaluate(async ({ sessionId, projectId }) => { try { await window.localcode.moveSession({ sessionId, projectId }); return false; } catch { return true; } }, { sessionId: second.id, projectId: b.id });
  assert(rejectedMove); assert.equal((await chat(second.id)).projectId, null);
  await page.getByRole('button', { name: '返回首页', exact: true }).click(); assert.equal((await state()).sessions.length, 2);
  release(); await settled(second.id);
  await taskMenu(second.id); await page.getByRole('menuitem', { name: '移入项目', exact: true }).click();
  await page.getByLabel('搜索目标项目').fill('项目乙'); await page.getByRole('dialog', { name: '移入项目', exact: true }).getByRole('button', { name: '项目乙', exact: true }).click();
  await poll(async () => (await chat(second.id)).projectId === b.id, 'task moved into existing project');
  checks.push('a delayed project picker cannot rebind a newer projectless task; searchable workspace picker creates no blank history; running-task moves are rejected and finished tasks can move into an existing project');

  await projectMenu('项目甲'); await page.getByRole('menuitem', { name: '置顶项目', exact: true }).click();
  await poll(async () => (await state()).projects.find(p => p.id === a.id).pinned, 'project pinned');
  await page.getByRole('button', { name: '收起置顶', exact: true }).click();
  await page.getByRole('button', { name: '收起项目 项目乙', exact: true }).click();
  await page.getByRole('button', { name: '收起项目', exact: true }).click();
  await page.getByRole('button', { name: '收起最近', exact: true }).click();
  await poll(async () => { const p = (await state()).settings.sidebar; return p.pinnedCollapsed && p.projectsCollapsed && p.recentCollapsed && p.collapsedProjects.includes(b.id); }, 'collapsed preferences persisted');
  await page.screenshot({ path: path.join(root, '02-collapsed-sections.png') });
  await app.close(); app = undefined; await launch();
  assert.equal(await page.getByRole('button', { name: '展开置顶', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '展开项目', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '展开最近', exact: true }).count(), 1);
  assert.equal((await state()).projects.find(p => p.id === a.id).pinned, true);
  assert.equal((await state()).sessions.length, 2); assert.equal((await chat(first.id)).projectId, a.id); assert.equal((await chat(second.id)).projectId, b.id);
  await page.getByRole('button', { name: '展开置顶', exact: true }).click(); await page.getByRole('button', { name: '展开项目', exact: true }).click(); await page.getByRole('button', { name: '展开最近', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '展开项目 项目乙', exact: true }).count(), 1);
  await page.getByRole('button', { name: '展开项目 项目乙', exact: true }).click();
  await projectMenu('项目甲'); await page.getByRole('menuitem', { name: '取消置顶项目', exact: true }).click();
  await poll(async () => !(await state()).projects.find(p => p.id === a.id).pinned, 'unpin');
  await projectMenu('项目甲'); await page.getByRole('menuitem', { name: '置顶项目', exact: true }).click();
  await poll(async () => (await state()).projects.find(p => p.id === a.id).pinned, 'repin saved');
  await page.screenshot({ path: path.join(root, '03-pinned-projects-and-recent.png') });
  checks.push('pin/unpin, each project, pinned/projects/recent sections and task grouping survive full restart without duplicating or losing conversations');
  await page.evaluate(async () => { await window.localcode.setFontSize(20); await window.localcode.setTheme('dark'); });
  await page.reload(); await input().waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => /\/index\.html$/.test(w.webContents.getURL()))?.setContentSize(960, 760));
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByRole('button', { name: '选择工作项目', exact: true }).click();
  await page.getByLabel('搜索项目', { exact: true }).fill('项目'); await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '不在项目中工作');
  const fits = await page.getByRole('dialog', { name: '选择工作项目', exact: true }).evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && el.scrollWidth <= el.clientWidth + 1; });
  assert(fits, 'Workspace picker must fit the viewport at 20px');
  await page.screenshot({ path: path.join(root, '04-project-picker-dark-20px.png') });
  await page.keyboard.press('Enter'); assert.equal(await page.getByRole('dialog', { name: '选择工作项目', exact: true }).count(), 0);
  assert.equal((await state()).sessions.length, 2);
  checks.push('searchable project picker supports keyboard selection and fits a narrow dark window at 20px without creating a task');
  assert.equal(fixture.queue.length, 0); assert.deepEqual(fixture.errors, []);
} catch (error) { errors.push(error.stack); await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally { release?.(); await app?.close().catch(error => errors.push(error.stack)); await fixture.close(); }
const report = { passed: errors.length === 0, executable: executable ? path.resolve(executable) : 'source', root, checks, errors, modelRequests: fixture.requests.length, paidModelRequests: 0, productionDataUsedForTests: false };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1;
