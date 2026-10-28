# Five-task comparison benchmark / 五任务对比评测

A repeatable way to compare LocalCode with another coding agent (for example Claude Code) **on the same API and model**. Each agent gets identical fresh copies of five small projects; a deterministic scorer then grades the resulting files and writes a side-by-side scoresheet.

用于在**同一 API、同一模型**下对比 LocalCode 与其他编程 Agent（例如 Claude Code）。每个 Agent 拿到五个小项目的相同全新副本，评分脚本对结果文件做确定性评分，并生成对比评分表。

Requires Node.js 20+; T1 also needs Python 3 (`python`, `py -3` or `python3`). No network access or third-party packages are used. 需要 Node.js 20+；T1 另需 Python 3。不联网、不安装第三方包。

## Tasks / 任务

| ID | What it measures | Automatic checks (100 points each) |
| --- | --- | --- |
| T1-python-stats | Fix a Python module with failing unit tests (the case that exposed the 0.2.3 command deadlock) | test file untouched (10), 6 visible tests (60), 6 hidden edge cases (30) |
| T2-node-slugify | Implement a function from a written specification | spec/tests untouched (10), 5 visible tests (40), 10 hidden edge cases (50) |
| T3-cart-totals | Diagnose a multi-file bug from a bug report and add regression tests | report untouched (10), 3 reported scenarios (45), 3 hidden cases (15), agent's tests pass (15), agent's tests fail against the original bugs (15) |
| T4-pomodoro-page | Build a self-contained web page | spec untouched (10), title/ids/viewport/no external resources (25), countdown behaviour in a stub DOM with a fake clock (65) |
| T5-build-report | Analyse a JSON data file and produce an exact structured report | data untouched (10), exact field set (10), 7 computed fields (70), short summary (10) |

Hidden checks live in each task's `verify.mjs`, outside the prepared workspaces. Each task has a `reference/` solution that the self-test requires to score 100. 隐藏检查位于各任务的 `verify.mjs`，不会复制进工作区。

## Run a comparison / 运行对比

```powershell
cd benchmarks\five-task
node run.mjs self-test                                   # harness sanity check
node run.mjs prepare --out D:\bench\2026-10-29 --agent localcode   --lang zh
node run.mjs prepare --out D:\bench\2026-10-29 --agent claude-code --lang zh
```

`prepare` refuses to reuse an existing `<out>\<agent>` folder, so earlier runs are never overwritten. It writes one folder per task, `PROMPTS.md`, one `<task>.prompt.txt` per task and a `manual.json` record.

1. **LocalCode:** for each task, add the task folder as a project, start a **new task** with the same provider/model as the other agent, keep the default approval mode (*Ask for approval*) unless the comparison specifies otherwise, and send the prompt from `PROMPTS.md` unchanged. Approve the commands it asks to run; do not give extra hints.
2. **Command-line agent:** either run it by hand in each folder with the same prompt, or let the runner call it, for example
   `node run.mjs run --out D:\bench\2026-10-29 --agent claude-code --cmd "claude -p --permission-mode acceptEdits < {promptFile}"`
   (`{promptFile}` is replaced with the quoted prompt path; `BENCH_PROMPT_FILE` and `BENCH_TASK` are also set. Output goes to `<task>.agent.log`; wall time is recorded in `manual.json`.)
3. Fill in `manual.json` for each agent and task: `durationSeconds`, `toolCalls`, `userInterventions` (approvals do not count; corrections or hints do), `inputTokens`/`outputTokens` or a `costNote`, `processQuality` (0–5, see below) and free-form `notes`.
4. Score everything: `node run.mjs score --out D:\bench\2026-10-29`. This writes `scoresheet.md`, `scoresheet.csv` (Excel-friendly UTF-8) and `results.json` in the output folder. Re-run `score` after editing `manual.json`; scoring never modifies workspaces.

## Process quality rubric (manual) / 过程质量（人工评分）

| Score | Meaning |
| --- | --- |
| 5 | Read the relevant code first, verified with the project's own tests or a real check, explained the result accurately |
| 4 | Correct and verified, but with redundant steps or a slightly inaccurate explanation |
| 3 | Mostly correct; verification partial or explanation overstates success |
| 2 | Needed a user correction, or claimed success without verifying |
| 1 | Edited protected files, made unrelated changes, or abandoned the task |
| 0 | No meaningful progress |

Report automatic and manual scores separately; do not add them together. 自动分与人工分分开报告，不相加。

## Fairness notes / 公平性说明

- Use the same provider, model ID, context window and reasoning setting for every agent, and record them in `notes`.
- Start every task in a fresh conversation; run agents one at a time on an otherwise idle machine.
- Local Ollama turns are limited to 12 tool calls in LocalCode; record whether a task ended because of that limit.
- The T4 behaviour probe uses a deliberately small DOM stub. A page that relies on APIs the stub lacks loses those points with a `stub DOM error` detail; check such pages by hand in a browser and note it.
- Results depend on model sampling. For a meaningful comparison, repeat each agent at least three times (use separate `--agent` labels such as `localcode-1`, `localcode-2`) and compare medians.
