import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(`../evidence/model-picker-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await fs.mkdir(path.join(root, 'data'), { recursive: true });
const local = { id: 'local', name: 'Qwen 3.5 · 9B 本地', kind: 'ollama', model: 'localcode-agent:latest', contextWindow: 8192, maxTokens: 1024, baseUrl: 'http://127.0.0.1:11434/v1', hasKey: false };
const ids = ['ark-code-latest', 'deepseek-v4.1-flash-economy', 'kimi-k3.1-pro', ...Array.from({ length: 18 }, (_, i) => `additional-model-${i + 1}`), 'very-long-model-name-with-context-parameters-and-a-complete-identifier-for-layout-check'];
const cloud = { id: 'ark', name: '火山方舟 Coding Plan', kind: 'anthropic', baseUrl: 'http://127.0.0.1:1', model: ids[0], contextWindow: 32768, maxTokens: 4096, hasKey: false, models: ids.map(id => ({ id, contextWindow: 32768, maxTokens: 4096, enabled: true })) };
await fs.writeFile(path.join(root, 'data/index.json'), JSON.stringify({ version: 1, projects: [], sessions: [], settings: { theme: 'light', fontSize: 14, defaultProviderId: 'local', providers: [local, cloud] }, keys: {} }));
const executable = process.argv[2];
const env = { ...process.env, LOCALCODE_HOME: root, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [];
let app, page;
const trigger = () => page.getByRole('button', { name: '选择模型', exact: true });
const list = () => page.getByRole('listbox', { name: '选择模型', exact: true });
const box = () => page.locator('.model-picker-popover');
async function geometry() {
  const p = await box().boundingBox(), t = await trigger().boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(p.y >= 10 && p.x >= 10); assert(p.x + p.width <= viewport.width - 10); assert(p.y + p.height < t.y, 'menu must extend upward from trigger');
  assert(p.y + p.height <= viewport.height); assert(await list().evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'long names must wrap within list');
}
try {
  app = await electron.launch({ executablePath: executable || path.resolve('node_modules/electron/dist/electron.exe'), args: executable ? [] : [process.cwd()], env, timeout: 60000 });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); await trigger().waitFor();
  assert.equal(await page.locator('select[aria-label="选择模型"]').count(), 0);
  await trigger().click(); await list().waitFor(); await geometry();
  assert.equal(await page.getByRole('option', { selected: true }).count(), 1);
  assert.equal(await page.getByRole('option', { selected: true }).innerText(), local.name);
  await page.screenshot({ path: path.join(root, '01-light-upward.png') });
  await page.getByRole('option', { name: `${cloud.name} · ${ids[1]}`, exact: true }).click();
  await list().waitFor({ state: 'detached' }); assert.equal(await trigger().innerText(), ids[1]);
  await trigger().click(); assert.equal(await page.getByRole('option', { selected: true }).getAttribute('aria-label'), `${cloud.name} · ${ids[1]}`);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); assert.equal(await trigger().innerText(), ids[2]);
  assert(await trigger().evaluate(el => el === document.activeElement));
  await page.keyboard.press('ArrowUp'); await list().waitFor(); await page.keyboard.press('Escape'); await list().waitFor({ state: 'detached' });
  assert(await trigger().evaluate(el => el === document.activeElement)); assert.equal(await trigger().innerText(), ids[2]);
  checks.push('upward custom listbox; grouping, single checkmark, mouse selection, keyboard arrows/Enter/Escape and focus return');
  await trigger().click(); await page.keyboard.press('End');
  assert(await page.getByRole('option').last().evaluate(el => el === document.activeElement));
  await geometry(); await page.screenshot({ path: path.join(root, '02-long-model-scroll.png') });
  await page.keyboard.press('Home'); assert(await page.getByRole('option').first().evaluate(el => el === document.activeElement));
  await page.locator('.workspace-header').click(); await list().waitFor({ state: 'detached' });
  await trigger().click(); await page.keyboard.press('Tab'); await list().waitFor({ state: 'detached' });
  checks.push('long lists scroll internally, full long names wrap, Home/End, outside click and Tab dismiss');
  await page.getByRole('button', { name: '应用设置', exact: true }).click(); await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click(); await page.getByLabel('字号', { exact: true }).selectOption('20'); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => /\/index\.html$/.test(w.webContents.getURL())).setSize(1050, 700));
  await trigger().click(); await geometry(); await page.screenshot({ path: path.join(root, '03-dark-compact-font20.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => /\/index\.html$/.test(w.webContents.getURL())).setSize(1150, 740));
  await page.waitForTimeout(200); await geometry();
  checks.push('dark theme and font 20 in 1050x700 window; menu remains above trigger and repositions on resize');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '应用设置', exact: true }).click(); await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('button', { name: '浅色', exact: true }).click(); await page.getByLabel('字号', { exact: true }).selectOption('14'); await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.evaluate(async () => {
    const p = (await window.localcode.bootstrap()).settings.providers.find(p => p.id === 'ark');
    const { hasKey, ...input } = p;
    await window.localcode.saveProvider({ ...input, models: input.models.slice(0, 3) });
  });
  await page.waitForTimeout(150); await trigger().click(); await geometry();
  assert.equal(await page.getByRole('option').count(), 4);
  await page.screenshot({ path: path.join(root, '04-final-reference-style.png') });
  await box().screenshot({ path: path.join(root, '05-menu-closeup.png') });
  checks.push('reference layout: quiet surface, rounded card, provider sections, model names and right-aligned checkmark');
} catch (e) { errors.push(e.stack); if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally {
  await app?.close().catch(() => {});
  const result = { passed: errors.length === 0, root, executable: executable || 'source', checks, errors, paidModelRequests: 0 };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (errors.length) process.exitCode = 1;
}
