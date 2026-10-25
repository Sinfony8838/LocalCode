import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';

// Exercise actual navigation and persistence using an isolated desktop profile.
const executable = process.argv[2];
assert(executable, 'Pass the packaged LocalCode.exe to verify');
const expectBug = process.argv.includes('--expect-bug');
const root = path.resolve(`../evidence/home-navigation-${Date.now()}`);
const project = path.join(root, 'project');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(path.join(root, 'data'), { recursive: true });
await fs.writeFile(path.join(root, 'data/pets.json'), JSON.stringify({ version: 1, enabled: false }));
const fixture = await providerFixture('home-fixture-secret-not-real');
const env = { ...process.env, LOCALCODE_HOME: root, LOCALCODE_SKIP_OLLAMA_START: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [];
let app, page, releaseReply;
const indexPath = path.join(root, 'data/index.json');
const disk = async () => JSON.parse(await fs.readFile(indexPath, 'utf8'));
const state = () => page.evaluate(() => window.localcode.bootstrap());
const home = () => page.locator('.activity-rail .rail-button').first();
const input = () => page.getByRole('textbox', { name: '任务输入', exact: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label) {
  const until = Date.now() + 30000;
  while (Date.now() < until) { const result = await fn(); if (result) return result; await pause(80); }
  throw new Error(`Timed out: ${label}`);
}
async function launch() {
  app = await electron.launch({ executablePath: path.resolve(executable), args: [], env, timeout: 60000 });
  page = await poll(() => app.windows().find(p => /\/index\.html$/.test(p.url())), 'main window');
  page.on('pageerror', error => errors.push(error.stack));
  await input().waitFor();
}
async function clickHome(times = 1) {
  for (let i = 0; i < times; i++) await home().click();
  await page.locator('.welcome').waitFor();
}
async function isHome() {
  assert.equal(await home().getAttribute('aria-label'), '返回首页');
  assert.equal(await home().getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('.session-row.active').count(), 0);
  assert.equal(await page.locator('.workspace-heading h1').innerText(), '首页');
}
async function select(title) {
  await page.locator('.session-button').filter({ hasText: title }).click();
  await poll(() => page.locator('.session-row.active').count(), `selected ${title}`);
}
try {
  await launch();
  await app.evaluate(({ dialog }, folder) => {
    globalThis.__homePickerCalls = 0;
    dialog.showOpenDialog = async () => {
      globalThis.__homePickerCalls++;
      return { canceled: false, filePaths: [folder] };
    };
  }, project);
  if (!expectBug) {
    await clickHome(3); await isHome();
    assert.equal(await app.evaluate(() => globalThis.__homePickerCalls), 0);
    assert.equal((await state()).sessions.length, 0);
    checks.push('home without a project neither opens a picker nor creates a session');
  }
  await page.getByRole('button', { name: '打开项目文件夹', exact: true }).first().click();
  await page.locator('.project-item.active').waitFor();
  await poll(async () => !(await input().isDisabled()), 'project ready for input');
  let first;
  if (expectBug) {
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    await poll(async () => (await state()).sessions.length === 1, 'explicit new task'); first = (await state()).sessions[0];
  } else {
    const projectId = (await state()).projects[0].id;
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    assert.equal((await state()).sessions.length, 0, 'New task is a draft until first send');
    first = await page.evaluate(id => window.localcode.createSession(id), projectId);
  }
  await page.evaluate(id => window.localcode.renameSession({ sessionId: id, title: '已有会话' }), first.id);
  await page.reload(); await input().waitFor();
  const before = await fs.readFile(indexPath, 'utf8');
  if (expectBug) {
    await clickHome();
    await poll(async () => (await state()).sessions.length === 2, 'original home creates session');
    assert.equal((await disk()).sessions.length, 2);
    checks.push('original bug reproduced: one home click persists one extra blank session');
    await page.screenshot({ path: path.join(root, 'original-bug.png') });
  } else {
    await input().fill('已有会话的未发送草稿');
    await clickHome(5); await isHome();
    assert.equal((await state()).sessions.length, 1);
    assert.equal(await fs.readFile(indexPath, 'utf8'), before);
    assert.equal(fixture.requests.length, 0);
    assert.equal(await input().inputValue(), '');
    checks.push('five home clicks leave the on-disk history byte-identical with no inference');
    await input().fill('首页未发送草稿');
    await select('已有会话');
    assert.equal(await input().inputValue(), '已有会话的未发送草稿');
    assert.equal(await home().getAttribute('aria-current'), null);
    await clickHome(); await isHome();
    assert.equal(await input().inputValue(), '首页未发送草稿');
    checks.push('existing conversation and home keep separate drafts when navigating');
    // Keyboard activation uses the same navigation without creating history.
    await home().focus(); await page.keyboard.press('Enter'); await isHome();
    assert.equal((await disk()).sessions.length, 1);
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    assert.equal((await state()).sessions.length, 1);
    assert.equal(await page.locator('.session-row.active').count(), 0);
    await clickHome();
    assert.equal((await state()).sessions.length, 1);
    checks.push('keyboard home and explicit new-task draft do not create blank persisted sessions');

    await page.evaluate(url => window.localcode.saveProvider({ id: 'home-fixture', name: '首页导航测试模型', kind: 'openai', baseUrl: url, model: 'mock', contextWindow: 8192, maxTokens: 512, apiKey: 'home-fixture-secret-not-real' }), fixture.baseUrl);
    // Refresh providers, then navigate back home through the actual button.
    await page.reload(); await input().waitFor(); await clickHome();
    await page.getByRole('button', { name: '选择模型' }).click();
    await page.getByRole('option').filter({ hasText: 'mock' }).click();
    const replyGate = new Promise(resolve => { releaseReply = resolve; });
    fixture.queue.push({ gate: replyGate, text: '后台任务已完成，导航不会中断。' });
    await input().fill('从首页发送的后台任务');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await poll(() => fixture.requests.length === 1, 'local fixture request');
    const running = (await state()).sessions.find(s => s.title === '从首页发送的后台任务');
    assert(running); assert.equal(running.providerId, 'home-fixture');
    assert.equal((await disk()).sessions.length, 2);
    await clickHome(3); await isHome();
    assert.equal((await state()).sessions.length, 2);
    assert.equal((await state()).sessions.find(s => s.id === running.id).status, 'running');
    assert.equal(fixture.requests.length, 1);
    await page.locator('.background-task').click();
    assert.equal(await page.locator('.workspace-heading h1').innerText(), running.title);
    await clickHome(); releaseReply();
    await poll(async () => (await state()).sessions.find(s => s.id === running.id)?.status === 'completed', 'background completion');
    await isHome();
    checks.push('sending from home creates exactly one session using the selected model; home does not stop or reopen a background task');
    await select(running.title);
    await page.getByText('后台任务已完成，导航不会中断。', { exact: true }).waitFor();
    await input().fill('继续已有会话的草稿');
    await clickHome();
    await page.getByRole('button', { name: '打开文件面板', exact: true }).click();
    await clickHome(); assert.equal(await page.locator('.inspector').count(), 0);
    await select(running.title); assert.equal(await input().inputValue(), '继续已有会话的草稿');
    await clickHome();
    await page.screenshot({ path: path.join(root, 'fixed-home.png') });
    const persisted = (await disk()).sessions;
    await app.close(); app = undefined;
    await launch();
    assert.deepEqual((await state()).sessions, persisted);
    await clickHome(3); await isHome();
    assert.deepEqual((await disk()).sessions, persisted);
    assert.equal(fixture.requests.length, 1);
    checks.push('history and completed messages survive restart; home still adds no sessions');
  }
} catch (error) { errors.push(error.stack); }
finally {
  releaseReply?.();
  if (page && errors.length) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  await app?.close().catch(error => errors.push(error.stack));
  await fixture.close();
}
errors.push(...fixture.errors);
const result = { passed: errors.length === 0, expectBug, executable: path.resolve(executable), root, checks, errors, fixtureRequests: fixture.requests.length, paidModelRequests: 0, productionDataUsedForTests: false };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
