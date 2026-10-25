# Open-source release review

## 0.1.15 integrated candidate update — external acceptance still pending

The isolation branch was integrated with main `741fd199ca6187ab881b19bddda6056aecf40c10` (PR #4 typography). Both typography and isolation remain mandatory for source and packaged Electron. Commit `b745481133bc7bf0f6947669cdea787baf212259` passed [Windows CI 40197324773](https://github.com/Sinfony8838/LocalCode/actions/runs/40197324773): 155 tests passed, 2 non-Windows checks skipped. The same committed runtime passed all five local packaged suites: isolation, typography, artifacts, checkpoints and model setup.

Real Ark Coding Plan acceptance was repeated against the packaged 0.1.15 executable from a clean `b745481` checkout. It reopened only the synthetic test home in which the user had previously entered a key normally; no original credentials or Chromium protection metadata were extracted/copied. The first attempt made 4 requests but stopped after the model asked for approval in prose without calling the terminal tool, and was recorded as FAIL. One identical-condition repeat made 9 requests and passed actual read/edit/approved test, denial and cancellation with a ten-second no-further-tools observation. Both reports must accompany candidate evidence. This is a bounded task check, not an unconditional reliability or model-quality claim; billing and the underlying mutable alias revision remain unknown.

Local Windows VM acceptance was not run: no Windows guest was available, and current host resources were insufficient. The user selected a friend's computer for clean non-administrator Windows and fresh default Ollama/reboot acceptance. Those gates remain UNRUN. This documentation update does not change runtime/support inputs; candidate manifests bind the actual tested bytes and their source provenance. No formal GitHub Release is authorized as passed until those outstanding results and final archive verification are complete.

The external tester then reproduced an acceptance-tool defect: the original `Check-Environment.cmd` invoked a script without a per-process execution-policy argument, so Windows PowerShell rejected it before a results file existed. The corrected launcher uses the system Windows PowerShell 5.1 executable with `-NoLogo -NoProfile -ExecutionPolicy Bypass -File` for that child only. It never changes persistent execution policy or requests elevation, reports missing inputs/failures, and does not override organization Group Policy. CI exercises the actual CMD chain from a Restricted parent in a Chinese/space-containing directory and checks the parent and persistent policies remain unchanged. This corrects test tooling; it does not convert the friend's interrupted attempt into successful application/installation acceptance.

## 0.1.15 application-data isolation candidate — RELEASE HOLD

Reviewed on 2026-10-25 (Asia/Shanghai), starting from `8c9d04cd54a51d53f203cc10194230cb456ff7ef`. This update adds a mandatory workspace capability shared by file tools, the file browser, previews and run snapshots. Application data/cache/log directories are excluded by canonical path and link checks. Changes, undo, checkpoints and recovery receive the session's registered project root; journal paths cannot select a different project. Session storage aliases and multi-linked files are refused. Existing histories remain in place; unsafe legacy operations fail with an explicit error.

| Check | Result |
| --- | --- |
| TypeScript and production build | PASS locally |
| Unit/integration regression | PASS locally; initial full run: 154 passed, 2 non-Windows-only checks skipped, 19 files. After canonicalizing synthetic worker roots, 40 focused engine/thinking/isolation checks passed, including 18 isolation cases |
| Windows PowerShell 5.1 and PowerShell 7 setup checks | PASS; 132 checks in each shell, no actual downloads or service starts |
| Portable allowlist regression | PASS; 3 passed, 1 Linux-only symlink negative control skipped on Windows |
| Real Electron source isolation acceptance | PASS; project selection, file/browser/preview denial, journal ownership, normal history/checkpoint/undo, explicit data-folder opening |
| Existing Electron checkpoint, model-setup and artifact acceptance | PASS with isolated homes and synthetic responses; not real-model capability evidence |
| Packaged 0.1.15 EXE isolation/checkpoint/model-setup/artifact acceptance | PASS locally with isolated homes and synthetic responses; not a clean-machine or fresh-model result |
| Production dependency audit | PASS locally; 0 reported vulnerabilities |
| Real Ark Coding Plan cloud task acceptance | PASS in source Electron with `ark-code-latest` / Anthropic: user-entered isolated credential, save/test/select, file read/edit, approved test, denied command, cancellation and ten-second no-further-tools observation; 8 request attempts |
| Clean non-administrator Windows installation | UNRUN; external tester's environment report and actual results required |
| Fresh default Ollama/model installation, inference and computer reboot | UNRUN; existing local installations do not satisfy this gate |
| Final package, hosted CI and public GitHub Release | PENDING; no release readiness claim |

All isolation fixtures use temporary directories and fabricated records. The first restricted local run failed because junctions, links, localhost access and process verification were restricted; the full-permission Windows run passed. An intermediate run encountered a transient `EPERM` on atomic workspace rename; its result was retained and the subsequent complete run passed without replacing atomic writes with truncation. These failures are not counted as successful checks.

The first PR #3 hosted run rejected synthetic worker requests whose raw temporary root differed from `realpath` on the runner. The real project picker already registers canonical roots. The worker fixtures now canonicalize their roots at creation, and an additional regression verifies selecting a project through an alias. The production root-change guard remains unchanged. Consult [PR #3 checks](https://github.com/Sinfony8838/LocalCode/pull/3/checks) for the latest hosted result; the earlier failed run is not acceptance evidence.

The real-cloud harness reads provider metadata but requires credentials to be saved directly in its isolated desktop. It copies neither original credentials nor Chromium encryption metadata. It records actual task outcomes, request attempts, returned model identifiers and usage when available; a subscription price or underlying alias version is unknown unless the provider exposes it. A settings-only response is not proof of tool execution.

The successful source cloud run recorded 7 task requests and 1 connection-test request. Saved assistant usage totaled 5,757 input, 1,439 output and 3,840 cache-read tokens (11,036 total); the separate connection test reported 88 input and 16 output tokens. Returned identifiers were `auto` and `ark-code-latest`, which do not establish the underlying model revision. Billing/monetary cost is UNKNOWN. The original configuration file remained byte-identical. Earlier harness attempts stopped at a disabled save button and incompatible encrypted profile context; they do not count as successful cloud acceptance. No credential/protection-metadata extraction was used in the successful run. This proves the tested synthetic tasks, not general coding quality or fresh-machine/local-model acceptance.

Reproduction: run the standard typecheck/test/build pipeline, `node scripts/acceptance-isolation.mjs`, and the existing Electron suites from the desktop source directory. CI requires isolation checks for both source and packaged Electron. The external test kit is under [scripts/acceptance](../scripts/acceptance/README.zh-CN.md). `scripts/Build-Candidate.ps1 -OutputDirectory <new-folder>` accepts only a clean committed checkout and creates allowlisted portable/source/test-kit ZIPs, SHA-256 sums and a manifest with `releaseReady: false`. These are candidate artifacts, not a formal release.

The eventual release evidence manifest must bind the final main-branch SHA, exact ZIP hashes, CI run, clean-machine results and real-model results. The published ZIPs must be the exact bytes tested after final extraction/startup verification. Generate that manifest as a release asset after packaging; do not change source merely to insert its own package hash. No certificate purchase is included; the Windows application remains unsigned.

## 0.1.14 onboarding baseline — historical, not release acceptance

PR #2 merged as `8c9d04cd54a51d53f203cc10194230cb456ff7ef`; [main-branch Source checks run 40191059550](https://github.com/Sinfony8838/LocalCode/actions/runs/40191059550) completed successfully. The application-data isolation blocker was explicitly unresolved at that commit. The workflow produced a 14-day Actions artifact, not a formal GitHub Release. Its preinstalled CI tools and synthetic model responses did not establish clean-machine installation or real cloud/Ollama task acceptance. The 83-test count in the older section below belongs to 0.1.13 only.

---

## 0.1.13 turn summaries and artifact previews

Reviewed on 2026-10-25 (Asia/Shanghai). This source update adds completion records only after an entire agent turn settles, independent per-turn file statistics, file opening menus, and isolated HTML/image previews. It retains the portable paths, validated model profile, configurable local budgets, dependency security override, packaging allowlist, and artwork exclusions from the 0.1.12 baseline below.

Validation of this updated source:

| Check | Result |
| --- | --- |
| TypeScript and production build | PASS |
| Unit/integration regression | PASS; 83 tests, including ignored-path and Windows case-insensitive file accounting |
| Actual Electron artifact acceptance | PASS; 8 checks covering intermediate messages, consecutive turns, HTML interaction, source/menu actions, external-link IPC, cancellation/failure, themes and restart |
| Production dependency audit | PASS; 0 reported vulnerabilities |
| Exact staged-source scanner and credential comparison | PASS; no stored credential ciphertext matched the publication set |
| Gitleaks staged scan | PASS; no leaks found |
| New packaged binary, real Ollama/model inference and cloud calls | UNRUN for this source update; no binary published and no paid requests made |

The desktop test used an isolated application home and localhost synthetic responses. Browser/default-app/Explorer launches were intercepted; the Windows application chooser argument construction was unit-tested without interactive OS selection. HTML's local scripts and assets ran in a real Electron iframe. PDF remains an external-application workflow. Local test evidence is retained outside Git; GitHub CI status must be verified against the PR commit. The workflow now runs the same desktop artifact acceptance after building.

See [turn summaries and previews](TURN_SUMMARIES_AND_PREVIEWS.md) for usage, snapshot limits, and reproduction commands.

---

The following review records the original **0.1.12 baseline**, including its separate packaging and hardware evidence.

Review date: 2026-10-25 (Asia/Shanghai). Version: 0.1.12.

## Publication scope

This is a new, clean source repository. It contains the desktop implementation, tests, locked npm dependency graph, portable deployment helpers and documentation. It does not import an existing Git history or publish a prebuilt desktop binary.

The original local installation remains separate. Its credentials (including encrypted values), Chromium profile, conversations, file snapshots, logs, screenshots, evidence archives, executable releases, caches and model weights are excluded. Original character images are excluded because public redistribution rights were not established. The optional importer remains available with neutral character labels and is disabled by default.

## Review findings and corrections

| Finding | Correction |
| --- | --- |
| Absolute installation paths tied to one machine | Root-relative launchers and a per-user fallback for direct development launch |
| Personal runtime data adjacent to source | Clean export with source allowlist, new Git history, ignored runtime directories and exact-index scanner |
| Packaging could include an accidentally added `.env` | Packaging input restricted to `dist`, `node_modules`, `package.json` and `LICENSE`; synthetic private-file negative control required |
| Vulnerable transitive `undici` 8.10.2 | Exact override to 8.12.2; direct dependencies also pinned to exact versions |
| Setup budget could differ from actual request | Local model requests now honor the validated profile; real SDK/local HTTP fixture checks 16K / 2048 request settings |
| User-selected model described as previously accepted | UI now states that model capability requires user verification |
| Unrelated Ollama might own port 11434 | Setup refuses before downloads, without stopping or changing that service |
| Runtime download integrity | Fixed SHA-256 for official Node.js and Ollama archives; lockfile integrity for npm; model tags explicitly documented as mutable |

The dependency correction addresses [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) and the other advisories reported for the previous `undici` version. A clean audit is a point-in-time result, not proof that every dependency or application behavior is vulnerability-free.

## Validation

| Check | Result |
| --- | --- |
| Official registry npm install / audit | PASS; 0 known vulnerabilities in 307 audited packages |
| TypeScript | PASS |
| Unit and integration tests | PASS; 56 tests in 8 files, including real SDK calls to local synthetic HTTP services |
| Production build | PASS |
| PowerShell syntax and plan mode | PASS; default and 4K/512 model plan |
| Existing service collision guard | PASS; refused before downloads and preserved the unrelated service |
| Scanner positive and negative controls | PASS |
| Exact staged blobs against stored credential ciphertext | PASS; comparison performed locally without printing values |
| Gitleaks 8.30.1 staged scan | PASS; no leaks found |
| Final one-click build and Windows packaging | PASS; portable Node download and checksum, clean npm install, checks, build and Windows x64 package; identical rebuild safely reused |
| Packaging private-file negative control | PASS; synthetic `.env` and `source/data` excluded; no original character PNGs in output |
| Packaged desktop simulated provider/session/reasoning acceptance | PASS; 9 provider, 5 session, 7 reasoning checks; no errors; all model responses from localhost fixtures |
| Fresh Ollama runtime/model download and GPU inference with this source release | UNRUN |
| Real cloud provider requests with this source release | UNRUN; no paid/cloud requests made |

An initial restricted-runner test attempt failed on localhost/process/link permissions. The same suite passed with the required Windows permissions. An initial packaging attempt encountered a transient Windows directory rename error; its log was retained locally and a later packaging attempt completed. These earlier attempts are not counted as successful validation of the final build.

The local hardware baseline was independently queried: Windows 11 x64, Intel Core Ultra 5 125H, 23.5 GiB reported RAM, RTX 4060 Laptop GPU with 8188 MiB VRAM and driver 572.60. Historical local-model acceptance belongs to the original installation. It is documented as reference evidence and is not represented as a newly repeated test of the sanitized open-source release.

The locally accepted executable SHA-256 is `35a2a6edfe04433dd096c261d011aec5b31e78cc176713438579238b35e4ba65`. That executable is not uploaded. The source and lockfile are published for rebuilding; this record does not claim byte-for-byte reproducibility of every Electron packaging artifact.

## Remaining boundaries

- One-click deployment targets Windows x64. Other systems and AMD/Intel acceleration require separate upstream setup and have not been accepted here.
- Larger/smaller models and longer contexts are capacity suggestions, not validated performance claims.
- The application is unsigned. Commands run with the user's permissions and can access files outside the project; there is no OS sandbox.
- Local histories and snapshots are not encrypted by the application. Secret redaction and scanning cannot discover every arbitrary secret.
- Model registry tags may change. Retain installed digests and run your own tool-calling and memory checks after installation.
- GitHub CI results must be checked against the published commit. Local checks alone do not establish that hosted CI has passed.

See [SECURITY.md](../SECURITY.md) and [third-party notices](../THIRD_PARTY_NOTICES.md).
