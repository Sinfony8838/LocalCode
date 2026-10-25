// Isolated renderer integration: in-memory bridge, zero model requests.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const root = path.resolve(`../evidence/composer-ui-${Date.now()}`), web = path.join(root, 'web');
await fs.mkdir(web, { recursive: true });
await build({ entryPoints: ['src/renderer/main.tsx'], outfile: path.join(web, 'app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
await fs.writeFile(path.join(web, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
await fs.cp('src/renderer/public/branding', path.join(web, 'branding'), { recursive: true });
const server = http.createServer(async (request, response) => {
  const target = path.resolve(web, '.' + new URL(request.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
  if (!target.startsWith(web + path.sep)) return response.writeHead(403).end();
  try { response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.png') ? 'image/png' : 'text/html'); response.end(await fs.readFile(target)); } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const checks = [], errors = []; let browser, page;
try {
  browser = await chromium.launch({ executablePath: process.env.LOCALCODE_TEST_BROWSER || chromium.executablePath(), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.stack));
  await page.addInitScript(() => {
    const listeners = new Set(), now = () => new Date().toISOString();
    const local = { id: 'local', name: 'Qwen 本地', kind: 'ollama', model: 'qwen', contextWindow: 8192, maxTokens: 1024, baseUrl: 'http://127.0.0.1:1', hasKey: false, supportsImages: false };
    const cloud = { id: 'cloud', name: '测试供应商', kind: 'openai', model: 'vision-model', contextWindow: 32768, maxTokens: 4096, baseUrl: 'http://127.0.0.1:1', hasKey: true, models: [{ id: 'vision-model', enabled: true, contextWindow: 32768, maxTokens: 4096, supportsImages: true }] };
    const state = { version: 'fixture', projects: [], sessions: [], settings: { theme: 'light', fontSize: 14, defaultProviderId: 'cloud', providers: [local, cloud] }, health: { online: true, modelAvailable: true, model: 'qwen', contextWindow: 8192 } };
    const emit = () => listeners.forEach(listener => listener({ type: 'state_changed' })); let count = 0;
    const attachment = (name = '界面参考.png') => { const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f2f5fa'; ctx.fillRect(0, 0, 400, 300); ctx.fillStyle = '#fff'; ctx.fillRect(25, 25, 350, 250); ctx.fillStyle = '#387cf6'; ctx.fillRect(47, 48, 68, 65); ctx.fillStyle = '#253042'; ctx.font = '24px sans-serif'; ctx.fillText('LocalCode', 137, 75); ctx.fillStyle = '#d7dde7'; [0, 1, 2].forEach(i => ctx.fillRect(47, 145 + i * 32, 295 - i * 32, 10)); return { id: `attachment-${++count}`, name, kind: 'image', mimeType: 'image/png', size: 2000, previewUrl: canvas.toDataURL('image/png') }; };
    const session = id => state.sessions.find(item => item.id === id);
    window.__ui = { state, calls: [], emit, failSend: false, setSession(patch) { Object.assign(state.sessions[0], patch, { updatedAt: now() }); emit(); } };
    window.localcode = {
      bootstrap: async () => structuredClone(state), onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      createSession: async projectId => { const item = { id: crypto.randomUUID(), title: '新任务', createdAt: now(), updatedAt: now(), projectId: projectId || null, providerId: 'cloud', modelId: 'vision-model', status: 'idle', messages: [], tools: [], runs: [] }; state.sessions.unshift(item); emit(); return structuredClone(item); },
      openSession: async id => { if (window.__ui.failRead) throw new Error('模拟读取会话失败'); return structuredClone(session(id)); }, changes: async () => [], listFiles: async () => [],
      send: async input => { window.__ui.calls.push({ method: 'send', input }); if (window.__ui.failSend) throw new Error('模拟发送失败'); const item = session(input.sessionId); Object.assign(item, { title: input.prompt || '图片任务', status: 'completed', approvalMode: input.approvalMode, workMode: input.workMode, updatedAt: now() }); item.messages.push({ id: crypto.randomUUID(), role: 'user', text: input.prompt, createdAt: now(), attachments: input.attachmentIds?.map(id => ({ ...attachment('已发送图片.png'), id })) }); emit(); return { runId: 'run-1' }; },
      pickAttachments: async input => { window.__ui.calls.push({ method: 'pickAttachments', input }); return input.folders ? [{ id: `folder-${++count}`, name: '设计资料', kind: 'folder', size: 0 }] : [attachment()]; },
      importAttachments: async input => input.files.map(file => attachment(file.name)),
      answerQuestion: async input => { window.__ui.calls.push({ method: 'answerQuestion', input }); delete session(input.sessionId).question; session(input.sessionId).status = 'completed'; emit(); },
      acceptPlan: async input => { window.__ui.calls.push({ method: 'acceptPlan', input }); session(input.sessionId).plan.status = 'accepted'; session(input.sessionId).workMode = 'execute'; emit(); return { runId: 'run-plan' }; },
      controlGoal: async input => { window.__ui.calls.push({ method: 'controlGoal', input }); const item = session(input.sessionId); if (input.action === 'clear') delete item.goal; else if (input.action === 'budget') item.goal.budgetMs = input.budgetMs; else item.goal.status = input.action === 'pause' ? 'paused' : 'active'; emit(); },
      approve: async input => { window.__ui.calls.push({ method: 'approve', input }); delete state.sessions[0].approval; state.sessions[0].status = 'completed'; emit(); },
      stop: async id => { session(id).status = 'interrupted'; delete session(id).question; delete session(id).approval; emit(); },
      setTheme: async value => { state.settings.theme = value; emit(); }, setFontSize: async value => { state.settings.fontSize = value; emit(); },
      setSidebar: async patch => { state.settings.sidebar = { pinnedCollapsed: false, projectsCollapsed: false, recentCollapsed: false, collapsedProjects: [], ...state.settings.sidebar, ...patch }; return state.settings.sidebar; }, health: async () => state.health, copyText: async () => {}, pickProject: async () => null,
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const input = () => page.getByLabel('任务输入', { exact: true }), add = () => page.getByRole('button', { name: '添加附件或模式', exact: true });
  await input().waitFor();
  await page.getByRole('button', { name: '审批模式', exact: true }).click(); assert.equal(await page.getByRole('menuitemradio', { checked: true }).count(), 1);
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); assert.equal(await page.getByRole('button', { name: '审批模式', exact: true }).innerText(), '完全访问权限');
  await page.getByRole('button', { name: '审批模式', exact: true }).click(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await add().click(); await page.getByRole('menuitemcheckbox', { name: /计划模式/ }).click();
  await add().click(); await page.getByRole('menuitem', { name: /图片和文件/ }).click(); await page.getByRole('button', { name: '预览图片 界面参考.png', exact: true }).waitFor();
  const tile = await page.locator('.attachment-draft-strip .attachment-tile').boundingBox(); assert.equal(tile.width, 144); assert.equal(tile.height, 144);
  await page.getByRole('button', { name: '预览图片 界面参考.png', exact: true }).click(); await page.getByRole('dialog', { name: /图片预览/ }).waitFor(); await page.keyboard.press('Escape');
  await add().click(); await page.getByRole('menuitemcheckbox', { name: /^目标/ }).click(); await page.getByLabel('目标内容', { exact: true }).fill('完成界面与交互，并验证所有改动'); await page.getByRole('button', { name: '添加目标', exact: true }).click();
  await input().fill('参考图片中的布局，先一起确认实现计划。'); await page.screenshot({ path: path.join(root, '01-light-composer.png') });
  await page.getByRole('button', { name: '审批模式', exact: true }).click(); await page.screenshot({ path: path.join(root, '02-approval-menu.png') }); await page.keyboard.press('Escape');
  checks.push('keyboard approval selection; image picker/144px thumbnail/lightbox; plan and goal chips');
  await page.evaluate(() => { window.__ui.failSend = true; }); await page.getByRole('button', { name: '发送任务', exact: true }).click(); await page.getByText('模拟发送失败', { exact: true }).waitFor();
  assert.equal(await input().inputValue(), '参考图片中的布局，先一起确认实现计划。'); assert.equal(await page.locator('.attachment-draft-strip .attachment-tile').count(), 1);
  await page.evaluate(() => { window.__ui.failSend = false; }); await page.getByRole('button', { name: '发送任务', exact: true }).click(); await page.waitForFunction(() => document.querySelector('textarea[aria-label="任务输入"]')?.value === '');
  const sends = await page.evaluate(() => window.__ui.calls.filter(call => call.method === 'send').map(call => call.input)); assert.equal(sends.length, 2); assert.equal(sends[0].sessionId, sends[1].sessionId); assert.equal(sends[0].draftKey, 'new-task'); assert.equal(sends[1].draftKey, 'new-task'); assert.deepEqual(sends[0].attachmentIds, sends[1].attachmentIds); assert.equal(sends[1].goal.budgetMs, 7200000);
  checks.push('failed first send retains the entire draft and original attachment ownership; retry reuses the session');
  await input().fill('确认已经发送'); await page.evaluate(() => { window.__ui.failRead = true; }); await page.getByRole('button', { name: '发送任务', exact: true }).click(); await page.getByText('任务已发送，但暂时未能刷新会话：模拟读取会话失败', { exact: true }).waitFor(); assert.equal(await input().inputValue(), ''); await page.evaluate(() => { window.__ui.failRead = false; }); await page.locator('.error-toast button').click(); checks.push('an accepted send followed by refresh failure does not restore an already-submitted draft');
  await page.evaluate(() => window.__ui.setSession({ status: 'awaiting_input', question: { id: 'question-1', runId: 'run-1', sessionId: window.__ui.state.sessions[0].id, questions: [{ header: '范围', question: '这次实现哪些部分？', multiple: true, options: [{ label: '输入区' }, { label: '消息区' }] }, { header: '细节', question: '还有什么要求？', options: [] }] } }));
  await page.getByLabel('输入区', { exact: true }).check(); await page.getByLabel('消息区', { exact: true }).check(); await page.getByLabel('细节：自定义回答', { exact: true }).fill('保留原有的项目功能'); await page.screenshot({ path: path.join(root, '03-question-card.png') }); await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await page.waitForFunction(() => window.__ui.calls.some(call => call.method === 'answerQuestion')); assert.deepEqual(await page.evaluate(() => window.__ui.calls.find(call => call.method === 'answerQuestion').input.answers), [['输入区', '消息区'], ['保留原有的项目功能']]);
  await page.evaluate(() => window.__ui.setSession({ plan: { id: 'plan-1', runId: 'run-1', status: 'proposed', text: '## 实施计划\n\n1. 添加附件预览。\n2. 验证多会话隔离。\n3. 完成界面验收。' } }));
  await page.getByRole('button', { name: '继续修改', exact: true }).click(); assert(await input().evaluate(element => element === document.activeElement)); await page.screenshot({ path: path.join(root, '04-plan-card.png') }); await page.getByRole('button', { name: '开始实施', exact: true }).click(); await page.getByText('已确认的计划', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '关闭计划模式', exact: true }).count(), 0); checks.push('multi-select and free text questions; plan revise focuses draft and accept exits plan mode');
  await page.evaluate(() => window.__ui.setSession({ plan: undefined, approval: { id: 'approval-1', runId: 'run-1', sessionId: window.__ui.state.sessions[0].id, command: 'Get-Content README.md', cwd: 'D:\\Example', permissionKey: 'exact-command', reason: '此命令尚无本会话授权。' }, status: 'awaiting_approval' }));
  await page.getByText('此命令尚无本会话授权。', { exact: true }).waitFor(); await page.screenshot({ path: path.join(root, '05-approval-card.png') }); await page.getByRole('button', { name: '本会话允许此范围', exact: true }).click();
  await page.evaluate(() => window.__ui.setSession({ goal: { id: 'goal-2', objective: '持续验证功能', status: 'active', budgetMs: 7200000, activeMs: 240000, updatedAt: new Date().toISOString() } }));
  await page.getByRole('button', { name: '暂停目标', exact: true }).click(); await page.getByRole('button', { name: '恢复目标', exact: true }).click(); await page.getByRole('button', { name: '调整预算', exact: true }).click(); await page.getByLabel('调整目标预算', { exact: true }).fill('3'); await page.getByRole('button', { name: '保存', exact: true }).click(); await page.screenshot({ path: path.join(root, '06-goal-card.png') }); await page.getByRole('button', { name: '清除目标', exact: true }).click();
  checks.push('approval reason and exact session scope; goal pause/resume/budget/clear');
  await page.getByRole('button', { name: '返回首页', exact: true }).click(); await page.getByRole('button', { name: '选择模型', exact: true }).click(); await page.getByRole('option', { name: 'Qwen 本地', exact: true }).click(); await add().click(); assert.equal(await page.getByRole('menuitemcheckbox', { name: /^目标/ }).isDisabled(), true); await page.keyboard.press('Escape');
  await add().click(); await page.getByRole('menuitem', { name: /图片和文件/ }).click(); await page.getByText('当前模型尚未启用图片能力。', { exact: false }).waitFor(); assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isDisabled(), true); await page.getByRole('button', { name: '移除附件 界面参考.png', exact: true }).click();
  await page.evaluate(() => { window.__ui.state.settings.theme = 'dark'; window.__ui.state.settings.fontSize = 20; window.__ui.emit(); }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && parseFloat(getComputedStyle(document.documentElement).fontSize) > 22); await page.setViewportSize({ width: 960, height: 760 }); await page.getByRole('button', { name: '审批模式', exact: true }).click();
  const box = await page.getByRole('menu', { name: '审批选项', exact: true }).boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 960 && box.y + box.height <= 760); await page.screenshot({ path: path.join(root, '07-dark-20px.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); checks.push('local goal/image capability gating; dark 20px at 960×760 has no document/menu overflow');
} catch (error) { errors.push(error.stack); await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
const report = { passed: errors.length === 0, root, checks, errors, kind: 'renderer-only fixture', modelRequests: 0, productionDataUsed: false };
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (errors.length) process.exitCode = 1;
