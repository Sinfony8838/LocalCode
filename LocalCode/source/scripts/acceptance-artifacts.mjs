import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Actual desktop + SDK tools; all inference is a local deterministic fixture.
const root = path.resolve(`../evidence/artifacts-desktop-${Date.now()}`);
const project = path.join(root, 'project');
await fs.mkdir(path.join(project, 'assets'), { recursive: true });
await fs.writeFile(path.join(project, 'notes.txt'), 'Existing user note\n');
await fs.writeFile(path.join(project, 'assets/style.css'), 'body { background: rgb(238, 245, 255); color: rgb(23, 67, 101); font-family: sans-serif; padding: 24px; } button { padding: 12px; }');
await fs.writeFile(path.join(project, 'assets/pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#6b99ce"/></svg>');
const requests = [], queue = [], fixtureErrors = [], externalRequests = [], gates = [];
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/blocked-probe')) { externalRequests.push(req.url); res.writeHead(200); res.end('unexpected network'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(req.headers.authorization, 'Bearer artifacts-fixture-secret-not-real');
    const next = queue.shift(); assert(next, 'Unexpected model request: fixture exhausted');
    if (next.gate) await next.gate;
    if (res.destroyed) return;
    if (next.error) { res.writeHead(next.error, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Intentional fixture failure', code: 'fixture_failure' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const delta = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'artifacts-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    delta({ role: 'assistant' });
    for (const text of (next.text || '').match(/[\s\S]{1,9}/gu) || []) delta({ content: text });
    if (next.tool) delta({ tool_calls: [{ index: 0, id: `fixture_call_${requests.length}`, type: 'function', function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] });
    if (next.streamGate) await next.streamGate;
    if (res.destroyed) return;
    delta({}, next.tool ? 'tool_calls' : 'stop'); res.write('data: [DONE]\n\n'); res.end();
  } catch (error) { fixtureErrors.push(error.stack); if (!res.headersSent) res.writeHead(500); res.end('fixture error'); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(path.join(project, 'assets/app.js'), `
document.body.dataset.script = 'ready';
document.querySelector('#counter').addEventListener('click', () => { document.querySelector('#count').textContent = String(Number(document.querySelector('#count').textContent) + 1); });
fetch('${baseUrl}/blocked-probe').then(() => document.body.dataset.network = 'unexpected').catch(() => document.body.dataset.network = 'blocked');
`);
const html = '<!doctype html>\n<html lang="zh"><head><meta charset="utf-8"><title>初稿</title><link rel="stylesheet" href="assets/style.css"></head><body><h1>内嵌交互网页</h1><p id="stage">初稿</p><img src="assets/pixel.svg" alt="Local fixture image"><button id="counter">点击计数 <span id="count">0</span></button><script>document.body.dataset.inline="ready";</script><script src="assets/app.js"></script></body></html>\n';
const checks = [], errors = [], diagnostics = { launches: [], console: [], requestsFailed: [], previewResponses: [], frameNavigations: [], failureFrames: [] };
const executable = process.argv[2];
const env = { ...process.env, LOCALCODE_HOME: root, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') }; delete env.ELECTRON_RUN_AS_NODE;
let app, page, projectId;
async function poll(fn, label, ms = 60000) { const until = Date.now() + ms; while (Date.now() < until) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error(`Timed out: ${label}`); }
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); gates.push(release); return { promise, release }; }
async function launch() {
  const runtimeSource = executable ? 'packaged argument' : process.env.LOCALCODE_ELECTRON_PATH ? 'LOCALCODE_ELECTRON_PATH' : 'electron package export';
  let runtimePath;
  const args = executable ? [] : [process.cwd()];
  try {
    // Fresh CI checkouts do not run Setup.ps1, so create the requested temp path.
    for (const directory of new Set([env.TEMP, env.TMP])) await fs.mkdir(directory, { recursive: true });
    // Electron 45 downloads its runtime lazily from the package entry point.
    // A hard-coded dist/electron.exe path bypasses that installation step.
    runtimePath = executable || process.env.LOCALCODE_ELECTRON_PATH || require('electron');
    if (typeof runtimePath !== 'string' || !(await fs.stat(runtimePath)).isFile()) throw new Error('Resolved Electron executable is not a file');
    const launchDetails = { runtimeSource, executablePath: runtimePath, args, tempDir: env.TEMP, nodeVersion: process.version, platform: process.platform };
    diagnostics.launches.push(launchDetails); console.log(JSON.stringify({ electronRuntime: launchDetails }));
    app = await electron.launch({ executablePath: runtimePath, args, env, timeout: 60000 });
  } catch (error) {
    throw new Error(`Electron launch failed (${runtimeSource}; executable=${runtimePath || 'unresolved'}; TEMP=${env.TEMP}): ${error.message}`, { cause: error });
  }
  await app.evaluate(({ shell }) => { globalThis.externalOpenCalls = []; shell.openExternal = async url => { globalThis.externalOpenCalls.push(url); }; });
  page = await poll(() => app.windows().find(p => /\/index\.html$/.test(p.url())), 'main window');
  page.on('pageerror', error => errors.push(error.stack));
  page.on('console', message => diagnostics.console.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on('requestfailed', request => diagnostics.requestsFailed.push({ url: request.url(), resourceType: request.resourceType(), failure: request.failure() }));
  page.on('response', response => { if (response.url().startsWith('localcode-preview:')) diagnostics.previewResponses.push({ url: response.url(), status: response.status(), headers: response.headers() }); });
  page.on('framenavigated', frame => diagnostics.frameNavigations.push({ url: frame.url(), name: frame.name() }));
  await page.getByLabel('任务输入').waitFor();
}
const state = id => page.evaluate(id => window.localcode.openSession(id), id);
const terminal = (id, wanted = 'completed') => poll(async () => { const s = await state(id); if (['completed', 'failed', 'interrupted'].includes(s.status)) { assert.equal(s.status, wanted, s.error); return s; } }, `${id}: ${wanted}`);
async function select(id) {
  const s = await state(id);
  const expand = page.getByRole('button', { name: '展开侧边栏', exact: true });
  if (await expand.count()) await expand.click();
  await page.locator('.session-button').filter({ hasText: s.title }).click();
}
async function send(id, prompt) { const result = await page.evaluate(({ id, prompt }) => window.localcode.send({ sessionId: id, providerId: 'artifacts-fixture', prompt }), { id, prompt }); await select(id); return result.runId; }
async function newSession(prompt) { const s = await page.evaluate(id => window.localcode.createSession(id), projectId); await send(s.id, prompt); return s.id; }
const summaries = () => page.locator('.run-summary');
const runCard = id => page.locator(`.run-summary[data-run-id="${id}"]`);

try {
  await launch();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await page.getByRole('button', { name: '打开项目文件夹', exact: true }).first().click();
  projectId = (await page.evaluate(() => window.localcode.bootstrap())).projects[0].id;
  await page.evaluate(url => window.localcode.saveProvider({ id: 'artifacts-fixture', name: 'Artifacts fixture', kind: 'openai', baseUrl: url, model: 'fixture', contextWindow: 16384, maxTokens: 1024, apiKey: 'artifacts-fixture-secret-not-real' }), baseUrl);

  const afterFirst = gate(), finalGate = gate();
  queue.push(
    { text: '阶段性说明：正在创建网页，稍后继续检查。', tool: { name: 'write_file', args: { path: 'demo.html', content: html } } },
    { gate: afterFirst.promise, text: '阶段性说明：现在更新项目记录。', tool: { name: 'edit_file', args: { path: 'notes.txt', oldText: 'Existing user note', newText: 'Existing user note\nFirst completed round' } } },
    { tool: { name: 'edit_file', args: { path: 'demo.html', oldText: '<p id="stage">初稿</p>', newText: '<p id="stage">最终网页</p>' } } },
    { gate: finalGate.promise, text: '已创建可交互网页，并更新项目记录。\n\n- 文件：[打开网页](demo.html)、[项目记录](notes.txt)\n- 参考：[外部参考链接](https://example.com/localcode-reference)\n- 验证：文件写入已完成；实际浏览器效果请通过预览查看。' },
  );
  const id = await newSession('ARTIFACT_COMPLETION_ROUND_ONE');
  const firstRun = (await state(id)).runId;
  await poll(async () => { const s = await state(id); return s.tools.length === 1 && s.tools[0].status === 'completed' && s.messages.some(m => m.role === 'assistant' && !m.partial && m.text.includes('阶段性说明')); }, 'intermediate message ended');
  const intermediateCopy = page.locator('.assistant-message').filter({ hasText: '阶段性说明：正在创建网页' }).getByRole('button', { name: '复制回答', exact: true });
  await intermediateCopy.waitFor({ state: 'visible' });
  assert(await intermediateCopy.count());
  assert.equal(await summaries().count(), 0, 'An ended/copyable intermediate message must not complete a run');
  await page.screenshot({ path: path.join(root, '01-intermediate-no-summary.png') });
  afterFirst.release();
  await poll(async () => (await state(id)).tools.filter(t => t.status === 'completed').length === 3, 'all writes before final');
  assert.equal(await summaries().count(), 0, 'Completed tools must not create completion summaries before final settled');
  finalGate.release(); await terminal(id);
  await runCard(firstRun).waitFor(); assert.equal(await summaries().count(), 1);
  assert.equal(await runCard(firstRun).getAttribute('aria-label'), '本轮运行记录');
  assert(!(await runCard(firstRun).innerText()).includes('不代表测试或任务验收通过'));
  assert.match(await runCard(firstRun).innerText(), /2\s*个文件/);
  assert.match(await runCard(firstRun).innerText(), /demo\.html/); assert.match(await runCard(firstRun).innerText(), /notes\.txt/);
  checks.push('Copyable intermediate messages and completed tools produce no summary; one settled run creates one summary and deduplicates three writes into two files');
  await page.screenshot({ path: path.join(root, '02-completed-two-files.png') });
  await page.getByRole('link', { name: '外部参考链接', exact: true }).click();
  await poll(async () => (await app.evaluate(() => globalThis.externalOpenCalls)).length === 1, 'main-frame Markdown external link dispatched');
  assert.deepEqual(await app.evaluate(() => globalThis.externalOpenCalls), ['https://example.com/localcode-reference']);
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'data:text/html,hello', 'ms-settings:privacy']) {
    assert(await page.evaluate(async url => { try { await window.localcode.openExternal(url); return false; } catch { return true; } }, url), `Unsafe external URL accepted: ${url}`);
  }
  assert.deepEqual(await app.evaluate(() => globalThis.externalOpenCalls), ['https://example.com/localcode-reference']);
  checks.push('Main-frame Markdown HTTP link dispatches to the system browser; native launch intercepted');

  // UI/API assertions below are kept strict; a missing path must fail, not skip.
  await page.getByRole('link', { name: '打开网页', exact: true }).click();
  const preview = page.locator('iframe[title="文件预览"]'); await preview.waitFor();
  const frame = await poll(async () => (await preview.elementHandle())?.contentFrame(), 'preview frame');
  await frame.waitForSelector('body[data-script="ready"][data-inline="ready"]');
  await poll(() => frame.evaluate(() => document.querySelector('img').naturalWidth === 40 && getComputedStyle(document.body).backgroundColor === 'rgb(238, 245, 255)'), 'relative image and stylesheet loaded');
  const sandbox = await preview.getAttribute('sandbox'); assert(sandbox?.split(/\s+/).includes('allow-scripts')); assert(!sandbox.includes('allow-same-origin'));
  const appearance = await frame.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, image: document.querySelector('img').naturalWidth, require: typeof window.require, bridge: typeof window.localcode, parentBridge: (() => { try { return typeof parent.localcode; } catch { return 'blocked'; } })() }));
  assert.deepEqual(appearance, { background: 'rgb(238, 245, 255)', image: 40, require: 'undefined', bridge: 'undefined', parentBridge: 'blocked' });
  await frame.locator('#counter').click(); assert.equal(await frame.locator('#count').innerText(), '1');
  await poll(async () => (await frame.locator('body').getAttribute('data-network')) === 'blocked', 'preview external network blocked');
  assert.deepEqual(externalRequests, []);
  const topBefore = page.url();
  await frame.evaluate(url => { try { top.location.href = `${url}/blocked-probe-top`; } catch {} window.open(`${url}/blocked-probe-popup`); }, baseUrl);
  await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(page.url(), topBefore); assert.deepEqual(externalRequests, []);
  assert.deepEqual(await app.evaluate(() => globalThis.externalOpenCalls), ['https://example.com/localcode-reference'], 'Preview must not dispatch external browser launches');
  await page.screenshot({ path: path.join(root, '03-embedded-html-interactive.png') });
  checks.push('Generated HTML opens inside agent; relative CSS/script/image and inline script run; interaction works; Node/bridge/parent access, network, popup and top navigation are blocked');

  await page.getByRole('link', { name: '打开网页', exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu'); await menu.waitFor();
  // The container first shows a loading state while artifactInfo resolves.
  // Wait for capability readiness, not arbitrary time or only container presence.
  await menu.getByRole('menuitem', { name: '在应用内预览', exact: true }).waitFor({ state: 'visible' });
  const menuLabels = await menu.getByRole('menuitem').allTextContents();
  assert(menuLabels.some(t => /预览/.test(t))); assert(menuLabels.some(t => /源码/.test(t))); assert(menuLabels.some(t => /默认/.test(t))); assert(menuLabels.some(t => /选择.*应用|打开方式/.test(t))); assert(menuLabels.some(t => /文件夹|资源管理器/.test(t))); assert(menuLabels.some(t => /复制.*路径/.test(t)));
  await page.screenshot({ path: path.join(root, '04-artifact-context-menu.png') });
  await menu.getByRole('menuitem', { name: /源码/ }).click();
  await poll(async () => (await page.locator('.artifact-source').innerText()).includes('<!doctype html>'), 'source view');
  assert((await page.locator('.artifact-source').innerText()).includes('最终网页'));
  await page.getByRole('link', { name: '打开网页', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /复制.*路径/ }).click();
  assert.equal((await app.evaluate(({ clipboard }) => clipboard.readText())).toLowerCase(), path.join(project, 'demo.html').toLowerCase());
  checks.push('File context menu offers preview/source/default app/choose app/reveal/copy; source shows actual file and copy writes validated absolute path');

  await app.evaluate(({ shell }) => {
    globalThis.artifactOpenCalls = [];
    shell.openPath = async target => { globalThis.artifactOpenCalls.push({ action: 'open', target }); return ''; };
    shell.showItemInFolder = target => { globalThis.artifactOpenCalls.push({ action: 'reveal', target }); };
  });
  await page.getByRole('link', { name: '打开网页', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '使用默认应用打开', exact: true }).click();
  await poll(async () => (await app.evaluate(() => globalThis.artifactOpenCalls)).length === 1, 'validated native open dispatch');
  await page.getByRole('link', { name: '打开网页', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '在文件资源管理器中显示', exact: true }).click();
  await poll(async () => (await app.evaluate(() => globalThis.artifactOpenCalls)).length === 2, 'validated reveal dispatch');
  assert.deepEqual(await app.evaluate(() => globalThis.artifactOpenCalls), [
    { action: 'open', target: path.join(project, 'demo.html') },
    { action: 'reveal', target: path.join(project, 'demo.html') },
  ]);
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside project marker');
  await fs.mkdir(path.join(project, '.git'), { recursive: true }); await fs.writeFile(path.join(project, '.git/config'), 'protected marker');
  for (const bad of ['../outside.txt', path.join(root, 'outside.txt'), '.git/config', 'javascript:alert(1)']) {
    const rejected = await page.evaluate(async ({ projectId, path }) => { try { await window.localcode.artifactInfo({ projectId, path }); return false; } catch { return true; } }, { projectId, path: bad });
    assert(rejected, `Unsafe artifact path was accepted: ${bad}`);
  }
  checks.push('Default open and Explorer reveal dispatch validated project paths (native OS launches intercepted); IPC rejects traversal, outside absolute paths, .git and script URLs');

  queue.push(
    { text: '继续更新记录。', tool: { name: 'edit_file', args: { path: 'notes.txt', oldText: 'First completed round', newText: 'Second completed round' } } },
    { text: '第二轮已完成，只更新项目记录。' },
  );
  const secondRun = await send(id, 'ARTIFACT_COMPLETION_ROUND_TWO'); await terminal(id); await runCard(secondRun).waitFor();
  assert.equal(await summaries().count(), 2); assert.match(await runCard(secondRun).innerText(), /1\s*个文件/);
  assert(!(await runCard(secondRun).innerText()).includes('demo.html')); assert.match(await runCard(firstRun).innerText(), /2\s*个文件/);
  checks.push('Second round displays only its own one modified file; first-round two-file summary remains in history');

  // Both names must exist: a fallback-to-existing-path resolver would hide this bug.
  await fs.writeFile(path.join(project, 'report final.html'), '<p id="percent-name">space file</p>');
  await fs.writeFile(path.join(project, 'assets/percent%20style.css'), 'body { color: rgb(1, 2, 3); }');
  await fs.writeFile(path.join(project, 'assets/percent style.css'), 'body { color: rgb(4, 5, 6); }');
  const percentHtml = '<!doctype html><link rel="stylesheet" href="assets/percent%2520style.css"><p id="percent-name">literal percent file</p>';
  queue.push(
    { tool: { name: 'write_file', args: { path: 'report%20final.html', content: percentHtml } } },
    { text: '已写入 `report%20final.html`。\n\n[百分号文件](report%2520final.html) · [空格文件](report%20final.html)\n\n![图片目标链接](report%2520final.html)' },
  );
  const percentId = await newSession('ARTIFACT_LITERAL_PERCENT'); await terminal(percentId);
  const percentRun = (await state(percentId)).runId;
  const percentFrame = page.frameLocator('iframe[title="文件预览"]');
  const assertPercentPreview = async expected => {
    await poll(async () => await percentFrame.locator('#percent-name').innerText() === expected, expected);
    if (expected === 'literal percent file') await poll(async () => await percentFrame.locator('body').evaluate(element => getComputedStyle(element).color) === 'rgb(1, 2, 3)', 'literal percent stylesheet');
  };
  for (const link of [
    runCard(percentRun).getByRole('link', { name: '打开文件 report%20final.html', exact: true }),
    page.locator('.tool-file-action').getByRole('link', { name: '打开文件 report%20final.html', exact: true }),
    page.locator('.markdown-body').getByRole('link', { name: 'report%20final.html', exact: true }),
    page.getByRole('link', { name: '百分号文件', exact: true }),
    page.getByRole('link', { name: '图片目标链接', exact: true }),
  ]) {
    await link.click(); await assertPercentPreview('literal percent file');
  }
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await poll(async () => await page.locator('.artifact-source').innerText() === percentHtml, 'literal percent source');
  await page.getByRole('button', { name: '刷新文件预览', exact: true }).click();
  await poll(async () => await page.locator('.artifact-source').innerText() === percentHtml, 'literal percent refresh');
  await page.getByRole('link', { name: '百分号文件', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制完整路径', exact: true }).click();
  assert.equal((await app.evaluate(({ clipboard }) => clipboard.readText())).toLowerCase(), path.join(project, 'report%20final.html').toLowerCase());
  await page.getByRole('link', { name: '空格文件', exact: true }).click(); await assertPercentPreview('space file');
  await page.getByRole('button', { name: '打开文件面板', exact: true }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '文件', exact: true }).click();
  await page.locator('.file-entry[title="report%20final.html"]').click(); await assertPercentPreview('literal percent file');
  await page.getByRole('button', { name: '关闭文件预览', exact: true }).click();
  await assert.rejects(fs.access(path.join(root, 'data/changes', percentId, 'runs', `${percentRun}.json`)), { code: 'ENOENT' });
  await fs.access(path.join(root, 'data/changes', percentId, 'index.json'));
  checks.push('Coexisting literal-percent and space filenames stay distinct through summaries, tools, inline code, Markdown links/images, source, refresh, menu and file browser; HTML assets decode once; settled snapshot is removed but undo journal retained');

  const interruptedGate = gate(); queue.push({ text: '尚未完成，仍在生成。'.repeat(16), streamGate: interruptedGate.promise });
  const interruptedId = await newSession('ARTIFACT_INTERRUPTED');
  await page.locator('.assistant-message').filter({ hasText: '尚未完成，仍在生成。' }).waitFor(); assert.equal(await summaries().count(), 0);
  await page.getByRole('button', { name: '停止任务', exact: true }).click(); await terminal(interruptedId, 'interrupted');
  await summaries().waitFor(); assert(!(await summaries().innerText()).includes('本轮运行结束')); interruptedGate.release();
  queue.push({ error: 401 }); const failedId = await newSession('ARTIFACT_FAILED'); await terminal(failedId, 'failed');
  await summaries().waitFor(); assert(!(await summaries().innerText()).includes('本轮运行结束'));
  checks.push('User stop and provider failure keep explicit interrupted/failed summaries and never show completed');

  await select(id);
  await page.evaluate(async () => { await window.localcode.setTheme('dark'); await window.localcode.setFontSize(20); });
  await page.reload(); await page.getByLabel('任务输入').waitFor(); await select(id);
  await poll(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'dark theme');
  await page.getByRole('link', { name: '打开网页', exact: true }).click();
  await page.locator('iframe[title="文件预览"]').waitFor();
  await page.frameLocator('iframe[title="文件预览"]').locator('body[data-script="ready"][data-inline="ready"]').waitFor();
  await page.getByRole('link', { name: '打开网页', exact: true }).click({ button: 'right' });
  await page.getByRole('menu').waitFor();
  const menuFits = await page.getByRole('menu').evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1; });
  assert(menuFits, 'Artifact context menu must fit viewport at 20px');
  await page.screenshot({ path: path.join(root, '05-dark-20px-history.png') });
  await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'detached' }); assert.equal(await page.getByRole('menu').count(), 0);
  await app.close(); app = undefined; await launch(); await select(id);
  await poll(async () => await summaries().count() === 2, 'persisted per-run summaries');
  assert.match(await runCard(firstRun).innerText(), /2\s*个文件/); assert.match(await runCard(secondRun).innerText(), /1\s*个文件/);
  assert.equal((await state(interruptedId)).status, 'interrupted'); assert.equal((await state(failedId)).status, 'failed');
  await page.screenshot({ path: path.join(root, '06-restarted-history.png') });
  checks.push('Dark theme and larger font render; application restart preserves both rounds, file counts and distinct failure/stop status');
  assert.equal(queue.length, 0); assert.equal(fixtureErrors.length, 0, fixtureErrors.join('\n'));
} catch (error) {
  errors.push(error.stack);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    diagnostics.failureFrames = await Promise.all(page.frames().map(async frame => ({ url: frame.url(), name: frame.name(), html: await frame.content().catch(error => error.message) })));
  }
}
finally {
  gates.forEach(release => release()); await app?.close().catch(() => {}); server.closeAllConnections(); server.close();
  const result = { passed: errors.length === 0, root, executable: executable || 'source', checks, errors, fixtureErrors, modelRequests: requests.length, paidModelRequests: 0, productionData: 'NOT_USED' };
  await fs.writeFile(path.join(root, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (errors.length) process.exitCode = 1;
}
