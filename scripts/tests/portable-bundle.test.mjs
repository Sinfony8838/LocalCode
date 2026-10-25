import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
test('symbolic links in support files are refused rather than copied', async t => {
  if (process.platform === 'win32') return t.skip('Windows symlink privilege not assumed; Linux negative control');
  const root = await fixture(t), output = path.join(root, 'output');
  await fs.unlink(path.join(root, 'SECURITY.md'));
  await fs.symlink(path.join(root, 'LocalCode/data/index.json'), path.join(root, 'SECURITY.md'));
  await assert.rejects(bundle(root, output), /Refusing linked/);
});
