<p align="center"><img src="LocalCode/source/src/renderer/public/branding/localcode-logo.png" alt="LocalCode" width="120" /></p>

# LocalCode

[English](README.md) | **简体中文**

面向 Windows 的本地编程桌面：Electron + React + TypeScript，每个会话独立运行 Agent，默认用本机 Ollama 推理。可读取和编辑项目、查看修改、审批终端命令、恢复会话；支持简体中文、英文、日文和韩文。可选接入 OpenAI Chat Completions、Responses、Anthropic Messages。

本仓库公开完整应用架构、源码、测试、依赖锁及一键部署脚本。

0.2.0 新增三档审批、图片／文本／只读文件夹附件、问题卡与计划卡，以及外部模型的目标持续执行。目标默认累计有效工作 2 小时，支持暂停、恢复和预算调整；本地模型不支持目标模式。所有外部模型任务取消每轮固定 12 次工具限制，本地保留。界面改为白灰／深灰，并保留四语言、首次模型配置与 checkpoint。详见[使用说明](LocalCode/source/docs/AGENT_MODES.md)和[开源实现来源](LocalCode/source/THIRD_PARTY_NOTICES.md)。0.2.1 另整合了文件工具、预览、撤销及 checkpoint 的应用数据隔离修复。

“设置 → 桌宠”提供预览与自定义宠物库。通过专用 `create-desktop-pet` Skill，可在项目中使用所选聊天模型组织制作流程，并调用独立图片 API 生成、校验和预览图集，再导入为自己的桌宠。公开构建不附带第三方角色素材。详见[自定义桌宠](docs/CUSTOM_PETS.md#中文使用说明)。

任务可直接开始，无需先指定项目文件夹；需要时在输入框上方选择项目，或将已有非项目任务移入项目并保留上下文。项目支持置顶和任务列表折叠，侧栏偏好重启后保留。文件名直接融入正文，每轮最终总结后保留一个复制按钮。详见[任务与项目](docs/TASKS_AND_PROJECTS.md#中文使用说明)。

聊天排版采用系统无衬线字体，默认正文 14 px、行高 24 px、段间距 12 px；可在“设置 → 外观”调整字号。停止状态和用时合并为一行，成功运行的用时显示在最终回复前；文件卡片先显示三个文件，其余可展开。固定统计范围说明不再占用聊天空间，实际统计异常仍会显示。

> **Windows 下载：** [LocalCode 0.2.1 — Windows x64 便携包](https://github.com/Sinfony8838/LocalCode/releases/tag/v0.2.1)。校验 `SHA256SUMS.txt` 后完整解压，双击 `Start.cmd`。更新前备份旧目录，并将新版解压到新目录，详见下文。

## 界面与回复语言

在 **设置 → 语言** 选择 **简体中文 / English / 日本語 / 한국어**。界面立即切换，设置自动保存并在重启后保留。已有会话从下一轮开始使用新的默认回复语言，正在进行的轮次保留启动时的语言。用户明确指定的回复或翻译语言优先：例如用中文提问但要求英文回答时，应使用英文。用户消息、模型历史回答、代码、文件路径和工具原始输出保留原文。

本次通过本机模拟模型接口捕获请求验证语言规则，尚未评估真实模型的语言遵循效果。

## 快速开始：先选适合的下载方式

推荐 **Windows 11 x64**；Windows 10 22H2 x64 属于上游兼容目标，本项目未实测。请把**完整文件夹解压**到自己可写的本地目录，例如 `D:\LocalCode`，不要在 ZIP 内、系统保护目录或网络共享目录运行。**无需手动安装 Node.js、npm 或 Git，也不需要管理员权限。**

| 下载的是什么 | 怎么辨认 | 第一步 |
| --- | --- | --- |
| GitHub **Code → Download ZIP** 或自动生成的 **Source code** 源码压缩包 | 有 `LocalCode/source/package.json`，没有已打包桌面 | 运行 `Setup.cmd`；使用云端 API 或已有 Ollama 时选 **2 — 仅桌面** |
| GitHub Release 的 **Windows x64 便携包** | `LocalCode-0.2.1-windows-x64.zip` 内有 `READ-ME-FIRST.txt` 和 `LocalCode/app/current.txt` | 完整解压，再运行 `Start.cmd`；Actions 产物需额外解压外层 ZIP |

如果该次工作流没有成功且未过期的产物，就没有对应的便携下载。修改源码 ZIP 的名字或只复制启动器，不能让源码变成可运行程序。

**到底需要哪些环境？**

| 组件 | 便携桌面 / 云端 API | 源码安装或可选用途 |
| --- | --- | --- |
| Node.js / npm | 无需单独安装，Electron 已打包 | `Setup.cmd` 自动下载本目录专用的便携版本 |
| Git | 不需要 | 选择克隆仓库或贡献代码时才需要；下载源码 ZIP 不需要 |
| Python | 不需要 | 维护者的发布扫描或某些项目会使用，不是首次配置的前置条件 |
| Ollama / 本地模型 / 显卡环境 | 仅用云端 API 不需要 | 仅本地推理需要；可连接已有 Ollama，或明确安装本套托管模型 |
| Windows PowerShell 5.1+ | 审批后的 PowerShell 命令及托管服务操作需要 | 安装脚本需要；请使用 Windows 自带的 `powershell.exe` |

打开 LocalCode 不会替项目安装语言运行时或构建工具。Python、Node.js 等项目可能仍有自己的环境要求，这与桌面本身无需全局安装这些工具不同。

### 便携桌面版：解压即开

在 [GitHub Release](https://github.com/Sinfony8838/LocalCode/releases/tag/v0.2.1) 下载 **`LocalCode-0.2.1-windows-x64.zip`** 与 **`SHA256SUMS.txt`**，公开发行附件无需登录 GitHub。用 `Get-FileHash -Algorithm SHA256` 核对 ZIP 的校验值，完整解压应用目录后双击 `Start.cmd`。自动生成的 Source code ZIP 是源码，需要构建；Actions 仍是临时验证产物，下载需登录，且需再解压内层应用 ZIP。

1. 双击解压后的 **`Start.cmd`** 即可打开桌面，不需要编译工具，也不会自动下载模型。
2. 在设置中选择连接方式：
   - **已经安装 Ollama？** 明确选择连接已有本地服务，并选一个它已经安装的模型。LocalCode 不会替换、安装或停止这个服务。
   - **使用自己的 API？** 配置提供方。保存配置不会发起模型请求；手动测试连接或发送任务可能消耗额度。
   - **需要 LocalCode 自带管理的本地模型？** 关闭桌面后，双击 **`Install-LocalModel.cmd`**，下载并校验固定版本 Ollama 0.40.10 与 `qwen3.5:9b-q4_K_M`，创建 8192 tokens 上下文的 `localcode-agent`。这一步**不下载 Node.js，也不重新构建桌面**。预计下载数 GB，建议预留 **25 GiB**；选择默认 9B 模型前，请先看下方硬件建议。
3. 可直接开始对话，需要读写代码时再选择项目文件夹。非项目对话不提供文件或终端工具；项目中的终端命令需逐条确认。

打开桌面不会悄悄启动或复用 Ollama。重启电脑后，如需本套托管服务，请在设置中明确点击启动，或运行 `Ollama\Start.cmd`。关闭桌面不会关闭已经运行的本套 Ollama，空闲五分钟卸载模型；`Ollama\Stop.cmd` 仅停止路径匹配的本套服务。

**已有安装如何更新：** 先关闭 LocalCode，在私有位置备份完整旧目录，尤其是 `LocalCode/data`，再把新便携 ZIP 解压到**新目录**。新目录使用新的会话和设置，不会自动迁移旧目录；新目录的会话列表为空，不代表旧数据已被删除。迁移另行验证前保留原目录及备份，不要盲目覆盖/删除数据，也不要只复制索引或凭据文件。不要假定已保存的 API 密钥能直接转移到其他 Windows 账号或电脑；需要时在设置中重新输入。不要把旧目录作为问题附件上传，其中可能包含会话和凭据。在同一安装内更换模型或提供方会保留已有会话历史。

### 源码 ZIP：安装脚本自动准备构建环境

下载并完整解压仓库源码 ZIP，或在已使用 Git 时克隆仓库。双击 **`Setup.cmd`**，选择：

| 选项 | 自动准备的内容 | 建议空闲空间 |
| --- | --- | --- |
| **1 — 本地模型 + 桌面** | 便携 Node.js、锁定依赖、检查/构建/打包、托管 Ollama 和默认本地模型 | **25 GiB**，更大模型需要更多 |
| **2 — 仅桌面** | 便携 Node.js、锁定依赖、检查/构建/打包；不下载 Ollama 运行时或模型 | **5 GiB** |
| **3 — 退出** | 不安装 | — |

安装成功后双击 **`Start.cmd`**。脚本会显示当前阶段，成功或失败都会保留窗口；大量下载前先检查 Windows x64、解压文件、目录写入权限、磁盘空间与本套服务端口冲突。空间低于建议值会提示，低于 1 GiB 会停止；缓存状态与模型大小会影响需求，因此检查通过不代表模型一定装得下。安装脚本不购买服务，也不会要求输入 API 密钥。

命令行传入参数会跳过菜单：

```powershell
# 源码版：只构建桌面，不下载本地模型。
.\Setup.cmd -BuildOnly
# 源码版：明确指定模型，完整安装。
.\Setup.cmd -Model qwen3.5:9b-q4_K_M
# 已有便携桌面：只添加托管本地模型。
.\Install-LocalModel.cmd
```

仅查看任一种部署计划，**不下载、不启动服务、不写文件**：

```powershell
.\Setup.cmd -Plan
.\Setup.cmd -BuildOnly -Plan
.\Install-LocalModel.cmd -Plan
```

### 第一次配置云端 API（不需要本地模型）

请准备提供方给出的 API 地址、API 格式、模型 ID 和 API Key。LocalCode 不会代为开户，也不附送 API 额度。

1. 打开 **设置 → 模型设置 → 自定义 API**。只有使用对应服务/套餐时，才选择 **火山 Coding Plan** 预设。
2. 填写 **供应商名称、Base URL、API 格式、API Key、模型 ID**。Base URL 是 API 地址，不是官网或聊天页面；不要粘贴完整的 `/chat/completions`、`/responses` 或 `/messages` 请求地址。连接测试会按 OpenAI 格式追加 `/chat/completions` 或 `/responses`，按 Anthropic 格式追加 `/v1/messages`，不要重复这些路径。
3. 按模型实际支持范围填写上下文及输出上限；**输出上限加 1536 必须小于上下文窗口**。保持供应商和模型启用，再点 **保存配置**；保存不发送模型请求。
4. 可点击模型旁的**插头图标**测试已保存的连接。这会发送少量请求，可能消耗额度。绿色配置圆点不代表已连通；连接测试成功也不代表已验证工具调用能力。
5. 关闭设置，在**聊天输入框下方手动选择刚保存的供应商/模型**。保存供应商不会自动切换当前模型；状态应显示 **云端模式 · 无需 Ollama**，本地 Ollama 缺失不影响使用这个选择。

不要把 API Key 填进 URL、项目文件、截图或问题附件。提供方可能收到提示、项目上下文和工具结果，请只选择你愿意与之共享这些内容的服务。

### 遇到提示时怎么处理

| 提示 / 场景 | 处理办法 |
| --- | --- |
| 缺少 PowerShell / 系统不支持 | 请使用 Windows x64 和系统自带的 Windows PowerShell 5.1 或更新版本。当前启动器不支持 ARM64、32 位 Windows、macOS 或 Linux。 |
| 缺少源码 / 找不到程序 | 请完整解压正确的 ZIP，不要只复制启动器。源码版先运行 `Setup.cmd`；便携桌面版不需要重新构建源码。 |
| 目录无法写入 / 空间不足 | 移动完整目录到自己可写的本地磁盘，或自行释放空间；不应仅为绕过目录权限而使用管理员模式。脚本不会自动删除文件。 |
| 没有 `curl.exe` | 无需额外安装，脚本会改用 PowerShell 自带的 HTTPS 下载功能。 |
| 下载或 npm 安装失败 | 先看失败阶段与域名，检查网络、代理或组织网络限制，按需要允许访问 `nodejs.org`、`registry.npmjs.org`、GitHub 和 Ollama 模型仓库，再用**同一个安装脚本、相同参数**重试。不要关闭证书校验或防火墙。 |
| 校验失败 / 解压目录不完整 | 脚本拒绝使用或覆盖可疑文件。按提示检查具体路径，自行移走该文件或目录后重试；不会跳过完整性校验。 |
| 无法确认端口归属 | 脚本会停止，不会仅凭进程名称就信任服务。请使用带有 NetTCPIP 网络诊断组件的系统 PowerShell；组件缺失时可请管理员恢复，不会自动修改系统。 |
| 11434 端口被占用 | 不会终止或复用其他进程。可保留已有 Ollama，在设置中明确选择连接；若要安装本套模型，请先自行退出已有服务。源码用户可选择“仅桌面”。 |
| 模型下载中断 | 便携版重跑 `Install-LocalModel.cmd`；源码版按原参数重跑 `Setup.cmd`。Ollama 模型下载可续传，运行时压缩包失败后可能重新下载。 |
| 已保存云端模型，仍显示 `Ollama 未连接` | 在输入框下方手动选择已保存的云端供应商/模型；保存不会自动切换。不要为了使用云端 API 而安装 Ollama。 |
| 云端测试按钮不可点击 | 先保存修改、填写并保存 API Key，确认供应商和模型均已启用；等待当前测试或保存结束。 |
| 云端测试显示 HTTP 401 / 403 | 检查密钥，以及该账号/套餐是否有对应模型权限。求助时不要提供密钥。 |
| 云端测试显示 HTTP 404 或响应格式不匹配 | 按提供方 API 文档核对 Base URL、API 格式和准确模型 ID；Base URL 不要包含完整请求路径。 |
| 云端测试显示 HTTP 429 | 检查服务限流和剩余额度，等待后再试；反复测试也可能消耗额度。 |
| 云端连接失败或超过 30 秒 | 检查到所配置提供方的网络连接、Base URL 及服务状态；不要关闭证书校验或系统防护。 |

首次下载需要联网，可能耗时较长；准备好后模型可在本地推理。重跑任一安装脚本前请关闭 LocalCode，遇到问题保留窗口里的错误信息。脚本保护已有数据，不修改全局环境变量、防火墙或 Windows 服务。

## 支持设备与更大模型

**本机参考配置：** Windows 11 x64、Intel Core Ultra 5 125H、约 24 GB 内存（系统报告 23.5 GiB）、RTX 4060 Laptop 8188 MiB 显存、驱动 572.60。历史本地验收使用 Qwen3.5 9B Q4_K_M、8K 上下文，记录为全 GPU 加载。它是参考配置，不是最低性能保证；开源版本的独立验证状态见[发布审查](docs/RELEASE_REVIEW.md)。

| 设备 | 建议 | 证据边界 |
| --- | --- | --- |
| Windows x64、NVIDIA 8 GB 显存、24 GB 内存 | 默认 9B Q4_K_M、8K，关闭占用显存的软件 | 本机参考配置；本次未重新下载模型或复跑推理 |
| 4–6 GB 显存或 16 GB 内存 | 尝试支持工具调用的 2B/4B 模型，先用 4K | 容量建议，未基准测试 |
| 纯 CPU | 更小模型可减少等待，生成明显较慢 | 历史出现过 CPU 回落，无速度承诺 |
| 12–16 GB 显存、32 GB 以上内存 | 可尝试更高精度、上下文或更大的合适模型 | 非实测适配保证 |
| 24 GB 以上显存、48–64 GB 以上内存 | 可评估 27B/32B 级量化模型，先核对真实大小和工具能力 | 未实测 |
| AMD / Intel GPU、Windows ARM64、macOS、Linux | 上游 Ollama 可支持部分设备，本仓库一键脚本仅面向 Windows x64 | 不在本脚本支持范围 |

**配置高于本设备的机器可以部署更大、可能更强的本地模型。** 实际取决于显存、内存、模型量化、KV 缓存、上下文及并行数；大模型不保证每项编码任务更好，应验证工具调用、正确性、耗时和资源余量。MoE 的激活参数量不等于全部权重占用。

首次在**全新源码目录**安装托管模型时，可指定模型和预算，例如：

```powershell
# 小显存示例候选，未经编码验收
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Model qwen3.5:4b -Context 4096 -MaxTokens 512

# 大显存示例候选，请先核实容量
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Model qwen3.5:27b -Context 8192 -MaxTokens 1024
```

本套托管安装创建 `localcode-agent` 别名，指向所选模型；连接已有 Ollama 时则使用你明确选择的已安装模型。首次安装的上下文与输出预算写入 `LocalCode/model-profile.json`，创建应用数据索引时读取。之后可在设置中更换已安装模型、应用上下文预算和输出上限，不会删除已有会话；新的任务轮次使用更新后的设置，正在进行的轮次继续使用启动时的参数。应用里的上下文预算**不会改变 Ollama 实际的 `num_ctx`**，不应高于服务端/模型实际配置的上下文。安装脚本仍拒绝在已有应用数据时，用不兼容的预算覆盖部署配置；若要重新制作不同预算的托管别名，请用新目录，不要覆盖旧数据。安装记录标明推理验收 `UNRUN`，安装成功不等于模型能力验收。

官方依据：[Windows 要求](https://docs.ollama.com/windows)、[硬件支持](https://docs.ollama.com/gpu)、[默认模型](https://ollama.com/library/qwen3.5:9b-q4_K_M)。固定的便携运行时附带 NVIDIA 依赖，AMD/Intel 需另行按上游部署。模型标签可能变化；验证脚本可显示当前模型摘要。

## 整轮总结与文件预览（0.1.13）

- 每轮任务结束后保留独立的耗时和文件修改总结。阶段性回复可以复制，但不会因此显示本轮完成；停止或失败会保留对应状态。同一文件反复修改只计一次，改回本轮开始内容的文件不计入修改。
- 点击生成的文件链接，可在 Agent 内查看 HTML、图片或文本。右键文件链接、工具中的文件入口或修改文件，可选择预览、查看源码、默认应用打开、选择其他 Windows 应用、在资源管理器中显示及复制完整路径。PDF 等文档通过外部应用查看。
- HTML 支持交互脚本及项目内相对路径资源，预览在隔离框架中运行，阻止联网和访问 Agent。文件统计采用有范围上限的项目快照，明确提示统计限制及同时发生的外部修改。

使用方式、统计边界及验证命令见[整轮总结与文件预览说明](docs/TURN_SUMMARIES_AND_PREVIEWS.md)（英文）。

## 架构与开发

React 渲染端通过验证后的 IPC 连接 Electron 主进程；主进程管理会话、Windows 加密凭证、请求排队和审批；每个活跃会话拥有独立 Agent worker，使用固定 pi SDK 1.4.0，调用受范围约束的文件工具、需审批的 PowerShell 和本地 Ollama / 自选 API。

文件工具提供 UTF-8 文本处理、路径及链接检查、修改快照、冲突检测撤销和差异预览。文件工具可以直接编辑项目；终端命令需审批。不同会话共用项目磁盘文件，并发写同一文件不会自动合并。

```powershell
cd LocalCode\source
npm ci
npm run typecheck
npm test -- --no-file-parallelism
npm run build
npm start
npm run package
cd ..\..
# 仓库根目录：离线安装脚本测试，无真实下载或服务启动。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Test-Setup.ps1
```

手动开发使用 Node.js 24 x64；源码安装脚本会自动下载它。锁文件固定精确依赖。打包生成独立版本目录，拒绝覆盖不同构建。直接 `npm start` 默认使用 Electron 用户数据目录；根启动器使用项目内的便携数据目录。目录布局与完整架构图见[英文说明](README.md#architecture)。

桌宠默认关闭，不发布角色美术素材。可自行导入具有合法使用权的 1536×2288 RGBA PNG 图集（8 列×11 行）；两个人物槽位使用中性名称。

## 安全、隐私和许可证

请先阅读 [SECURITY.md](SECURITY.md)。终端以当前 Windows 用户权限执行，并非操作系统沙箱；批准的命令可能访问项目外文件或联网。云端 API 会接收提示、上下文和工具结果；保存配置不会自动请求，手动连接测试或任务可能消耗额度。会话和快照默认不加密，密钥使用 Electron `safeStorage` 的 Windows 加密。即便密钥已加密，也不能提交运行数据目录。

发布修改前，只暂存源码并运行：

```powershell
python scripts\release_scan.py --self-test
python scripts\release_scan.py
```

检查器扫描实际暂存 blob，阻止运行数据及多种密钥格式，但不能保证发现所有秘密。CI 重复检查，维护者仍需进行代码、许可及依赖审查。`data`、`cache`、`logs`、`evidence`、`app`、`models`、`runtime`、`profile`、`downloads`、`temp`、`tools` 等均不发布。

源码采用 [MIT](LICENSE)，依赖和模型遵循各自许可证。运行时与模型从上游下载，不随仓库再分发，详见[第三方说明](THIRD_PARTY_NOTICES.md)。程序未购买 Windows 代码签名证书，系统可能显示信誉提示。

项目 Logo 保存在 `LocalCode/source/src/renderer/public/branding/`，PNG 保留原图，`localcode.ico` 包含 16–256 px 的 Windows 图标。可在 Windows 执行 `powershell -NoProfile -File LocalCode/source/scripts/generate-icons.ps1` 重新生成 ICO。更换素材后，应审查并更新 `scripts/release_scan.py` 中对应文件的精确哈希。
