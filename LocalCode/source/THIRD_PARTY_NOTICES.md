# Third-party implementation references

## OpenCode — MIT

Source: https://github.com/anomalyco/opencode/tree/c0c7bae726798d02592f8d3305891ba2f0cd880a (v1.19.4).

`src/core/permissions.ts` adapts ordered `allow` / `ask` / `deny` evaluation and wildcard matching from `packages/opencode/src/permission/index.ts` and `packages/core/src/util/wildcard.ts`. Original source and MIT license are retained in `third_party/opencode/`. Changes: native Promise integration, exact hashed session grants, and non-overridable plan capability limits. Unlike upstream's instance-wide approved list, LocalCode grants are scoped by the host to one chat and are not persisted across restart. “This session” approval never grants a command prefix automatically.

Plan/question request lifecycles and attachment ownership are architectural references; the local adapters use Electron IPC and the existing pi runtime instead of copying OpenCode's Effect/Solid framework. These adapters are original integration code, not unmodified upstream modules. Original references: `packages/opencode/src/agent/agent.ts`, `packages/opencode/src/question/index.ts`, `packages/opencode/src/tool/plan.ts`; current attachment ownership reference: `packages/app/src/composer/attachments/attachments.ts` at b6cbbd7646ec7a05945db3e7f499c9ae5af0b3d1.

## OpenAI Codex — Apache-2.0

Source: https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97.

`src/core/powershell-safety.ts` is a TypeScript adaptation of `codex-rs/shell-command/src/command_safety/powershell_tree_sitter.rs`. Original Rust source, the complete upstream JSON fixture corpus, LICENSE and NOTICE are retained in `third_party/codex/`. Adaptation differences: web-tree-sitter UTF-16 offsets instead of Rust byte offsets; bounded 64 KiB input; additionally reject NUL words and Unicode escape syntax in bare words. It parses only a conservative literal subset. Unknown grammar, parse recovery, dynamic expressions, initialization failures and unsupported forms remain opaque and require approval. No candidate command is executed during analysis.

The no-sandbox default follows `codex-rs/core/src/exec_policy_windows_tests.rs`, particularly `unmatched_powershell_read_requires_approval_without_sandbox`. A successful parse is NOT a read-only or risk classification. LocalCode does not implement a Windows OS sandbox; therefore “auto” permits controlled workspace operations and explicit session grants, while unmatched shell commands still ask. There is no invented dangerous-keyword blacklist or purported universal safe-command list. Full access is a user-selected policy, not elevated OS privileges. Plan mode disables arbitrary shell and writes regardless of approval mode.

The earlier `powershell_parser.ps1` AST process is a test oracle in this Codex revision, not its production parser, and is not shipped as LocalCode's production security implementation.

### Goals lifecycle and accounting

`src/core/goals.ts` and the goal scheduling integration in `src/main/main.ts` are original TypeScript adapters informed by Codex's `codex-rs/ext/goal/src/runtime.rs`, `accounting.rs`, `extension.rs`, and `codex-rs/state/src/runtime/goals.rs` at the same fixed SHA above. Reference copies are retained under `third_party/codex/`. The public goal lifecycle and accounting concepts are reused; this is not a literal translation of the Rust extension or its SQL storage.

Local adaptation: the selected goal budget defaults to two hours of effective running time and excludes approval waits, user questions, provider queues, retry backoff and plan mode. LocalCode uses its existing host-owned session store, process cancellation, provider scheduler and pi run-settled boundary. Its single automatic round without useful work tools stops further automatic continuation. This intentionally follows a more conservative continuation approach described in https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex and differs from the referenced Rust revision's three inactive turns. It must not be represented as a byte-for-byte port. Goal status is persisted, while an interrupted or restarted application does not silently resume paid model calls or pending approvals.

## Parser dependencies

Fixed dependencies: `web-tree-sitter@0.25.10` and `tree-sitter-powershell@0.25.10`, matching OpenCode v1.19.4. Their package licenses and WASM grammar ship with dependencies. The parser is used for literal command structure only; it is not a sandbox.

## pi SDK — MIT

Existing pinned dependencies `@earendil-works/pi-coding-agent@1.4.0` and `@earendil-works/pi-ai@1.4.0` provide provider protocol handling, `ImageContent`, session persistence and run lifecycle. The installed SDK examples `examples/extensions/plan-mode/` and docs `sdk.md` describe active-tool switching and follow-up/settled behavior. LocalCode does not copy the example Bash regex allowlist into Windows permission enforcement.

## Verification

`tests/permissions.test.ts` exercises the upstream PowerShell fixture corpus and permission-specific boundaries. `tests/attachments.test.ts` exercises immutable bytes, draft/session ownership, restart restoration, image protocol isolation, limits, path and junction rejection. These are deterministic tests; they do not establish real-model image understanding or operating-system isolation.
