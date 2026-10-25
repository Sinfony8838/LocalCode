# Open-source release review

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
