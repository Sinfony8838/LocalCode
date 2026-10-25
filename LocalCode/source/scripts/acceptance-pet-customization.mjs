import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { syntheticPetAtlas } from './helpers/pet-fixture.mjs';

const root = path.resolve(`../evidence/pet-customization-${Date.now()}`);
const project = path.join(root, 'project');
await fs.mkdir(project, { recursive: true });
const fixtureAtlas = syntheticPetAtlas();
await fs.writeFile(path.join(project, 'pet.png'), fixtureAtlas);
await fs.mkdir(path.join(root, 'data/pets'), { recursive: true });
for (const id of ['paimon', 'ronova']) await fs.writeFile(path.join(root, 'data/pets', `${id}.png`), fixtureAtlas);
await fs.writeFile(path.join(root, 'data/pets.json'), JSON.stringify({ enabled: true, selected: 'paimon', size: 160, alwaysOnTop: false, paused: false, followCursor: true }));
await fs.writeFile(path.join(project, 'pet.json'), JSON.stringify({ name: '云朵测试', description: '导入与重启测试，仅使用合成几何图集', atlas: 'pet.png' }));
const checks = [], errors = [], requests = [];
let app, page, customId;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  const isTool = requests.length === 1;
  const delta = isTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'skill-fixture', type: 'function', function: { name: 'load_skill', arguments: JSON.stringify({ name: 'create-desktop-pet', resource: 'instructions' }) } }] } : { role: 'assistant', content: '已加载桌宠定制 Skill。测试使用本地模拟接口，未生成新图片。' };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [value, finish] of [[delta, null], [{}, isTool ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({ id: 'pet-skill-mock', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const env = { ...process.env, LOCALCODE_HOME: root, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') };
delete env.ELECTRON_RUN_AS_NODE;
async function launch() {
  const packaged = process.argv[2];
  await fs.mkdir(env.TEMP, { recursive: true });
  app = await electron.launch({ executablePath: packaged || path.resolve('node_modules/electron/dist/electron.exe'), args: packaged ? [] : [process.cwd()], env, timeout: 60000 });
  page = await until(async () => app.windows().find(window => /\/index\.html/.test(window.url())), value => !!value, 'main window');
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.localpets && document.querySelector('[aria-label="用户菜单"]'));
}
async function settings() {
  await page.getByRole('button', { name: '用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '桌宠', exact: true }).click();
  await page.getByRole('heading', { name: '桌宠与虚拟宠物' }).waitFor();
}
async function pick(file) { await app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] }); }, file); }
async function until(read, predicate, label) {
  const deadline = Date.now() + 30000; let value;
  do { value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 150)); } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
