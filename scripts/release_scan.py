"""Scan exact Git index blobs. Never print matching secret values."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

BLOCKED_DIRS = {'node_modules', 'dist', 'data', 'cache', 'logs', 'evidence', 'app', 'models', 'runtime', 'profile', 'temp', 'downloads', 'tools', '.aws', '.ssh', '.codex', '.agents', 'test-results', 'playwright-report'}
ALLOWED_SUFFIXES = {'.md', '.py', '.ts', '.tsx', '.mjs', '.json', '.css', '.html', '.ps1', '.cmd', '.yml', '.yaml'}
ALLOWED_NAMES = {'LICENSE', '.gitignore', '.gitattributes', '.npmrc'}
# Only these reviewed branding bytes may bypass the file-type/NUL checks.
# Directory, Git mode, size and credential rules still apply to every asset.
ALLOWED_BINARY_ASSETS = {
    'LocalCode/source/src/renderer/public/branding/localcode-logo.png': '5e0f8b5d2889191806db2f137f947c8d2d092c43d63098a6348ec0809eec5b2e',
    'LocalCode/source/src/renderer/public/branding/localcode.ico': 'b0e41b7046c2b029e9f5d402c2ebf8ad3edf99fd6bb50526438ba852e91934b0',
}
ALLOWED_REFERENCE_SOURCES = {
    "LocalCode/source/third_party/codex/codex-rs/core/src/exec_policy_windows_tests.rs": "b64307cf24195b7cf0cede0d4a8112383e714c9e837143801219235c14fbfe17",
    "LocalCode/source/third_party/codex/codex-rs/ext/goal/src/accounting.rs": "949c44b911bb7eeb7867e78770a7597b23d3bd9afe7b4dede631f783b2c97aeb",
    "LocalCode/source/third_party/codex/codex-rs/ext/goal/src/extension.rs": "649d840b4bdfb318b31ade690733e585c85babbc40f103183aadffd367fe1c26",
    "LocalCode/source/third_party/codex/codex-rs/ext/goal/src/runtime.rs": "c25b96e72b7aa629bfeac6186314585771fa89d5bd9d2c92ec642c9f11bbb46e",
    "LocalCode/source/third_party/codex/codex-rs/shell-command/src/command_safety/fixtures/powershell_lowering.json": "6be1395e41fa38bb5e2ba49f4e3a1e10fbe57e0e809ce688601af734f7a24936",
    "LocalCode/source/third_party/codex/codex-rs/shell-command/src/command_safety/powershell_tree_sitter.rs": "5fe2634f123641c5a44c56f326d0c399ee7edb8962c0b075b98e423a529a4ecf",
    "LocalCode/source/third_party/codex/codex-rs/state/src/runtime/goals.rs": "2e3e7de1f1a67b8eb51e388a83cb91b6020d5156b4da6f9a305c7d83858cadfd",
    "LocalCode/source/third_party/codex/LICENSE": "fada9cda895b67af092f74f75ba23230e8d4eeef3d06af394a1dc79093d10787",
    "LocalCode/source/third_party/codex/NOTICE": "8b6db9c66bc81dba23ba1e4cd255bf9f2a1f799f532d97c1ef310f5e379407d7",
    "LocalCode/source/third_party/opencode/LICENSE": "d1a549bbb600032e0184f9e874d4d96cd951f26dcce6dbf1e1313c819a231dac",
    "LocalCode/source/third_party/opencode/packages/core/src/util/wildcard.ts": "965e902e2a3e01fa71a8847a37b6a86ca1301a27d5830e33ab67cd2a4473d3b2",
    "LocalCode/source/third_party/opencode/packages/opencode/src/permission/index.ts": "b152062772126727ec18cffb52702c4029ea8367a4fb31095798b6e3e61a4857"
}
PATTERNS = {
    'private-key': re.compile(rb'-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----'),
    'github-token': re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})'),
    'api-token': re.compile(rb'\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}'),
    'aws-access-key': re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    'slack-token': re.compile(rb'\bxox[baprs]-[A-Za-z0-9-]{20,}'),
    'credential-url': re.compile(rb'https?://[^\s/:"\']{2,}:[^\s/@"\']{8,}@'),
    'literal-credential': re.compile(rb'''(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']([A-Za-z0-9_+/=-]{24,})["']'''),
}

def inspect(name, mode, content, private_values=()):
    issues = []
    path = PurePosixPath(name)
    approved_binary = ALLOWED_BINARY_ASSETS.get(name) == hashlib.sha256(content).hexdigest()
    approved_reference = ALLOWED_REFERENCE_SOURCES.get(name) == hashlib.sha256(content).hexdigest()
    if mode != '100644' and mode != '100755':
        issues.append('symlink-or-submodule')
    if any(p.lower() in BLOCKED_DIRS for p in path.parts) and not approved_reference:
        issues.append('runtime-or-private-directory')
    if path.name.startswith('.env') or (not approved_binary and not approved_reference and path.suffix not in ALLOWED_SUFFIXES and path.name not in ALLOWED_NAMES):
        issues.append('unapproved-file-type')
    if len(content) > 2 * 1024 * 1024 or (not approved_binary and b'\x00' in content):
        issues.append('oversized-or-binary')
    for rule, pattern in PATTERNS.items():
        for match in pattern.finditer(content):
            # Explicit synthetic test strings; actual stored credentials are checked separately.
            value = match.group(1) if rule == 'literal-credential' else match.group()
            if rule == 'literal-credential' and any(x in value.lower() for x in [b'fixture', b'not-real', b'not_a_real', b'mock']):
                continue
            issues.append(rule)
            break
    if any(value in content for value in private_values):
        issues.append('matches-private-credential-or-ciphertext')
    return sorted(set(issues))

def git(*args):
    return subprocess.check_output(['git', *args])

def self_test():
    assert inspect('LocalCode/data/index.json', '100644', b'{}')
    assert inspect('.env', '100644', b'hello')
    assert inspect('src/link.ts', '120000', b'target')
    for value in [b'ghp_' + b'A' * 36, b'sk-' + b'A' * 32, b'AKIA' + b'A' * 16, b'-----BEGIN ' + b'PRIVATE KEY-----', b'apiKey: "' + b'A' * 32 + b'"']:
        assert inspect('src/test.ts', '100644', value)
    assert inspect('src/test.ts', '100644', b'stored-ciphertext', [b'stored-ciphertext'])
    assert not inspect('src/test.ts', '100644', b'const apiKey = input.apiKey;')
    assert not inspect('tests/mock.ts', '100644', b'apiKey: "provider-fixture-secret-NOT-A-REAL-KEY"')
    root = Path(__file__).resolve().parent.parent
    for name, digest in ALLOWED_BINARY_ASSETS.items():
        content = (root / name).read_bytes()
        assert hashlib.sha256(content).hexdigest() == digest
        assert not inspect(name, '100644', content)
        assert 'unapproved-file-type' in inspect(name, '100644', content + b'changed')
        assert 'oversized-or-binary' in inspect(name, '100644', content + b'changed')
        assert 'unapproved-file-type' in inspect('src/' + PurePosixPath(name).name, '100644', content)
        assert 'symlink-or-submodule' in inspect(name, '120000', content)
        assert 'runtime-or-private-directory' in inspect('LocalCode/data/' + PurePosixPath(name).name, '100644', content)
        assert 'matches-private-credential-or-ciphertext' in inspect(name, '100644', content, [content[:32]])
        assert 'oversized-or-binary' in inspect(name, '100644', content + b'\x00' * (2 * 1024 * 1024))
    print('Scanner self-test: PASS (positive and negative controls)')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--compare-private-index', help='Optional local application index; values are never printed')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    private_values = []
    if args.compare_private_index:
        with open(args.compare_private_index, encoding='utf-8-sig') as f:
            index = json.load(f)
        private_values = [v.encode() for v in index.get('keys', {}).values() if isinstance(v, str) and len(v) >= 6]
    entries = git('ls-files', '--stage', '-z').split(b'\0')
    manifest, failures = [], []
    for entry in filter(None, entries):
        meta, raw_name = entry.split(b'\t', 1)
        mode, oid, stage = meta.decode().split()
        name = raw_name.decode('utf-8')
        if stage != '0':
            failures.append({'path': name, 'rules': ['unmerged-index']})
            continue
        content = git('cat-file', 'blob', oid)
        issues = inspect(name, mode, content, private_values)
        if issues:
            failures.append({'path': name, 'rules': issues})
        manifest.append((name, hashlib.sha256(content).hexdigest()))
    if not manifest:
        failures.append({'path': '.', 'rules': ['empty-index']})
    digest = hashlib.sha256(json.dumps(sorted(manifest), separators=(',', ':')).encode()).hexdigest()
    print(json.dumps({'status': 'FAIL' if failures else 'PASS', 'stagedFiles': len(manifest), 'manifestSha256': digest, 'comparedPrivateValues': len(private_values), 'failures': failures}, indent=2))
    sys.exit(bool(failures))

if __name__ == '__main__':
    main()
