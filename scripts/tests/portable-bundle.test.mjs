import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bundle, supportFiles } from '../portable-bundle.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localcode-bundle-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(file, value = 'fixture') { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), value); }
  await write('LocalCode/source/package.json', JSON.stringify({ version: '0.1.14' }));
  for (const name of supportFiles) await write(name);
  for (const name of ['LocalCode.exe', 'resources/app/dist/main.cjs', 'resources/app/dist/renderer/index.html', 'LICENSE', 'LICENSES.chromium.html']) await write('LocalCode/app/releases/0.1.14/LocalCode-win32-x64/' + name);
  for (const name of ['LocalCode/data/index.json', 'LocalCode/source/.env', 'Ollama/models/private.gguf', 'LocalCode/logs/session.json']) await write(name, 'PRIVATE_NEGATIVE_CONTROL');
  return root;
}
test('portable bundle contains runnable app, license and checksum but no runtime data/source/models', async t => {
  const root = await fixture(t), output = path.join(root, 'output');
  const result = await bundle(root, output);
  assert.equal(result.version, '0.1.14');
  // These launcher dependencies are intentionally independent of supportFiles.
  for (const required of ['Start.cmd', 'Install-LocalModel.cmd', 'Setup.cmd', 'Setup.ps1', 'scripts/Setup.Helpers.ps1']) {
    assert((await fs.stat(path.join(output, required))).isFile(), `Missing launcher dependency: ${required}`);
  }
  assert.equal((await fs.readFile(path.join(output, 'LocalCode/app/current.txt'), 'utf8')).trim(), 'releases\\0.1.14\\LocalCode-win32-x64');
  const hashes = await fs.readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8');
  assert.match(hashes, /[a-f0-9]{64}  LocalCode\/app\/releases\/0.1.14\/LocalCode-win32-x64\/LocalCode.exe/);
  assert.doesNotMatch(hashes, /data\/index|\.env|private\.gguf|logs\/session/);
  assert.match(await fs.readFile(path.join(output, 'READ-ME-FIRST.txt'), 'utf8'), /Node.js, npm, Git and Python are NOT needed/);
  await assert.rejects(bundle(root, output), /EEXIST/);
});
test('missing executable refuses bundle before output creation', async t => {
  const root = await fixture(t), output = path.join(root, 'output');
  await fs.unlink(path.join(root, 'LocalCode/app/releases/0.1.14/LocalCode-win32-x64/LocalCode.exe'));
  await assert.rejects(bundle(root, output), /ENOENT/);
  await assert.rejects(fs.access(output), /ENOENT/);
});
test('portable first-run guide covers bilingual cloud setup, prerequisites and data-preserving updates', async t => {
  const root = await fixture(t), output = path.join(root, 'output');
  await bundle(root, output);
  const bytes = await fs.readFile(path.join(output, 'READ-ME-FIRST.txt'));
  const guide = bytes.toString('utf8');
  assert.match(guide, /^LocalCode 0\.1\.14 — Windows x64\r\n/);
  assert.doesNotMatch(guide, /(?<!\r)\n/, 'Windows text guide uses CRLF throughout');
  for (const required of [
    /RELEASE HOLD:[\s\S]*not recommended releases[\s\S]*OPEN THE PORTABLE DESKTOP/,
    /发布暂停：[\s\S]*此前验证构建不作为推荐发行版/,
    /Code > Download ZIP is source, not this runnable package/,
    /Code > Download ZIP 是源码，不是便携程序/,
    /Windows 11 x64[\s\S]*ARM64, 32-bit Windows/,
    /Node\.js, npm, Git and Python are NOT needed/,
    /无需安装 Node\.js、npm、Git 或 Python/,
    /FIRST CLOUD API CONNECTION — NO OLLAMA REQUIRED/,
    /设置 > 模型设置 > 自定义 API/,
    /Base URL, API format, API Key and exact model ID/,
    /output limit \+ 1536 < context window/,
    /Saving does not send a model request/,
    /cloud usage may be billed by your provider/,
    /select the saved provider\/model BELOW THE CHAT INPUT/,
    /在聊天输入框下方选择刚保存的供应商\/模型，保存不会自动切换/,
    /HTTP 401\/403:[\s\S]*HTTP 404[\s\S]*HTTP 429/,
    /extract the entire correct app ZIP into a new folder/,
    /no automatic\r\nhistory\/settings migration/,
    /LocalCode\/data[\s\S]*Keep the original and backup/,
    /新会话列表为空不代表旧数据已删除/,
    /Never upload runtime data, keys or private\r\nconversations/,
    /运行数据、密钥和私有会话不得上传/,
  ]) assert.match(guide, required);
  const hashes = await fs.readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8');
  assert(hashes.split('\n').includes(`${createHash('sha256').update(bytes).digest('hex')}  READ-ME-FIRST.txt`), 'Generated guide is included in the integrity manifest');
});
test('symbolic links in support files are refused rather than copied', async t => {
  if (process.platform === 'win32') return t.skip('Windows symlink privilege not assumed; Linux negative control');
  const root = await fixture(t), output = path.join(root, 'output');
  await fs.unlink(path.join(root, 'SECURITY.md'));
  await fs.symlink(path.join(root, 'LocalCode/data/index.json'), path.join(root, 'SECURITY.md'));
  await assert.rejects(bundle(root, output), /Refusing linked/);
});
