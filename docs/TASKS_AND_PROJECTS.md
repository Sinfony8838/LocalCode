# Tasks, projects and conversation controls

LocalCode 0.1.19 separates a conversation from its optional project folder.

- Start a task without choosing a folder. The first send creates its saved history; returning home or clicking New Task does not add empty records.
- Use the project picker above the composer to search existing projects, add a folder or choose to work outside a project. The unsent task draft stays in place when the selection changes. A late folder-picker result cannot override a newer task selection.
- An unassigned, idle task can be moved into an existing or newly added project from its sidebar menu. It keeps its ID, transcript, previous rounds and model context. The next round can use the selected project's tools. Running tasks must settle first. Tasks already bound to a project keep that workspace and its existing change journal.
- Pin or unpin a project from its menu. Pinned projects, projects, recent tasks and each project's child task list can collapse. Preferences survive an application restart. Recent tasks span projects.

A projectless task has no filesystem or command tools, does not scan the application directory as a workspace, and produces no workspace snapshot. The SDK's private transcript directory supplies its required internal cwd only; it is not a user-selected project. Moving the task into a project enables tools for future rounds without rewriting old conversation history.

File names appear as inline links with file icons. Tool rows use a clickable file name in the same row as the operation, while a separate toggle opens tool details. Existing path/reference provenance, preview isolation and external-link validation remain enforced. Only a completed round's final answer has a copy action, after its optional file card. Copy uses a validated write-only main-process API; failures are reported and can be retried. Intermediate, streaming and interrupted output remains selectable without per-message copy buttons.

## Verification

From `LocalCode/source`:

```powershell
npm run typecheck
npm test -- --no-file-parallelism
npm run build
node scripts/acceptance-task-projects.mjs
node scripts/acceptance-typography.mjs
node scripts/acceptance-artifacts.mjs
node scripts/acceptance-checkpoint.mjs
node scripts/acceptance-model-setup.mjs
npm run package
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$exe = "../app/releases/$version/LocalCode-win32-x64/LocalCode.exe"
node scripts/acceptance-task-projects.mjs $exe
node scripts/acceptance-home.mjs $exe
node scripts/acceptance-artifacts.mjs $exe
```

Desktop acceptance uses isolated data and deterministic localhost providers, not private histories or paid model calls. It checks projectless continuation, retained context after moving, actual project file writes, cancellation and busy-move rejection, keyboard/search selection, draft preservation, delayed navigation, persistent pin/collapse state, copy contents, previews and restart behavior. CI requires these checks in addition to the existing onboarding, checkpoint, setup and packaging checks.

This source merge does not declare a formal binary Release ready. The existing release hold and independent acceptance requirements remain in force.

## 中文使用说明

直接输入即可开始不指定工作区的对话。输入框上方可搜索或新建项目，切换时保留未发送的任务草稿。非项目任务结束后，在任务的“…”或右键菜单选择“移入项目”，保留同一对话及上下文继续工作。已有项目任务维持原工作区，避免改绑文件修改与撤销记录。

项目菜单支持置顶、取消置顶；“置顶”“项目”“最近”和单个项目内的任务列表都可收起，重启后保留。文件名直接融入正文和工具行，不再在下方重复显示“查看文件”。每轮最终总结后保留一个复制按钮，中间回复不逐条显示复制按钮。
