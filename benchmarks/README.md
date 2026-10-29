# Agent comparison benchmark / Agent 对比评测题库

A repeatable way to compare coding agents (LocalCode vs another agent, or two
checkpoints of the same agent) **on the same API and model**. Every agent gets
identical fresh workspaces; a deterministic scorer grades the result files and
writes a side-by-side scoresheet. Requires Node.js 20+; no third-party packages
are installed or needed; nothing runs in the cloud.

用于在**同一 API、同一模型**下对比编程 Agent（例如 LocalCode 与 Claude Code，或
同一 Agent 的不同版本）。每个 Agent 拿到相同的全新工作区，确定性评分脚本对结果
逐项打分并生成对比评分表。需要 Node.js 20+，不安装第三方依赖，不需要联网。

## Tiered question bank / 分层题库

Tasks live in banks; each `task.json` declares its tier. Scores are 0–100 per
task from weighted deterministic checks (hidden checks live in each task's
`verify.mjs`, never inside the prepared workspace). Each task ships a
`reference/` solution that must score exactly 100, and an unsolved fixture that
must score ≤ 40 — `self-test` enforces both on every change.

任务按题库（bank）组织，`task.json` 声明所属层级。每题 0–100 分，由加权确定性
检查项构成（隐藏检查位于各题的 `verify.mjs`，不会复制进工作区）。每题附带必须
恰好得 100 分的参考答案；未解出的原始 fixture 必须不超过 40 分——`self-test`
在每次改动后强制校验这两点。

| Tier | Bank | What it measures | Tasks | Time each |
| --- | --- | --- | --- | --- |
| L1 冒烟 | `five-task/` | small fixes and builds; catches regressions of the harness and catastrophic agent failures (it once exposed a 0.2.3 command deadlock) | 5 | 5–15 min |
| L2 笔试 | `interview/` | complete app builds and library implementations from precise specs, scored on weighted feature points and edge cases | 5 | 25–35 min |
| L3 困难 | `hard/` | unfamiliar mid-size codebases: cross-file features, vague bug reports, behaviour-preserving refactors, performance budgets | 4 | 45–60 min |

L1 checks that nothing is broken. L2 separates competent from sloppy agents.
L3 is where strong models actually differ: reading unfamiliar code, honouring
constraints, resisting shortcuts, and finishing under a budget.

L1 用来确认没坏；L2 区分“会做”与“做得严谨”；L3 才是强模型真正拉开差距的地方：
读懂陌生代码、遵守约束、不走捷径、在预算内完成。

| ID | Tier | Task | Where the difficulty is |
| --- | --- | --- | --- |
| T1-python-stats | L1 | fix a Python module with failing tests | the case that exposed the 0.2.3 deadlock |
| T2-node-slugify | L1 | implement slugify from a spec | hidden unicode/case edge cases |
| T3-cart-totals | L1 | diagnose a multi-file cart bug | root-cause thinking + regression tests that must catch the original bugs |
| T4-pomodoro-page | L1 | build a pomodoro page | behavioural probing of a small DOM |
| T5-build-report | L1 | exact JSON report from data | exact field/formula adherence |
| A1-todo-app | L2 | full todo app (filters, edit, XSS-safe titles, persistence) | 14 weighted behaviours incl. HTML escaping and reload persistence |
| A2-expense-tracker | L2 | expense tracker with aggregation | money formatting (¥1,234.50), half-up rounding without float drift, validation |
| A3-markdown-notes | L2 | markdown editor with live preview | hand-rolled renderer: 7 pinned rules + escaping + restore |
| A4-rate-limiter | L2 | token-bucket rate limiter | continuous refill math, exact retryAfterMs, injected clock, side-effect-free peek |
| A5-csv-toolkit | L2 | RFC4180-style CSV parse/serialize | every quoting corner, BOM, error cases, round-trip |
| H1-queue-features | L3 | retries + dead-letter queue in the `taskflow` repo | conventions (injected clock, transitions, storage), pass-to-pass suite, fake-clock acceptance |
| H2-scheduler-bug | L3 | 3 root causes behind vague support tickets in `cronlite` | bugs mask each other; existing tests stay green while the bugs exist |
| H3-refactor-plugins | L3 | refactor `marklet` to a plugin pipeline | byte-identical output, API freeze, hook semantics + ordering |
| H4-large-report | L3 | exact stats over 150k events in 15 s | pinned percentile/rounding definitions; naive approaches time out |

## Run a comparison / 运行对比

```powershell
cd benchmarks
node run.mjs list                                        # show every task with tier
node run.mjs self-test                                   # harness sanity: reference=100, pristine<=40
node run.mjs prepare --out D:\bench\2026-10-30 --agent localcode --tier L2,L3
node run.mjs prepare --out D:\bench\2026-10-30 --agent claude-code --tier L2,L3
```

`prepare` refuses to reuse an existing `<out>\<agent>` folder, so earlier runs
are never overwritten. It writes one folder per task, `PROMPTS.md`, one
`<task>.prompt.txt` per task and a `manual.json` record. `--lang zh|en` picks
the prompt language; `--tasks T1,A1` and `--bank five-task` filter further.

`prepare` 拒绝复用已存在的 `<out>\<agent>` 目录，历史结果永不覆盖。会生成每个
任务的文件夹、`PROMPTS.md`、每题的 `<task>.prompt.txt` 和 `manual.json` 记录。

