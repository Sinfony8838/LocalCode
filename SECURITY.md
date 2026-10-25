# Security and privacy

LocalCode is a desktop coding agent, not an operating-system sandbox. Review changes and maintain independent backups before using it on valuable projects.

- File tools can modify project files directly. Path, symlink, hard-link, protected-path and size checks reduce accidental traversal; they do not constrain approved terminal commands.
- Project file operations, discovery, previews and run snapshots exclude this installation's application `data`, `cache` and `logs` directories, including aliases. These directories and their descendants cannot be selected as projects. A containing project is allowed with those subdirectories excluded. Multi-link files are refused by ordinary file I/O.
- Changes, undo and explicit checkpoints use the session's registered project root. Stored paths are consistency evidence only. A mismatched or unsafe legacy journal remains on disk and the affected operation is refused; opening settings and the explicit data-folder action remain available. Back up and investigate such records rather than clearing history.
- Each terminal command requires approval and runs with the current Windows user's permissions. Read the entire command, including network operations and child processes. Commands may access other directories, credentials or services available to your account.
- A local model does not make a malicious prompt or repository safe. Treat repository text and model suggestions as untrusted. Do not open sensitive credentials in an agent workspace.
- Local inference binds to `127.0.0.1:11434`, disables Ollama cloud features and does not configure firewall exceptions, startup services or global PATH changes. Loopback has no authentication: other local programs can access it. Do not expose it to a LAN or the internet without an independently secured gateway.
- Cloud providers are optional and user-configured. Prompts, source excerpts, tool output and reasoning may be sent to the selected provider. Explicit connection tests can consume quota. Never paste an API key into a conversation.
- Provider keys use Windows-backed Electron `safeStorage`. Renderer IPC returns only key status. Encryption does not make ciphertext public: keep the complete application data directory, Chromium encryption metadata, logs and backups private. Same-account malware is outside this protection.
- Conversations, snapshots and terminal output are stored locally without full-disk encryption provided by this application. Use OS access controls and disk encryption where needed. Redaction is best effort and cannot recognize arbitrary secrets in project files or command output.
- Different conversations isolate workers and approvals but share project files. Concurrent edits can conflict. File-tool undo does not cover every terminal-side change.
- Setup downloads executable code and model weights from upstream. Runtime archives are pinned by SHA-256; npm uses the lockfile integrity fields. Model registry tags remain mutable. Use `scripts/Verify.ps1` to inspect installed model digests and retain your own acceptance records.
- Dependency installation runs npm lifecycle scripts. Review the lockfile, advisories and upstream changes before updating dependencies. Do not add unknown plugins or automatic command approval.

## Publishing checklist

Publish only staged, reviewed source. Run `python scripts/release_scan.py --self-test` and `python scripts/release_scan.py`. Also use a dedicated secret scanner and dependency audit. Do not bypass a failing check. Never commit `.env`, credentials, encrypted API keys, model weights, browser profiles, logs, sessions, source snapshots or prior release archives. `.gitignore` does not remove an already committed file.

Report suspected vulnerabilities privately through GitHub's private vulnerability reporting when available; otherwise contact the maintainer through their public GitHub profile without including the secret. Do not open an issue containing a key. If a credential is exposed, revoke or rotate it first; deleting a file from the latest commit does not remove Git history or copies.
