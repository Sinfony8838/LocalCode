// Real Electron main-process/IPC/filesystem checks; only synthetic records, no model calls.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(`../evidence/isolation-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const project = path.join(root, '中文 project'); const home = path.join(project, 'application');
await fs.mkdir(project, { recursive: true });
const executable = process.argv[2];
const env = { ...process.env, LOCALCODE_HOME: home, LOCALCODE_SKIP_OLLAMA_START: '1', TEMP: path.resolve('../cache'), TMP: path.resolve('../cache') }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [];
let app, page;
const digest = value => createHash('sha256').update(value).digest('hex');
try {
  await fs.mkdir(env.TEMP, { recursive: true });
  app = await electron.launch({ executablePath: executable || process.env.LOCALCODE_ELECTRON_PATH || require('electron'), args: executable ? [] : [process.cwd()], env, timeout: 60000 });
  for (let i = 0; i < 100; i++) { page = app.windows().find(window => /\/index\.html$/.test(window.url())); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(page); page.on('pageerror', error => errors.push(error.message)); await page.getByLabel('任务输入').waitFor();
  async function pick(folder) {
    await app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] }); }, folder);
    return page.evaluate(() => window.localcode.pickProject());
  }
  await assert.rejects(pick(path.join(home, 'data')), /受保护/);
  const selected = await pick(project); assert(selected);
  const session = await page.evaluate(id => window.localcode.createSession(id), selected.id);
  for (const folder of ['data', 'cache', 'logs']) {
    const relative = `application/${folder}/private.txt`; await fs.writeFile(path.join(project, relative), 'PRIVATE_FIXTURE');
    await assert.rejects(page.evaluate(input => window.localcode.readFile(input), { projectId: selected.id, path: relative }), /受保护/);
    await assert.rejects(page.evaluate(input => window.localcode.listFiles(input), { projectId: selected.id, directory: `application/${folder}` }), /受保护/);
    await assert.rejects(page.evaluate(input => window.localcode.artifactInfo(input), { projectId: selected.id, path: relative }), /受保护/);
  }
  const entries = await page.evaluate(input => window.localcode.listFiles(input), { projectId: selected.id, directory: 'application' });
  assert(!entries.some(entry => ['data', 'cache', 'logs'].includes(entry.name)));
  checks.push('project picker, file reads, listings and artifacts share protected data/cache/logs rules');

  const file = path.join(project, 'code.ps1'); await fs.writeFile(file, 'agent');
  const journalFile = path.join(home, 'data/changes', session.id, 'index.json'); await fs.mkdir(path.dirname(journalFile), { recursive: true });
  const record = { path: 'code.ps1', projectPath: project, runId: 'fixture-run', before: Buffer.from('original').toString('base64'), after: Buffer.from('agent').toString('base64'), afterHash: digest('agent'), pending: false };
  const journal = { version: 1, records: [record], runRecords: [record] }; await fs.writeFile(journalFile, JSON.stringify(journal));
  const changes = await page.evaluate(id => window.localcode.changes(id), session.id); assert.equal(changes[0].before, 'original');
  await fs.writeFile(file, 'manual');
  const preview = await page.evaluate(id => window.localcode.previewCheckpoint({ sessionId: id, path: 'code.ps1' }), session.id);
  await page.evaluate(input => window.localcode.checkpoint(input), { sessionId: session.id, path: 'code.ps1', expectedHash: preview.currentHash, expectedRecordHash: preview.recordHash });
  assert.equal(await fs.readFile(file, 'utf8'), 'manual');
  checks.push('normal history and explicit checkpoint still work through the production IPC');

  const forged = structuredClone(journal); forged.records[0].projectPath = path.join(home, 'data'); forged.records[0].path = 'private.txt';
  const bytes = JSON.stringify(forged); await fs.writeFile(journalFile, bytes);
  for (const method of ['changes', 'undo', 'previewCheckpoint', 'checkpoint']) {
    const argument = method === 'changes' ? session.id : { sessionId: session.id, path: 'code.ps1', ...(method === 'checkpoint' ? { expectedHash: preview.currentHash, expectedRecordHash: preview.recordHash } : {}) };
    await assert.rejects(page.evaluate(({ method, argument }) => window.localcode[method](argument), { method, argument }), /不一致/);
    assert.equal(await fs.readFile(journalFile, 'utf8'), bytes);
  }
  assert.equal(await fs.readFile(path.join(home, 'data/private.txt'), 'utf8'), 'PRIVATE_FIXTURE');
  checks.push('forged project roots cannot redirect changes, undo or checkpoint; original journal and protected file retained');
  await fs.writeFile(journalFile, JSON.stringify(journal)); await fs.writeFile(file, 'agent');
  await page.evaluate(input => window.localcode.undo(input), { sessionId: session.id, path: 'code.ps1' }); assert.equal(await fs.readFile(file, 'utf8'), 'original');
  await app.evaluate(({ shell }) => { globalThis.__openedData = undefined; shell.openPath = async value => { globalThis.__openedData = value; return ''; }; });
  await page.evaluate(() => window.localcode.openDataFolder());
  assert.equal(await app.evaluate(() => globalThis.__openedData), path.join(home, 'data'));
  checks.push('ordinary undo and explicit settings open-data action remain available');
  assert.deepEqual(errors, []);
} catch (error) { errors.push(error.stack); }
finally {
  await app?.close().catch(() => {});
  const report = { passed: errors.length === 0, root, executable: executable || 'source', checks, errors, modelRequests: 0, productionData: 'NOT_USED' };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (errors.length) process.exitCode = 1;
}
