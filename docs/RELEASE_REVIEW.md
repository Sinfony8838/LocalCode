# Open-source release review

## 0.1.18 tasks, projects and conversation controls

Reviewed on 2026-10-25 (Asia/Shanghai), integrating the latest public main including the typography update. Home now navigates without persisting empty conversations. Tasks can start without a workspace and later move into a project with their transcript and context intact. Projects support pinning and persistent collapsed groups. File links stay inline, and only a completed round's final answer has a copy action.

Validation of this integrated source:

| Check | Result |
| --- | --- |
| TypeScript and production build | PASS |
| Unit/integration regression | PASS; 141 passed, 2 platform/interactive checks skipped |
| Source Electron task/project, typography, artifact, checkpoint and model-setup suites | PASS |
| Windows packaging and packaged artifact/typography/task-project/home suites | PASS |
| Portable bundle allowlist | PASS; 3 passed, Windows symlink privilege check skipped |
| Scanner positive/negative controls, exact staged-source credential comparison and Gitleaks | PASS |
| npm install audit | PASS; 0 reported vulnerabilities |
| Real Ollama/GPU inference and external cloud requests | UNRUN; only deterministic localhost providers used |

The desktop suites use isolated application homes and synthetic project folders. They exercise initial projectless sends and continuation, retained context and project-scoped file writes after moving, busy-move rejection, draft preservation, delayed folder selection, pin/collapse persistence, inline file previews, final-only native clipboard copying, home navigation and restart. The existing external-link, literal-percent filename, checkpoint and model-setup controls are retained. Transient Windows rename retries are bounded to packaging staging/output directories.

Evidence and packaged executables remain outside Git. Hosted CI must pass on the PR commit before merging. This source update does not publish a formal binary Release or resolve the separate application-data isolation release hold.

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
