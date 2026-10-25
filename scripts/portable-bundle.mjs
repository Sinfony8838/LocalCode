import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Deliberately copy an allowlist, never the development directory or user state.
export const supportFiles = [
  'Start.cmd', 'Install-LocalModel.cmd', 'Setup.cmd', 'Setup.ps1', 'scripts/Setup.Helpers.ps1',
  'LocalCode/Start.cmd', 'LocalCode/model-profile.json',
  'Ollama/Environment.ps1', 'Ollama/Start.cmd', 'Ollama/Start.ps1',
  'Ollama/Stop.cmd', 'Ollama/Stop.ps1', 'Ollama/ollama.cmd',
  'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
];
async function copyRegularTree(source, target) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing linked bundle input: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const name of (await fs.readdir(source)).sort()) await copyRegularTree(path.join(source, name), path.join(target, name));
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  } else throw new Error(`Unsupported bundle input: ${source}`);
}
export async function bundle(root, output) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'LocalCode/source/package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid package version');
  const relative = `releases/${pkg.version}/LocalCode-win32-x64`;
  const app = path.join(root, 'LocalCode/app', relative);
  // Never substitute an unbuilt checkout for a runnable application.
  for (const required of ['LocalCode.exe', 'resources/app/dist/main.cjs', 'resources/app/dist/renderer/index.html', 'LICENSE', 'LICENSES.chromium.html']) {
    if (!(await fs.lstat(path.join(app, required))).isFile()) throw new Error(`Missing packaged file: ${required}`);
  }
  await fs.mkdir(output); // Refuse to overwrite even an incomplete previous bundle.
  for (const file of supportFiles) await copyRegularTree(path.join(root, file), path.join(output, file));
  await copyRegularTree(app, path.join(output, 'LocalCode/app', relative));
  await fs.writeFile(path.join(output, 'LocalCode/app/current.txt'), relative.replaceAll('/', '\\') + '\r\n', { flag: 'wx' });
  await fs.writeFile(path.join(output, 'READ-ME-FIRST.txt'), `LocalCode ${pkg.version} — Windows x64\r\n\r\n1. Extract this ENTIRE folder to a writable local directory. Do not run inside the ZIP.\r\n2. Double-click Start.cmd. Node.js, npm, Git and Python are NOT needed to launch this package.\r\n3. In Model Settings, choose an existing local Ollama model or configure your own cloud API. Cloud usage may be billed by your provider; saving settings does not send a model request.\r\n4. For a fresh managed local model, close LocalCode and run Install-LocalModel.cmd. This explicitly downloads several GB and needs Windows PowerShell 5.1, internet and free disk space. No model is bundled.\r\n5. Missing prerequisites are explained by the launcher/installer. Windows x64 is the supported target. This app is unsigned; do not bypass security warnings for an unverified download.\r\n\r\n中文快速开始\r\n完整解压后双击 Start.cmd，无需安装 Node.js、Git 或 Python。\r\n已有 Ollama 或云端 API：在模型设置中按提示配置。\r\n没有本地模型：关闭应用，再双击 Install-LocalModel.cmd（会下载数 GB）。\r\n请保留完整文件夹，不要只复制 exe。运行数据与密钥不得上传。\r\n`, { flag: 'wx' });
  const entries = [];
  async function scan(dir, rel = '') {
    for (const name of (await fs.readdir(dir)).sort()) {
      const child = path.join(dir, name), key = rel ? `${rel}/${name}` : name;
      const stat = await fs.lstat(child);
      if (stat.isDirectory()) await scan(child, key);
      else entries.push(`${createHash('sha256').update(await fs.readFile(child)).digest('hex')}  ${key}`);
    }
  }
  await scan(output);
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), entries.join('\n') + '\n', { flag: 'wx' });
  return { version: pkg.version, files: entries.length, output };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = path.resolve(process.argv[2] || path.join(root, 'portable-output'));
  console.log(JSON.stringify(await bundle(root, output)));
}
