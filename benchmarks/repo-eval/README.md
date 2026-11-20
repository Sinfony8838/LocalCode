# repo-eval — L4 real-engineering mechanism bank

Deterministic tasks that exercise concrete engineering mechanisms instead of
generic bug fixing. Each task ships the usual contract (`task.json`,
`fixture/`, `reference/`, `verify.mjs`, `PROMPT.zh.md`, `PROMPT.en.md`) and is
validated by `node benchmarks/run.mjs self-test --tier L4` (pristine ≤ 40,
reference = 100).

## Tasks

| id | mechanism under test | what verify.mjs scores |
| --- | --- | --- |
| `R1-resilient-multihunk-edit` | multi-hunk whitespace-tolerant edits + byte-level CRLF/BOM preservation + JSON syntax guard | three scattered fixes across BOM+CRLF files, `policy.json` stays valid JSON, BOM/CRLF/trailing whitespace preserved on untouched lines |
| `R2-cross-module-navigation` | cross-module `search` + structured `read_file` navigation to a 3-module race chain | store versioning, per-order same-tick serialization, auto-ship contract, regression gate on unrelated 300+ line modules |
| `R3-windows-subproc-trap` | stdin-close / non-interactive / watchdog subprocess lifecycle | closed-stdin CLI must exit 2 (never block), piped stdin never confirms, helper watchdog declines within budget, stats/rotate unchanged |

## Token-efficiency telemetry (R2)

The `verify.mjs` scores correctness only. The navigation-efficiency claim is
measured outside the scorer: run the task through
`benchmarks/localcode-runner.mjs` (or another harness), then compare
`inputTokens` / `toolCalls` from `run.mjs sync-logs` against a
full-file-read baseline. The incident ticket is deliberately placed three
hops away from the entry module, behind two 300+ line distractors, so
agents that bulk-read the repo pay a measurable token premium over agents
that navigate with search + targeted reads.
