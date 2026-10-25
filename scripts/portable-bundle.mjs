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
function portableReadme(version) {
  return `LocalCode ${version} — Windows x64

RELEASE HOLD: the application-data isolation fix passed local regression.
Clean Windows installation and a fresh default Ollama task plus computer reboot
still await acceptance. Previous validation artifacts are not recommended releases.
Passing local checks does not establish release readiness.

OPEN THE PORTABLE DESKTOP
1. Use Windows 11 x64 (Windows 10 22H2 x64 is an untested compatibility target).
   ARM64, 32-bit Windows, macOS and Linux are not supported by these launchers.
2. Extract this ENTIRE folder to a writable local directory, not inside a ZIP.
   If you downloaded an Actions artifact, extract the inner application ZIP too.
3. Double-click Start.cmd. Node.js, npm, Git and Python are NOT needed to launch
   this package. No administrator rights, local model or GPU setup are needed
   for cloud API use. Your coding projects may need their own development tools.
   GitHub's Code > Download ZIP is source, not this runnable package: source
   users must run Setup.cmd first (choose 2 / Desktop only for cloud API use).
4. For an existing Ollama service, select that service and an installed model
   in Model Settings; LocalCode does not start or modify the existing service.
   For a fresh managed local model, close LocalCode and run Install-LocalModel.cmd.
   This needs Windows PowerShell 5.1+, internet and preferably 25 GiB free;
   it explicitly downloads several GB. No model is bundled.

FIRST CLOUD API CONNECTION — NO OLLAMA REQUIRED
1. Open 设置 > 模型设置 > 自定义 API (Settings > Model Settings > Custom API).
2. Enter the provider name, Base URL, API format, API Key and exact model ID
   from your provider. Use its API address, not its website or chat page.
   Do not append /chat/completions, /responses or /messages to Base URL.
   The test appends /chat/completions, /responses or /v1/messages for the
   selected format; avoid duplicating those path segments.
3. Set limits supported by the model: output limit + 1536 < context window.
   Enable both provider and model, then click 保存配置 (Save configuration).
   Saving does not send a model request. LocalCode does not supply API credit.
4. The model's plug icon optionally tests the saved connection with a small
   request; cloud usage may be billed by your provider. A green configuration
   dot does not prove connectivity, nor does a test prove tool-calling support.
5. Close Settings and select the saved provider/model BELOW THE CHAT INPUT.
   Saving does not select it. 云端模式 · 无需 Ollama confirms the cloud choice.
   Prompts, project context and tool results may be sent to that provider.

IF SOMETHING NEEDS ATTENTION
- Executable missing: extract the entire correct app ZIP into a new folder;
  keep the old folder and data. Do not copy only the launcher or EXE.
- Still says Ollama 未连接: select the saved cloud model below the chat input.
- Cloud test disabled: save edits/key, enable provider/model, wait for any test.
- HTTP 401/403: check the key and model/plan permissions. HTTP 404 or response
  format mismatch: check Base URL, API format and model ID. HTTP 429: check
  rate limits/quota and wait before retrying; repeated tests can consume quota.
- Connection fails or exceeds 30 seconds: check provider address/network/status.
- Managed install cannot find PowerShell: use Windows-provided powershell.exe
  version 5.1 or later. No curl.exe? The installer has a PowerShell fallback.
- Port 11434 occupied: explicitly connect your existing Ollama in Settings,
  or exit that service yourself before managed installation. Nothing is killed.
- This app is unsigned. Do not bypass security warnings for an unverified
  download, disable system protection or skip certificate/integrity checks.

KEEP YOUR EXISTING DATA
Close LocalCode and privately back up the complete old folder, including
LocalCode/data. Extract updates into a NEW folder; there is no automatic
history/settings migration between folders. An empty new conversation list
does not mean old data was deleted. Keep the original and backup until a
migration is separately verified; do not blindly overwrite/delete data or
copy individual index/credential files. Stored API keys may need re-entry on
another Windows account/computer. Never upload runtime data, keys or private
conversations in a bug report. Read SECURITY.md before using important files.

中文快速开始
发布暂停：应用数据隔离修复已通过本机回归；此前验证构建不作为推荐发行版。
干净 Windows 安装、全新默认 Ollama 真实任务及电脑重启验收仍未完成。
本机检查通过，不代表已经满足发布条件。

打开桌面
1. 使用 Windows 11 x64；Windows 10 22H2 x64 属于未实测的兼容目标。
   当前启动器不支持 ARM64、32 位 Windows、macOS 或 Linux。
2. 完整解压到可写的本地目录，不要在 ZIP 内运行。Actions 产物需再解压内层应用 ZIP。
3. 双击 Start.cmd，无需安装 Node.js、npm、Git 或 Python，不需要管理员权限。
   仅用云端 API 无需 Ollama、本地模型或显卡环境；具体项目可能有自己的开发环境要求。
   GitHub 的 Code > Download ZIP 是源码，不是便携程序；源码先运行 Setup.cmd，
   云端 API 或已有 Ollama 用户选 2（仅桌面）。
4. 已有 Ollama：在模型设置中选择已有服务和已安装模型，应用不会启动或修改该服务。
   没有本地模型且想使用：关闭应用，再运行 Install-LocalModel.cmd，会下载数 GB。
   需要系统 PowerShell 5.1+、网络，建议 25 GiB 空间；本包不附带模型。

首次云端配置（无需 Ollama）
1. 设置 > 模型设置 > 自定义 API，填写供应商名称、Base URL、API 格式、API Key、模型 ID。
   使用提供方的 API 地址而非官网或聊天页，不要填完整请求路径。
   测试按格式追加 /chat/completions、/responses 或 /v1/messages，请勿重复。
2. 按模型能力填写预算，输出上限加 1536 必须小于上下文；启用供应商和模型后点保存配置。
   保存不发送请求；LocalCode 不附送 API 额度。
3. 保存后可点插头图标测试，可能消耗额度。绿色圆点不代表连通，测试成功不代表工具调用已验证。
4. 关闭设置，在聊天输入框下方选择刚保存的供应商/模型，保存不会自动切换。
   状态应显示“云端模式 · 无需 Ollama”；提示、项目上下文和工具结果可能发送给提供方。

遇到问题
- 找不到程序：新目录完整解压正确应用 ZIP，保留旧目录和数据，不要只复制启动器或 EXE。
- 仍显示 Ollama 未连接：在输入框下方选云端模型。测试按钮不可点：先保存密钥和修改、
  启用供应商及模型，等待当前测试结束。
- HTTP 401/403：检查密钥和模型/套餐权限；404 或格式不匹配：检查地址、格式和模型 ID；
  429：检查限流/额度，等待后重试；超过 30 秒：检查网络、服务地址和状态。
- 安装缺少 PowerShell：使用系统 powershell.exe 5.1+；缺少 curl.exe 会自动改用 PowerShell。
- 11434 被占用：明确连接已有 Ollama，或自行退出已有服务再安装；不会自动终止其他服务。
- 程序未签名；来源未核实时不要绕过安全警告，不要关闭防护或跳过证书/完整性校验。

更新与数据保留
关闭应用后，在私有位置备份完整旧目录，尤其是 LocalCode/data。更新解压到新目录，
不会自动迁移会话和设置；新会话列表为空不代表旧数据已删除。迁移另行验证前保留原目录
及备份，不要盲目覆盖/删除数据或只复制索引/凭据文件。换 Windows 账号或电脑时可能
需要重新输入密钥。运行数据、密钥和私有会话不得上传；使用重要文件前请读 SECURITY.md。
`.replaceAll('\n', '\r\n');
}
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
  await fs.writeFile(path.join(output, 'READ-ME-FIRST.txt'), portableReadme(pkg.version), { flag: 'wx' });
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