1. **LocalCode:** for each task, add the task folder as a project, start a **new
   task** with the same provider/model as the other agent, keep the default
   approval mode (*Ask for approval*) unless the comparison specifies otherwise,
   and send the prompt from `PROMPTS.md` unchanged. Approve the commands it asks
   to run; do not give extra hints.
2. **Command-line agent:** either run it by hand in each folder with the same
   prompt, or let the runner call it:
   `node run.mjs run --out D:\bench\2026-10-30 --agent claude-code --cmd "claude -p --permission-mode acceptEdits < {promptFile}"`
   (`{promptFile}` is replaced with the quoted prompt path; `BENCH_PROMPT_FILE`
   and `BENCH_TASK` are also set. Output goes to `<task>.agent.log`; wall time
   is recorded in `manual.json`.)
3. Fill in `manual.json` for each agent and task: `durationSeconds`,
   `toolCalls`, `userInterventions` (approvals do not count; corrections or
   hints do), `inputTokens`/`outputTokens` or a `costNote`, `processQuality`
   (0–5, see below) and free-form `notes`.
4. Score everything: `node run.mjs score --out D:\bench\2026-10-30`. This writes
   `scoresheet.md`, `scoresheet.csv` (Excel-friendly UTF-8) and `results.json`
   with per-tier subtotals. Re-run `score` after editing `manual.json`; scoring
   never modifies workspaces.

## Repeat runs and medians / 重复运行与中位数

Model sampling is noisy: a single run tells you very little. Run each agent at
least three times (separate labels `localcode-1`, `localcode-2`, `localcode-3`)
on an otherwise idle machine, then aggregate:

模型采样有随机性，单次运行说明不了什么。每个 Agent 至少跑三次（用独立标签
`localcode-1`…），在空闲机器上运行，然后聚合：

```powershell
node run.mjs aggregate --out D:\bench\2026-10-30
```

This writes `aggregate.md` / `aggregate.json` with per-task median scores,
per-task median durations and the median total. **Compare medians, not single
runs.** A two-point score gap on L3 with three repeats is a real difference; a
one-point gap on L1 usually is not.

输出 `aggregate.md` / `aggregate.json`：每题中位数得分、中位耗时和总分中位数。
**比较中位数，不要比较单次。** 三次重复下 L3 层 2 分的差距是真实差距；L1 层
1 分的差距通常只是噪声。

## Process quality rubric (manual) / 过程质量（人工评分）

| Score | Meaning |
| --- | --- |
| 5 | Read the relevant code first, verified with the project's own tests or a real check, explained the result accurately |
| 4 | Correct and verified, but with redundant steps or a slightly inaccurate explanation |
| 3 | Mostly correct; verification partial or explanation overstates success |
| 2 | Needed a user correction, or claimed success without verifying |
| 1 | Edited protected files, made unrelated changes, or abandoned the task |
| 0 | No meaningful progress |

Report automatic and manual scores separately; do not add them together.
自动分与人工分分开报告，不相加。

## Fairness notes / 公平性说明

- Use the same provider, model ID, context window and reasoning setting for
  every agent, and record them in `notes`.
- Start every task in a fresh conversation; run agents one at a time.
- Local Ollama turns are limited to 12 tool calls in LocalCode; record whether
  a task ended because of that limit (L2/L3 tasks are long for that limit).
- Web-app tasks (T4, A1–A3) are probed by a deliberately capability-limited DOM
  stub (`lib/dom-probe.mjs`): real DOM tree, bubbling events, forms, a fake
  clock and a localStorage that survives reloads. A page that relies on APIs
  the stub lacks loses those points with a `stub error` detail; check such
  pages by hand in a browser and note it.
- H4 enforces its 15 s budget when scoring re-runs `solve.mjs`; scores can vary
  a few percent with machine load, so keep the machine idle.

## Contamination and private tasks / 题目污染与私有题库

This bank is public, so strong models may have seen tasks or near-neighbours
during training. Two defences:

1. `benchmarks/local-tasks/` is a bank you keep **out of git** (gitignored).
   Drop tasks with the same shape as `interview/tasks/*` in there and they are
   picked up automatically as tier `private`. Keep a held-out set there and
   weight it highest when the comparison matters.
2. Rotate: when a published task scores suspiciously high on every agent, it
   has stopped discriminating — retire it into `local-tasks` and write a
   variant (change the surface, the data, the pinned edge cases).

题库是公开的，强模型训练时可能见过题目或近邻。两个对策：把私有题放进被
gitignore 的 `benchmarks/local-tasks/`（自动识别为 `private` 层级），对比时以
私有题为最高权重；公开题一旦所有 Agent 都接近满分、失去区分度，就轮换变体。

## Layout / 目录结构

```
benchmarks/
  run.mjs            unified CLI: prepare / run / score / aggregate / self-test / list
  lib/common.mjs     shared helpers (fs trees, checks, node test runner, python lookup)
  lib/dom-probe.mjs  dependency-free DOM probe for web-app tasks
  five-task/         L1 smoke bank (unchanged from the original five tasks)
  interview/         L2 bank  (A1–A5)
  hard/              L3 bank  (H1–H4)
  local-tasks/       private held-out bank (gitignored, optional)
```

Every task folder: `task.json` (id, tier, prompt zh/en, protected files,
optional `generate`/`referenceRun` hooks, optional `minutes`), `fixture/` (the
prepared workspace), `reference/` (the solution), `verify.mjs` (deterministic
scorer). See an existing task as the template.
