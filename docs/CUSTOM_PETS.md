# Custom desktop pets

Open **Settings → Desktop companion** (or the local user menu). The page contains a large preview, pause/show controls, a character library, and **Create virtual pet**. The public source and portable build do not include third-party character art. The two existing import slots remain available, and the companion stays hidden until you supply an atlas and enable it.

## Create in a project

Enter a name and appearance, then choose **Customize with a model in a project**. Select a folder if there is no active project. This opens an unsent task using the selected chat model. Other drafts remain intact; switching away and back preserves the pet draft and its model. You can also enter `$create-desktop-pet` in a project conversation. The agent loads the bundled skill with `load_skill`; commands keep the existing approval flow.

The chat model designs the character and coordinates the work. Generating pixels requires a separate OpenAI-compatible **Images API**. Set `LOCALCODE_IMAGE_BASE_URL`, `LOCALCODE_IMAGE_MODEL`, and `LOCALCODE_IMAGE_API_KEY` in the environment inherited by LocalCode, then restart the application. Do not put the key in chat, commands, project files, or screenshots. The helper does not read saved chat credentials. See the [API guide](../LocalCode/source/skills/create-desktop-pet/references/api-guide.md) for options and supported responses.

`load_skill` supplies a PowerShell command using the bundled Electron runtime; a system Node installation is unnecessary. The helper provides `status`, `generate`, `pack`, and `validate`. It saves the original candidate, produces a 1536×2288 transparent RGBA atlas, checks the 73 required frames, and creates `pet.json`, `pet.png`, `validation.json`, and an offline preview. Existing output directories are never overwritten, and failed API calls are not automatically retried. The preview covers nine animations, sixteen look directions, pause, and reduced motion.

Format validation cannot determine whether the generated character is consistent, actions are correct, or animation is smooth. Inspect the preview before importing. Providers differ in supported models, sizes, and transparency parameters; mock API tests do not establish real model output quality or pricing.

## Import and manage

Choose **Import existing atlas** in the creation panel. Import a PNG directly, or select a `pet.json` with this structure:

```json
{ "name": "Cloud", "description": "A small companion", "atlas": "pet.png" }
```

The atlas must be a PNG filename in the same directory. Names can contain 1–80 characters and descriptions up to 500. Imports are copied into the application's private `data/pets/` directory; the original remains intact. Custom characters can be selected, replaced, and removed from the visible library. Replacement retains the old image, and removal retains recovery files. Library metadata and preferences survive a restart. A damaged registry is reported without overwriting it.

## Verification

From `LocalCode/source`, run `npm run typecheck`, `npm test -- --no-file-parallelism`, `node --test scripts/test-pet-skill.mjs`, and `npm run build`. On Windows, `node scripts/acceptance-pet-customization.mjs` tests the Electron flow; optionally supply a packaged executable. These tests use generated geometric PNGs and a local mock model endpoint. They do not upload character art, use paid models, or establish formal release readiness. The repository's existing release hold remains in effect.

# 中文使用说明

从**设置 → 桌宠**或左下角用户菜单进入。页面提供大预览、显示/暂停控制、宠物卡片列表和“创建虚拟宠物”。公开源码和便携构建不附带第三方角色素材；保留原有两个导入槽位，导入并启用前默认隐藏桌宠。

填写名字与外观描述后，点击**在项目中用模型定制**；没有项目时先选择文件夹。应用准备一个未发送的新任务，使用当前选定的聊天模型，保留其他草稿；切换任务后仍恢复该草稿和模型。也可在项目对话中输入 `$create-desktop-pet`，Agent 通过 `load_skill` 读取随包 Skill。终端命令仍逐条审批。

聊天模型负责设计与制作流程，实际生图使用单独的图片 API。在应用继承的环境中配置 `LOCALCODE_IMAGE_BASE_URL`、`LOCALCODE_IMAGE_MODEL`、`LOCALCODE_IMAGE_API_KEY`，再重启应用。不要把密钥发到聊天或写进命令、项目文件。脚本不读取聊天供应商的加密密钥；配置与调用参数见 [API 指引](../LocalCode/source/skills/create-desktop-pet/references/api-guide.md)。使用 `load_skill` 返回的随包运行命令，无需另装 Node。

脚本保留候选图，整理为 1536×2288 透明 RGBA 图集，检查 73 个必需格子，并生成九种动作、十六个目光方向的离线预览。输出目录不覆盖，计费请求不自动重试。格式通过不代表角色一致性、动作内容或动画质量通过，仍需查看预览；本机模拟测试不能替代真实图片模型验收。

完成后点击**创建虚拟宠物 → 导入已有图集**，选择 PNG 或同目录的 `pet.json`。清单格式见上文；名称最多 80 字符、介绍最多 500 字符。新角色保存到独立宠物库，可切换、更换图集或移出列表，重启后保留。原图不改动，替换与移除保留恢复文件，损坏的注册表会显示提示。

验收只使用合成几何图集和本机模拟模型。没有调用付费模型，也不表示已解除仓库原有的正式发布暂停状态。
