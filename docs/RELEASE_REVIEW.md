# Open-source release review

## 0.2.4 backend localization, benchmark and executor regressions

Prepared on 2026-10-29 (Asia/Shanghai). Merged pull requests [#12](https://github.com/Sinfony8838/LocalCode/pull/12) (five-task benchmark), [#13](https://github.com/Sinfony8838/LocalCode/pull/13) (command-executor regression tests) and [#14](https://github.com/Sinfony8838/LocalCode/pull/14) (backend message localization), each after green hosted Windows CI, plus this version bump.

| Check | Result |
| --- | --- |
| Hosted Windows CI on each pull request and on `main` after merge | PASS; run links are recorded in the release's `release-manifest.json` |
| Backend message coverage test (`tests/backend-i18n.test.ts`) | Added and passing |
| Node.js, Git, long output and closed/non-interactive stdin through the executor | ADDED (Windows CI only; Python and Git cases skip when the tool is missing) |
| Five-task benchmark harness self-test (pristine fixtures fail, references score 100) | PASS in CI |
| Five-task comparison against a real agent/model | UNRUN; the harness is provided, no scores are claimed |
| Real Ollama/GPU inference, real cloud requests, clean-Windows and reboot acceptance | UNRUN |

## 0.2.3 command-executor deadlock fix

Prepared on 2026-10-29 (Asia/Shanghai). Source commits `9160167` (fix) and `c4a592a` (incident record and version bump), plus a documentation-only commit updating the READMEs, this review and `CHANGELOG.md`. 0.2.3 is the first GitHub Release after 0.2.1 and also ships the 0.2.2 changes below.

The approved-command executor's parent-death watchdog previously blocked on a stdin pipe read. CPython closes inherited standard handles during interpreter shutdown, which deadlocked against that read, so every Python command finished its work and then hung until the 120-second timeout. The watchdog now waits on the agent worker's process handle and the command's stdin is `NUL`. See the [incident review](../LocalCode/source/docs/incident-2026-10-28-python-command-deadlock.md).

| Check | Result |
| --- | --- |
| Hosted Windows CI on `c4a592a` (typecheck, unit/integration, source and packaged Electron suites, setup checks, scans, packaging) | PASS — [run 40710293331](https://github.com/Sinfony8838/LocalCode/actions/runs/40710293331) |
| Maintainer local unit/integration run reported in the incident review | PASS; 310 tests in 29 files, including the new Python regression test |
| Independent Linux re-run of typecheck and unit tests on `c4a592a` | PASS; 301 passed, 11 Windows-only skipped |
| Release archive | Built by hosted CI for the final documentation commit; exact commit, run and checksum are recorded in the release's `release-manifest.json` |
| Real Ollama/GPU inference and real cloud requests for these bytes | UNRUN; automated checks use synthetic localhost providers |
| Clean-Windows, fresh default Ollama and computer-reboot acceptance | UNRUN |
| Regression coverage for other third-party runtimes (Node.js, Git, long output, interactive stdin) through the executor | NOT YET ADDED in 0.2.3; added in 0.2.4 |

## 0.2.2 session archive and delete

Merged on 2026-10-26 and versioned on 2026-10-28 (Asia/Shanghai) as `8ff8cf0` / `79f4eb3`. Adds archive, restore and delete for tasks from the sidebar; deletion clears the task's snapshots, transcripts and attachment blobs under validated private-storage roots and is refused while a run is in flight. `.gitignore` now excludes the private desktop-pet atlas directory.

| Check | Result |
| --- | --- |
| Hosted Windows CI on `8ff8cf0` and `79f4eb3` | PASS — [run 40341584992](https://github.com/Sinfony8838/LocalCode/actions/runs/40341584992), [run 40686877974](https://github.com/Sinfony8838/LocalCode/actions/runs/40686877974) |
| Store, attachment and sidebar archive unit tests | Added and passing in CI |
| Dedicated Electron acceptance suite for archive/delete | NOT ADDED; covered by unit/component tests only |
| GitHub Release | Not published separately; shipped in 0.2.3 |
| Real-model, clean-Windows and reboot acceptance | UNRUN |

## 0.2.1 Windows portable release

Release preparation on 2026-10-26 (Asia/Shanghai), following the maintainer's report that their friend completed testing and their explicit instruction to publish. That external result is recorded as user-reported; no exact tested ZIP hash, hardware report or detailed local/cloud/reboot results were supplied for the new integrated package.

This release integrates the previously separate application-data isolation fix into 0.2.0. File tools, discovery, snapshots, previews, changes, undo and checkpoints share the registered workspace capability, canonical protected data/cache/log roots and private-storage link checks. External edits retain exact-resource approvals and independent undo records; their stored resource identity is authenticated per session so an edited journal cannot silently select an external root. Text attachment copies remain explicitly read-only. Projectless tasks, four languages, desktop pets and goal cancellation fences are preserved.

The release asset manifest will record the exact source commit, successful hosted CI, archive checksum, extracted-file verification and packaged desktop results. Automated model checks use synthetic localhost providers. This release does not claim new real cloud inference, clean-Windows hardware or fresh Ollama/reboot coverage for these integrated bytes. The application remains unsigned, uses the current Windows user's permissions, and supplies no OS sandbox. Updates use a new folder and preserve the old data privately. The older holds below describe their stated historical candidates, not this publication authorization.


## 0.1.19 tasks, projects and conversation controls

Reviewed on 2026-10-25 (Asia/Shanghai), integrating public main's typography and multilingual updates. Home now navigates without persisting empty conversations. Tasks can start without a workspace and later move into a project with their transcript and context intact. Projects support pinning and persistent collapsed groups. File links stay inline, and only a completed round's final answer has a copy action. New controls support all four interface languages; projectless replies follow the selected response language.

Validation of this integrated source:

| Check | Result |
| --- | --- |
| TypeScript and production build | PASS |
| Unit/integration regression | PASS; 168 passed, 2 platform/interactive checks skipped |
| Source Electron task/project, language, typography, artifact, checkpoint and model-setup suites | PASS |
| Windows packaging and packaged artifact/language/typography/task-project/home suites | PASS |
| Portable bundle allowlist | PASS; 3 passed, Windows symlink privilege check skipped |
| Scanner positive/negative controls, exact staged-source credential comparison and Gitleaks | PASS |
| npm install audit | PASS; 0 reported vulnerabilities |
| Real Ollama/GPU inference and external cloud requests | UNRUN; only deterministic localhost providers used |

The desktop suites use isolated application homes and synthetic project folders. They exercise initial projectless sends and continuation, retained context and project-scoped file writes after moving, busy-move rejection, draft preservation, delayed folder selection, pin/collapse persistence, inline file previews, final-only native clipboard copying, home navigation and restart. The existing external-link, literal-percent filename, checkpoint and model-setup controls are retained. Transient Windows rename retries are bounded to packaging staging/output directories.

Evidence and packaged executables remain outside Git. Hosted CI must pass on the PR commit before merging. This source update does not publish a formal binary Release or resolve the separate application-data isolation release hold.

## 0.1.15 exact 620de707 package — local checks passed, RELEASE HOLD

The clean source commit `620de7078c339c1953190f004f747e9743b47a1d` passed both [push CI 40202782603](https://github.com/Sinfony8838/LocalCode/actions/runs/40202782603) and [PR CI 40202785989](https://github.com/Sinfony8838/LocalCode/actions/runs/40202785989). Its local full unit run passed 181 tests with 2 platform skips. The exact newly built executable passed all six packaged Electron suites: isolation (4 checks), typography (6), artifacts (9), checkpoints (4), model setup (4) and language (7), totaling 34 checks. EXE, main and worker hashes were unchanged before and after those suites:

| Component | SHA-256 |
| --- | --- |
| LocalCode.exe | `f23f902c4ce3ff6767d968407539a49bc40a6624437e069c08dba95e3dd67254` |
| main.cjs | `a8abeb005a9507210c49c9bdc30702fd335c1a32922b800b1139a8bd85967bc1` |
| worker.mjs | `02be7547dbbd180d91c61124f442ceff31f32eb0639898a78b7e221b0d99b38c` |

Real Ark Coding Plan acceptance also passed against this exact packaged executable from clean `620de707` source: 1 connection request and 7 task requests, including actual file reads/edits, an approved passing terminal test, a denied command and cancellation with no further tools during the ten-second observation. Task responses reported 3,150 input, 1,200 output and 6,912 cache-read tokens (11,262 total); the separate connection response reported 88 input and 16 output tokens. This remains a bounded synthetic-project check. Billing and the underlying mutable model-alias revision remain unknown. The earlier `b745481` failure and repeat below are retained as separate historical results.

The external report identified Windows 11 x64 without global Node/npm/Ollama, but with Git already present; Python command entries were reported only as Windows Store aliases. It therefore does not meet the agreed all-tools-absent clean-environment condition. A startup window was observed, but the observation was not bound to an exact ZIP hash. The first default local installation encountered a GitHub HTTPS/443 curl 28 timeout. The user reports that a retry is downloading; successful installation is not confirmed. Fresh-default-model tasks and a full computer reboot remain UNRUN. These observations do not establish completed external acceptance.

Application-data isolation is no longer an unresolved code blocker: its fix passed local regression. Formal release remains on hold for the outstanding clean-Windows and fresh default Ollama task/reboot acceptance and final archive verification. Candidate artifacts, including the historical r5 candidate, are not recommended formal releases. No new EXE or candidate archive is produced by this text-only update.

## 0.1.15 source integration with multilingual main — RELEASE HOLD

The next integration freezes main at `8ee612ef45e4d512e4226eb82ada1ad7827b59ea` (PR #5 languages and PR #7 progress wording), combined with the isolation/typography branch and the Restricted-parent acceptance launcher fix. Workspace capabilities, trusted session-to-project resolution and per-session storage checks remain intact. Worker requests carry both the complete workspace capability and the language captured when Send is accepted. CI retains isolation, typography and language checks for source and packaged Electron, plus the actual Restricted-parent launcher regression.

Local source verification passed: TypeScript, production build, 181 unit/integration tests with 2 non-Windows skips across 22 files, and all six source Electron suites (isolation, typography, artifacts, checkpoints, model setup and language). Portable/launcher tests passed 5 checks with 1 Linux-only symlink check skipped on Windows; both Restricted-parent launcher cases passed. These tests used fabricated records and local synthetic protocol services. No real model was called and no new package was built during this integration validation.

The previous packaged cloud result below remains historical evidence for its stated build; it does not establish acceptance of the newly integrated executable. Final committed-source CI, a rebuilt package and its actual task/archive checks are still needed, along with the outstanding clean-Windows and fresh default Ollama/reboot results. New P0 access-denial strings currently fall back to Chinese in non-Chinese interfaces when no translation mapping exists; the denial itself remains enforced.

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
