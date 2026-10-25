# 图片 API 与脚本

`scripts/pet-assets.mjs` 使用 Node.js 18+ 内置模块，无需 npm 安装。**优先使用 `load_skill` 返回的运行命令前缀**，它使用随应用附带的运行时，无需用户安装系统 Node。在项目目录运行。脚本不读取 LocalCode 的加密聊天密钥；图片 API 可与聊天供应商不同。支持 OpenAI 兼容的 `POST /images/generations`，不是 Anthropic Messages 或任意聊天接口。

环境变量：

| 变量 | 含义 |
| --- | --- |
| `LOCALCODE_IMAGE_BASE_URL` | 图片服务基础地址，例如 `https://api.openai.com/v1`，不带最终路径 |
| `LOCALCODE_IMAGE_MODEL` | 用户实际有权调用的图片模型 ID，必须显式配置 |
| `LOCALCODE_IMAGE_API_KEY` | 图片 API 密钥，不能写进命令或项目；不输出其值 |

先在运行前缀之后加 `status` 查看配置是否存在。仅返回是否配置，不回显密钥。Windows 用户可在系统环境变量中设置并重启 LocalCode，使其子进程继承。不要运行 `Get-ChildItem Env:` 或读取应用密钥文件来获取密钥。终端中配置过但未让应用继承的变量不会自动出现在任务里。

## 生成

先把完整角色和图集要求写入项目的 `prompt.txt`。以下示例为安装了 Node 的开发环境写法；在应用内，把 `node '<脚本路径>'` **整段替换为 `load_skill` 给出的运行命令前缀**（包含运行程序与脚本路径）。保留前缀里的环境变量设置和 PowerShell 调用符，不把整个前缀当字符串或交给 `Invoke-Expression`。`--out-dir` 为项目内尚不存在的目录：

```powershell
node '<脚本路径>' generate --prompt-file 'prompt.txt' --out-dir 'pets/nebula-candidate' --size '1024x1536'
```

请求为 `model`、`prompt`、`n:1`、`size`、`background:"transparent"`、`output_format:"png"`，最多等待 240 秒，不自动重试。`--size` 应按选定模型支持的尺寸配置，脚本不硬编码模型名。服务若不支持 background/output_format，可显式使用 `--compat` 只发送 model/prompt/n/size，并在 prompt 中保留 PNG 透明背景要求；不能因此保证透明度。

成功响应支持 `data[0].b64_json` 或 `data[0].url`。下载 URL 不发送 API 密钥，不跟随重定向。远端只允许 HTTPS，本机测试允许 localhost HTTP；限制响应与图像大小。请求失败只显示 HTTP 状态和概括原因，不打印供应商原始错误正文。

输出：`candidate.png` 与不含凭证的 `generation.json`。这里只验证图片能解码，不承诺网格布局正确。PNG 候选若因颜色格式或损坏无法解码，会保留原图及 `generation-failure.json`，命令失败且不产生可导入清单。若请求超时，服务器可能已经处理并计费；先向用户说明状态，不立即重发。

## 整理与验证

```powershell
node '<脚本路径>' pack --input 'pets/nebula-candidate/candidate.png' --out-dir 'pets/nebula' --name '星云猫' --description '戴小围巾的银白色猫咪'
node '<脚本路径>' validate --manifest 'pets/nebula/pet.json'
```

`pack` 仅支持非交错 8 位 RGBA PNG，会将已有 8×11 网格缩放到 1536×2288，保留透明度；原始候选不变。它校验 PNG 校验和、完整像素数据、透明背景与 73 个有效格子；空格或没有透明背景会失败。成功输出 `pet.png`、`pet.json`、`validation.json` 与离线 `preview.html`。预览无外网依赖，可在 LocalCode 中打开。

`validate` 对指定清单及相邻图集作相同检查，不写入文件。名字、说明及路径限制也会检查。两种命令均不会检查角色语义、网格中是否错误画了文字、动画是否自然；必须查看预览。

脚本拒绝覆盖输出目录，所有读写路径必须在当前项目目录内（包括符号链接解析后的路径）。可再次生成到新的目录，保留旧版本供比较。若需要编辑已有图片，当前 helper 不实现 images/edits；按实际供应商文档使用其编辑接口或让用户提供已编辑图集，再走 pack。

接口依据：[OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)。其他兼容服务是否支持相同参数、透明背景、尺寸及模型应以该服务实际返回为准。
