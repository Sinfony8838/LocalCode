# Turn summaries and file previews

Introduced in 0.1.13. The desktop UI uses Chinese labels.

## Finishing a turn

A turn starts when you send a task and ends after its agent work, pending approvals, and command cleanup have settled. A copy button on an intermediate assistant reply, an ended thinking block, or a finished tool call does not end the turn.

The final assistant reply describes the work and actual checks. A separate, collapsible record shows the turn's status, elapsed time, changed files, change kinds, and added/removed line counts. Producing this record does not make another model request. Normal completion shows **本轮已完成**; cancellation and failure show **本轮已停止** and **本轮运行失败**. These states describe how execution ended, not an independent guarantee that the model fulfilled every requirement.

Each turn retains its own record when you continue the conversation or restart the app. Unfinished work recovered after an abnormal exit is marked interrupted. Older conversations without turn records do not gain invented historical summaries.

## Understanding file statistics

Files are compared with their state at the start of that turn. Repeated writes to the same path count once. A change restored to the starting content, including a file created and then removed in the same turn, is a net no-op and is omitted. Later turns do not inherit earlier turns' file counts.

The app combines file-tool records with bounded snapshots of readable project text. These snapshots can observe changes made by approved terminal commands, but cannot prove which process made a change. Simultaneous edits by another conversation, editor, or process may be included.

Automatic scanning is limited to 1,000 candidate files, 300 directories, 16 MiB of readable text in total, and 2 MiB per text file. Dependencies, build outputs, model/runtime directories, protected metadata, `.env` files, links, binary files, and application data are outside automatic text statistics. File-tool records supplement these snapshots. The UI reports incomplete scans, unavailable records, and unknown line counts explicitly; an empty partial result is not presented as proof of zero changes.

The existing **修改** panel still shows the conversation's cumulative file-tool differences and conflict-aware undo. A turn summary is a historical observation; it does not expand undo to terminal edits or overwrite later changes. After an abnormal exit, recovery may have only saved file-tool records, with terminal changes and final disk state unconfirmed.

## Opening generated files

Click a file link in an assistant reply, the file entry associated with a tool, a summary's changed-file link, or a file in the file browser. The file viewer opens beside the conversation. Use **预览** and **源码** to switch view, the refresh button to reread the current file, and the expand button for more space.

Right-click a file entry, press Shift+F10 while its link is focused, or use the viewer's **文件打开方式** button. The menu offers:

| UI action | Behavior |
| --- | --- |
| 在应用内预览 | Render a supported local HTML file or image |
| 查看源码 | Read supported UTF-8 text without executing it |
| 使用默认应用打开 | Ask Windows to open the file in its associated application |
| 选择其他应用打开 | Show the Windows application chooser |
| 在文件资源管理器中显示 | Reveal the file in Explorer |
| 复制完整路径 | Copy its validated absolute path |

Unavailable actions are disabled. File links may be relative to the selected project or absolute paths inside it; links outside that project are rejected. Deleted files remain listed in the summary without an open link. Preview and source views show the current disk file, rather than reconstructing its historical contents.

## Preview support and boundaries

| File type | In-app view |
| --- | --- |
| HTML / HTM | Rendered page, including inline scripts and project-relative CSS, JavaScript, images, fonts, and media |
| PNG, JPEG, GIF, WebP, SVG, BMP, ICO, AVIF | Image preview |
| Supported UTF-8 source and text formats | Read-only source view; large display output is marked truncated |
| PDF, Office documents, and other unsupported formats | External application options; no in-app PDF viewer |

Each preview resource is limited to 32 MiB. Files that cannot be previewed remain available through the applicable external-opening actions. Executable files and scripts do not offer default-app execution; choose an appropriate editor through **选择其他应用打开**.

HTML runs in a frame with an opaque origin and scripts enabled. It receives no Node.js or LocalCode bridge access. The preview blocks network requests, access to the parent app, nested frames, forms, popups, downloads, and top-level navigation. Local assets are served through validated project paths; hidden metadata and unsafe links are excluded. Pages depending on remote CDNs, API calls, or a development server therefore need their usual external browser/server workflow. Opening a file in another application uses that application's behavior and permissions.

## Reproducing validation

On Windows x64 with Node.js 24 and the repository's dependencies installed, run from the repository root:

```powershell
cd LocalCode\source
npm ci
npm run typecheck
npm test -- --no-file-parallelism
npm run build
node scripts\acceptance-artifacts.mjs
```

The desktop acceptance requires Electron, local TCP connections, and child processes. It creates its own application home, project fixtures, screenshots, diagnostics, and `result.json` under the ignored `LocalCode/evidence` directory. Model responses come from a local synthetic HTTP service; the script does not use saved conversations, provider credentials, or real model inference. Default-app and Explorer calls are intercepted during acceptance to verify dispatch without opening unrelated applications.

The checks exercise intermediate replies without completion records, independent turn counts, HTML interaction and isolation, context-menu/source actions, path rejection, interruption/failure, larger fonts, dark appearance, and restart persistence. To test a packaged build, pass its executable as the script's first argument. Review the resulting `passed`, `checks`, and `errors` fields rather than treating a successful build as desktop acceptance.

These are reproduction instructions, not a claim that the latest published commit has passed. Release results and their applicable version are recorded in [the release review](RELEASE_REVIEW.md).
