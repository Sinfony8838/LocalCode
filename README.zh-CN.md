# LocalCode

[English](README.md) | **简体中文**

面向 Windows 的本地编程桌面：Electron + React + TypeScript，每个会话独立运行 Agent，默认用本机 Ollama 推理。可读取和编辑项目、查看修改、审批终端命令、恢复会话；桌面界面为中文。可选接入 OpenAI Chat Completions、Responses、Anthropic Messages。

本仓库公开完整应用架构、源码、测试、依赖锁及一键部署脚本。**不包含个人 API Key（包括加密形式）、会话、项目快照、日志、浏览器配置、程序发行包或模型权重。**

## 一键复现

1. 准备 Windows 11 x64，至少预留 **25 GB 磁盘空间**。Windows 10 22H2 x64 属于上游兼容目标，本项目未实测。首次安装需要联网。
2. 克隆仓库，或下载源码 ZIP 解压到自己可写的本地目录，避免系统保护目录与网络共享目录。
3. 双击根目录 **`Setup.cmd`**。脚本自动下载并核验固定版本 Node.js 24.14.0、Ollama 0.40.10，安装锁定依赖，执行类型检查、测试、构建与打包，下载 `qwen3.5:9b-q4_K_M`，创建 8192 tokens 上下文的 `localcode-agent` 别名。无需管理员权限或 API Key。
4. 双击根目录 **`Start.cmd`**，打开项目，先试一个小任务。终端命令需逐条确认。

```powershell
git clone https://github.com/Sinfony8838/LocalCode.git
cd LocalCode
.\Setup.cmd
.\Start.cmd
```

首次下载数 GB 文件，耗时取决于网络。模型下载中断可重跑脚本续传。重跑前请关闭 LocalCode。若 11434 端口已有其他 Ollama，部署脚本会停止并说明，不会终止或悄悄复用其他服务，请自行处理端口冲突。关闭桌面端保留 Ollama，空闲五分钟卸载模型；`Ollama\Stop.cmd` 仅停止路径匹配的本套服务。

仅查看部署计划（无下载、无写入）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Plan
```

`-BuildOnly` 只构建桌面，不安装 Ollama、不下载模型，仍会下载 Node.js 和 npm 依赖。

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

在**全新克隆目录**指定模型和预算，例如：

```powershell
# 小显存示例候选，未经编码验收
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Model qwen3.5:4b -Context 4096 -MaxTokens 512

# 大显存示例候选，请先核实容量
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1 -Model qwen3.5:27b -Context 8192 -MaxTokens 1024
```

桌面统一连接 `localcode-agent`，由脚本把别名指向所选模型。上下文与输出预算写入 `LocalCode/model-profile.json`，首次创建数据索引时读取。已有会话继续用保存的预算；变更预算请用全新克隆，脚本拒绝直接修改已有数据的预算。安装记录标明推理验收 `UNRUN`，安装成功不等于模型能力验收。

官方依据：[Windows 要求](https://docs.ollama.com/windows)、[硬件支持](https://docs.ollama.com/gpu)、[默认模型](https://ollama.com/library/qwen3.5:9b-q4_K_M)。固定的便携运行时附带 NVIDIA 依赖，AMD/Intel 需另行按上游部署。模型标签可能变化；验证脚本可显示当前模型摘要。

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
```

使用 Node.js 24 x64，锁文件固定精确依赖。打包生成独立版本目录，拒绝覆盖不同构建。直接 `npm start` 默认使用 Electron 用户数据目录；根启动器使用项目内的便携数据目录。目录布局与完整架构图见[英文说明](README.md#architecture)。

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
