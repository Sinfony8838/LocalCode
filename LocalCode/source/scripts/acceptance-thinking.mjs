import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';

const root = path.resolve(`../evidence/thinking-desktop-${Date.now()}`);
const project = path.join(root, 'project'); await fs.mkdir(project, { recursive: true }); await fs.writeFile(path.join(project, 'sample.txt'), 'fixture-value');
const secret = 'thinking-fixture-secret-never-a-real-key';
const fixture = await providerFixture(secret); const other = await providerFixture(secret);
const env = { ...process.env, LOCALCODE_HOME: root, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], gates = []; let app, page, projectId;
const executable = process.argv[2];
async function poll(fn, label, ms = 45000) { const until = Date.now() + ms; while (Date.now() < until) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 80)); } throw new Error(`Timed out: ${label}`); }
async function launch() {
  app = await electron.launch({ executablePath: executable || path.resolve('node_modules/electron/dist/electron.exe'), args: executable ? [] : [process.cwd()], env, timeout: 60000 });
  page = await poll(() => app.windows().find(p => /\/index\.html$/.test(p.url())), 'main window'); page.on('pageerror', e => errors.push(e.message)); await page.getByLabel('任务输入').waitFor();
}
const state = id => page.evaluate(id => window.localcode.openSession(id), id);
const settled = (id, wanted = 'completed') => poll(async () => { const s = await state(id); if (['completed', 'failed', 'interrupted'].includes(s.status)) { assert.equal(s.status, wanted, s.error); return s; } }, `settled ${id}`);
const gate = () => { let release; const promise = new Promise(r => { release = r; }); gates.push(release); return { promise, release }; };
async function send(kind, title) {
  const s = await page.evaluate(id => window.localcode.createSession(id), projectId);
  await page.evaluate(({ id, kind, title }) => window.localcode.send({ sessionId: id, providerId: `fixture-${kind}`, prompt: title }), { id: s.id, kind, title });
  await page.locator('.session-button').filter({ hasText: title }).click(); return s.id;
}
try {
  await launch(); await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
  await page.getByRole('button', { name: '打开项目文件夹', exact: true }).first().click(); projectId = (await page.evaluate(() => window.localcode.bootstrap())).projects[0].id;
  for (const kind of ['anthropic', 'openai', 'responses']) await page.evaluate(({ kind, url, secret }) => window.localcode.saveProvider({ id: `fixture-${kind}`, name: `Fixture ${kind}`, kind, baseUrl: url, model: 'fixture-model', contextWindow: 8192, maxTokens: 1024, apiKey: secret }), { kind, url: fixture.baseUrl, secret });
  await page.evaluate(({ url, secret }) => window.localcode.saveProvider({ id: 'fixture-other', name: 'Other origin', kind: 'openai', baseUrl: url, model: 'fixture-model', contextWindow: 8192, maxTokens: 1024, apiKey: secret }), { url: other.baseUrl, secret });
  let historyId;
  for (const kind of ['anthropic', 'openai', 'responses']) {
    const hold = gate(); const tail = gate(); const thoughts = `实际返回的思考内容。${secret}。` + Array.from({ length: 70 }, (_, i) => `\n\n步骤 ${i + 1}：分析预置数据。`).join('');
    fixture.queue.push({ thinking: thoughts, thinkingGate: hold.promise, thinkingTail: '\n\n新增的实时思考分片。'.repeat(8), tailGate: tail.promise, text: `${kind} 正文完成。` });
    const id = await send(kind, `THINKING_${kind}`); historyId = id;
    await poll(async () => (await page.locator('.thinking-content').textContent())?.includes('[API 密钥已隐藏]'), 'live thinking redaction');
    assert.equal(await page.locator('.thinking-summary').getAttribute('aria-expanded'), 'true');
    assert(!(await page.locator('.conversation').textContent()).includes(secret));
    await poll(() => page.locator('.thinking-content').evaluate(el => el.scrollHeight > el.clientHeight), 'bounded thinking scroller');
    await new Promise(r => setTimeout(r, 650));
    const durable = JSON.parse(await fs.readFile(path.join(root, 'data/index.json'), 'utf8'));
    assert(durable.sessions.find(s => s.id === id).messages.some(m => m.parts?.some(p => p.type === 'thinking' && p.text.includes('实际返回'))));
    await page.screenshot({ path: path.join(root, `${kind}-live.png`) });
    await poll(() => page.locator('.thinking-content').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 30), 'automatic follow at bottom');
    await page.locator('.thinking-content').evaluate(el => { el.scrollTop = 0; }); await new Promise(r => setTimeout(r, 100));
    hold.release(); await poll(async () => (await page.locator('.thinking-content').textContent()).includes('新增的实时思考分片'), 'new reasoning after scrolling up');
    assert(await page.locator('.thinking-content').evaluate(el => el.scrollTop < 5));
    tail.release(); const complete = await settled(id);
    await poll(async () => await page.locator('.thinking-summary').getAttribute('aria-expanded') === 'false', 'automatic collapse');
    assert(complete.messages.some(m => m.parts?.some(p => p.type === 'thinking' && p.state === 'completed')));
    await page.locator('.thinking-summary').focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('.thinking-summary').getAttribute('aria-expanded'), 'true');
    checks.push(`${kind}: live expanded reasoning, per-channel redaction, 500ms persistence, automatic follow and preserved upward scroll, end collapse, keyboard expansion`);
  }
  fixture.queue.push({ thinking: '先读取文件。', tool: { name: 'read_file', args: { path: 'sample.txt' } } }, { error: 429, headers: { 'retry-after-ms': '1500' } }, { thinking: '已经恢复。', text: '限流后完成。' });
  const recovery = await send('anthropic', 'RETRY_AFTER_TOOL');
  await page.getByRole('status').filter({ hasText: '供应商限流' }).waitFor(); await page.screenshot({ path: path.join(root, '429-countdown.png') });
  const recovered = await settled(recovery); assert.equal(recovered.tools.length, 1); assert.equal(recovered.tools[0].status, 'completed');
  checks.push('429 countdown recovers only failed model HTTP request; completed tool executes once');
  const hold = gate(); fixture.queue.push({ thinking: '等待中的会话 A。'.repeat(20), thinkingGate: hold.promise, text: 'A 完成' });
  const before = fixture.requests.length; const a = await send('anthropic', 'GROUP_A'); await poll(() => fixture.requests.length === before + 1, 'A accepted');
  fixture.queue.push({ text: 'B 完成' }); const b = await send('openai', 'GROUP_B');
  await poll(async () => (await state(b)).progress?.phase === 'queued', 'B queued'); assert.equal(fixture.requests.length, before + 1);
  other.queue.push({ text: '独立组完成' }); const c = await send('other', 'OTHER_GROUP'); await settled(c);
  await page.evaluate(id => window.localcode.stop(id), a); await settled(a, 'interrupted'); await settled(b);
  assert.equal((await state(a)).messages.at(-1).parts[0].state, 'interrupted'); hold.release();
  checks.push('same origin+credential serialized across provider entries; other origin independent; stopping A releases B without cancelling it');
  fixture.queue.push(...Array.from({ length: 3 }, () => ({ error: 429, headers: { 'retry-after-ms': '0' } })));
  const failed = await send('anthropic', 'EXHAUSTED_429'); const failure = await settled(failed, 'failed');
  assert(failure.error.includes('RequestBurstTooFast')); assert(failure.error.includes('fixture-request-id')); assert(!failure.error.includes(secret));
  checks.push('two retries exhausted: localized error retains provider code/request ID and hides credentials');
  await page.evaluate(async () => { await window.localcode.setTheme('dark'); await window.localcode.setFontSize(20); });
  await page.locator('.session-button').filter({ hasText: 'THINKING_responses' }).click(); await page.locator('.thinking-summary').click();
  await page.screenshot({ path: path.join(root, 'dark-20px.png') });
  await app.close(); app = undefined; await launch();
  const restored = await state(historyId); assert(restored.messages.some(m => m.parts?.some(p => p.type === 'thinking' && p.text.includes('实际返回'))));
  await page.locator('.session-button').filter({ hasText: 'THINKING_responses' }).click(); assert.equal(await page.locator('.thinking-summary').getAttribute('aria-expanded'), 'false');
  checks.push('dark theme and 20px rendered; restart restores reasoning history collapsed');
} catch (error) { errors.push(error.stack); if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
finally {
  gates.forEach(release => release()); await app?.close().catch(() => {}); fixture.close(); other.close();
  const result = { passed: errors.length === 0, root, executable: executable || 'source', checks, errors, realProviderRequests: 0, productionData: 'NOT_USED' };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); if (errors.length) process.exitCode = 1;
}