try {
  await launch();
  const defaultModelName = (await page.evaluate(() => window.localcode.bootstrap())).settings.providers.find(provider => provider.kind === 'ollama').name;
  await page.evaluate(baseUrl => window.localcode.saveProvider({ id: 'pet-skill-mock', name: 'Pet mock', kind: 'openai', model: 'mock', baseUrl, contextWindow: 16000, maxTokens: 2048, apiKey: 'local-pet-fixture' }), `http://127.0.0.1:${server.address().port}/v1`);
  await until(() => page.evaluate(() => window.localcode.bootstrap()), value => value.settings.providers.some(p => p.id === 'pet-skill-mock'), 'provider saved');
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: 'Pet mock · mock', exact: true }).click();
  await page.locator('textarea').first().fill('保留首页草稿');
  await settings();
  await page.getByRole('button', { name: '选择自定义旅伴 A', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, '01-library-light.png') });
  await page.getByRole('button', { name: '不显示虚拟宠物', exact: true }).click();
  await until(() => page.evaluate(() => window.localpets.state()), value => !value.preferences.enabled, 'hidden');
  await page.getByRole('button', { name: '显示桌宠', exact: true }).click();
  await page.getByRole('button', { name: '暂停动画', exact: true }).click();
  await until(() => page.evaluate(() => window.localpets.state()), value => value.preferences.paused, 'paused');
  await page.getByRole('button', { name: '继续动画', exact: true }).click();
  checks.push('preview, none, show/hide and pause controls persist through IPC');
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  await page.getByLabel('桌宠大小', { exact: true }).selectOption('128');
  await page.getByLabel('桌宠目光跟随', { exact: true }).uncheck();
  await page.getByRole('button', { name: '收起桌宠偏好' }).click();
  await page.getByRole('button', { name: '创建虚拟宠物', exact: true }).click();
  await page.getByLabel('宠物名称', { exact: true }).fill('导入测试');
  await pick(path.join(project, 'pet.json'));
  await page.getByRole('button', { name: '导入已有图集', exact: true }).click();
  await page.getByRole('button', { name: '选择云朵测试', exact: true }).waitFor();
  let state = await page.evaluate(() => window.localpets.state());
  customId = state.preferences.selected;
  assert(customId.startsWith('custom-')); assert.equal(state.characters.length, 3);
  const pet = app.windows().find(w => /pet\.html/.test(w.url())); assert(pet);
  await pet.locator(`[data-character="${customId}"]`).waitFor();
  const decoded = await pet.evaluate(async () => {
    const image = new Image(); image.src = getComputedStyle(document.querySelector('.pet-sprite')).backgroundImage.slice(5, -2); await image.decode(); return [image.naturalWidth, image.naturalHeight];
  });
  assert.deepEqual(decoded, [1536, 2288]);
  await assert.rejects(pet.evaluate(() => window.localpets.create({ name: 'blocked' })), /仅主窗口/);
  await assert.rejects(page.evaluate(() => window.localpets.save({ selected: '../escape' })));
  await page.screenshot({ path: path.join(root, '02-custom-library.png') });
  checks.push('manifest imports as a new character, dynamic atlas decodes in floating window, restricted IPC rejects management from pet window');
  await page.getByRole('button', { name: '创建虚拟宠物', exact: true }).click();
  await page.getByLabel('宠物名称', { exact: true }).fill('星星');
  await page.getByLabel('外观与个性', { exact: true }).fill('一只戴蓝围巾的小白猫，轻轻摆尾。');
  await page.screenshot({ path: path.join(root, '03-create.png') });
  await pick(project);
  await page.getByRole('button', { name: '在项目中用模型定制', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('$create-desktop-pet'));
  const draft = await page.locator('textarea').first().inputValue();
  assert(draft.includes('星星')); assert.equal(requests.length, 0);
  let boot = await page.evaluate(() => window.localcode.bootstrap());
  const session = boot.sessions[0]; assert(session.projectId);
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  assert.equal(await page.locator('textarea').first().inputValue(), '保留首页草稿');
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: defaultModelName, exact: true }).click();
  await page.locator(`[data-session-id="${session.id}"]`).first().locator('button').first().click();
  assert.equal(await page.getByRole('button', { name: '选择模型', exact: true }).getAttribute('title'), 'Pet mock · mock');
  assert.equal(await page.locator('textarea').first().inputValue(), draft);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await until(() => page.evaluate(id => window.localcode.openSession(id), session.id), value => value.status === 'completed', 'mock model completion');
  assert.equal(requests.length, 2);
  assert(requests[0].tools.some(t => t.function.name === 'load_skill'));
  assert(requests[0].messages.some(m => typeof m.content === 'string' && m.content.includes('可用内置 Skill')));
  assert(requests[1].messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('pet-assets.mjs')));
  assert(requests[1].messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('ELECTRON_RUN_AS_NODE')));
  checks.push('project creation preserves existing drafts and selected API model across navigation; sending through UI makes real pi SDK load the bundled skill against a local mock model');
  await settings();
  await page.evaluate(() => window.localcode.setTheme('dark'));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(root, '04-library-dark.png') });
  await page.evaluate(() => window.localcode.setFontSize(20));
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
  assert(await page.locator('.settings-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  checks.push('dark theme and large text retain horizontal containment');
  await app.close(); await launch();
  state = await page.evaluate(() => window.localpets.state());
  assert.equal(state.preferences.selected, customId); assert.equal(state.preferences.size, 128); assert(state.characters.find(c => c.id === customId)?.available);
  await page.evaluate(id => window.localpets.remove(id), customId);
  state = await page.evaluate(() => window.localpets.state()); assert(!state.characters.some(c => c.id === customId));
  assert.equal(state.preferences.selected, 'paimon'); await fs.access(path.join(root, 'data/pets', `${customId}.png`));
  await assert.rejects(page.evaluate(() => window.localpets.remove('paimon')), /内置/);
  checks.push('custom library and preference survive restart; removing selected custom pet falls back and preserves its atlas');
  const executable = process.argv[2] || path.resolve('node_modules/electron/dist/electron.exe');
  const skillScript = process.argv[2] ? path.join(path.dirname(executable), 'resources/app/dist/skills/create-desktop-pet/scripts/pet-assets.mjs') : path.resolve('dist/skills/create-desktop-pet/scripts/pet-assets.mjs');
  for (const args of [['status'], ['pack', '--input', 'pet.png', '--out-dir', 'portable-pet', '--name', '便携测试'], ['validate', '--manifest', 'portable-pet/pet.json']]) {
    const run = spawnSync(executable, [skillScript, ...args], { cwd: project, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, run.stderr || String(run.error)); assert(JSON.parse(run.stdout));
  }
  checks.push('bundled Electron runs skill status, pack and validate without a system Node runtime');
  const previewFile = path.join(project, 'portable-pet/preview.html');
  const previewId = await app.evaluate(async ({ BrowserWindow }, file) => {
    const window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadFile(file); return window.id;
  }, previewFile);
  const preview = app.windows().find(w => w.url().endsWith('/portable-pet/preview.html')); assert(preview);
  await preview.emulateMedia({ reducedMotion: 'reduce' }); await preview.reload();
  await preview.getByRole('button', { name: '继续动画', exact: true }).waitFor();
  const offsets = await preview.locator('[data-row]').evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundPositionY));
  assert.deepEqual(offsets, Array.from({ length: 9 }, (_, row) => `${-208 * row}px`));
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.showInactive(), previewId);
  await preview.screenshot({ path: path.join(root, '05-generated-preview-reduced-motion.png'), fullPage: true });
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), previewId);
  checks.push('generated preview shows the correct first frame for all nine actions with reduced motion enabled');
} catch (error) {
  errors.push(error.stack); if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
} finally {
  await app?.close().catch(() => {}); server.closeAllConnections(); server.close();
  const result = { passed: errors.length === 0, root, checks, errors, mockModelRequests: requests.length, paidCalls: 0, packaged: process.argv[2] || false };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  await fs.writeFile('../evidence/pet-customization-latest.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2)); if (errors.length) process.exitCode = 1;
}
