# Changelog

All notable changes to LocalCode are recorded here, compiled from the Git history and [docs/RELEASE_REVIEW.md](docs/RELEASE_REVIEW.md). Dates are Asia/Shanghai (UTC+8). Only versions that reached `main` are listed; intermediate candidate versions (for example 0.1.15–0.1.18 on the application-data isolation branch) are described in the release review. Only v0.2.1 and later have a GitHub Release.

## 0.2.4 — 2026-10-29

### Changed
- Backend messages that reach the interface (skills, artifacts, commands, approval reasons, desktop pets, attachments and resources, workspace protection, runs/goals/plans, storage and session events) are now translated into English, Japanese and Korean. Approval reasons, goal reasons and notice banners are displayed through the translation layer; the folder-unavailable notice and file-picker titles follow the selected language. Model-facing prompts and tool text stay in Chinese by design. A coverage test fails when a new user-facing Chinese backend string lacks translations.

### Added
- `benchmarks/five-task/`: a repeatable five-task comparison benchmark (prepare / run / score / self-test) with automatic verifiers, a 0–5 manual rubric and Markdown/CSV scoresheets. T1 follows the previously documented task; T2–T5 are new.
- Command-executor regression tests on Windows for Node.js (UTF-8 output, exit codes, closed stdin), Python `stdin.read()`/`input()`, PowerShell `Read-Host` in non-interactive mode, Git (init/commit/log/status and failure exit codes), 20,000 interleaved stdout/stderr lines and the 8 MiB output limit.

## 0.2.3 — 2026-10-28

### Fixed
- Command executor: approved commands that run Python (and other runtimes that close inherited standard handles on exit) no longer hang until the 120-second command timeout after finishing their work. The parent-death watchdog now waits on the agent worker's process handle instead of blocking on a stdin pipe read, and the command's stdin is closed (`NUL`) so child processes never inherit a live pipe. Job-object cleanup and crash-time termination of command trees are unchanged. A Python regression test was added (skipped when Python is unavailable). See the [incident review](LocalCode/source/docs/incident-2026-10-28-python-command-deadlock.md).

### Documentation
- README (English and Simplified Chinese) updated for 0.2.2–0.2.3, approval modes and tool-call limits; this changelog added.

## 0.2.2 — 2026-10-28

### Added
- Archive and delete tasks from the sidebar menu. Archived tasks move to a collapsible **Archived** section and can be restored; archiving pauses an active goal. Deletion asks for confirmation and also removes the task's change snapshots, agent transcript and attachment records/blobs within the validated private-storage roots. Both actions are refused while a run is in progress. Strings are provided for all four interface languages.

### Changed
- `.gitignore` excludes the private desktop-pet atlas directory.

No GitHub Release was published for 0.2.2; its changes ship in 0.2.3.

## 0.2.1 — 2026-10-26

### Fixed / security
- Application-data isolation integrated into 0.2.0: file tools, discovery, snapshots, previews, change views, undo and checkpoints share the registered workspace capability; application data/cache/log directories are excluded by canonical path and link checks; registered roots are revalidated at the resource-tool boundary; stored external-edit identities are authenticated per session.
- Acceptance checker launches its child PowerShell with a process-scoped execution policy.

Released as the first GitHub Release (Windows x64 portable ZIP).

## 0.2.0 — 2026-10-26

### Added
- Three approval modes: Ask for approval, Approve with rules, Full access. Approvals can be once or for the conversation, bound to the exact command and working directory.
- Image, UTF-8 text and read-only folder attachments.
- Plan mode with question cards and plan cards; execution starts only after the user accepts the plan.
- Goal mode for external models (default two hours of active work, pause/resume/clear, adjustable budget). Not available for local Ollama.

### Changed
- External models no longer have the fixed 12-tool-call-per-turn limit; local Ollama keeps it.
- Neutral light/dark interface.

## 0.1.22 — 2026-10-26
- Desktop companion customization (preview and custom pet library) and the bundled `create-desktop-pet` project skill. No third-party character art is distributed.

## 0.1.21 — 2026-10-25
- Project logo and local user menu.

## 0.1.19 — 2026-10-25
- Tasks can start without a project folder and later move into a project while keeping their context.
- Pinned and collapsible project/task navigation with persisted sidebar preferences; inline file links; copy action only on a turn's final answer.

## 0.1.14 — 2026-10-25
- Simplified Windows onboarding and setup, improved first cloud API configuration and desktop usability.
- Consistent conversation typography, compact stop timing and expandable file-change cards.
- Interface in Simplified Chinese, English, Japanese and Korean, with a persisted reply-language setting.
- Progress updates written as natural sentences without boilerplate labels.

## 0.1.13 — 2026-10-25
- Whole-turn summaries (elapsed time and file changes) and embedded previews for generated HTML, image and text artifacts.

## 0.1.12 — 2026-10-25
- Initial public source release with private data excluded.
