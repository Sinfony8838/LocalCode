"""Scan exact Git index blobs. Never print matching secret values."""
import argparse
import hashlib
import json
from pathlib import PurePosixPath
import re
import subprocess
import sys

BLOCKED_DIRS = {'node_modules', 'dist', 'data', 'cache', 'logs', 'evidence', 'app', 'models', 'runtime', 'profile', 'temp', 'downloads', 'tools', '.aws', '.ssh', '.codex', '.agents', 'test-results', 'playwright-report'}
ALLOWED_SUFFIXES = {'.md', '.py', '.ts', '.tsx', '.mjs', '.json', '.css', '.html', '.ps1', '.cmd', '.yml', '.yaml'}
ALLOWED_NAMES = {'LICENSE', '.gitignore', '.gitattributes', '.npmrc'}
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
    if mode != '100644' and mode != '100755':
        issues.append('symlink-or-submodule')
    if any(p.lower() in BLOCKED_DIRS for p in path.parts):
        issues.append('runtime-or-private-directory')
    if path.name.startswith('.env') or (path.suffix not in ALLOWED_SUFFIXES and path.name not in ALLOWED_NAMES):
        issues.append('unapproved-file-type')
    if len(content) > 2 * 1024 * 1024 or b'\x00' in content:
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
