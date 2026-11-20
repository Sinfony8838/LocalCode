import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, 'bin', 'logpulse.js');

// The CLI must answer within the CI watchdog budget; 10 s is generous.
const BUDGET_MS = 10_000;

function runCli(args, { env = {}, input = '' } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ timedOut: true, code: null, stdout: stdout.join(''), stderr: stderr.join('') });
    }, BUDGET_MS);
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code, stdout: stdout.join(''), stderr: stderr.join('') });
    });
  });
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logpulse-report-'));
}

test('report writes a JSON summary for a fresh target', async () => {
  const dir = scratch();
  const target = path.join(dir, 'report.json');
  const result = await runCli(['report', '--out', target]);
  assert.equal(result.timedOut, false, 'report must not hang for a fresh target');
  assert.equal(result.code, 0);
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(parsed.files, 5);
  assert.equal(parsed.logNames.length, 5);
  assert.ok(parsed.totalBytes > 0);
});

// CI-GUIDE contract: non-interactive contexts must fail fast with exit 2.
test('report exits 2 in non-interactive contexts when the target exists', async () => {
  const dir = scratch();
  const target = path.join(dir, 'report.json');
  fs.writeFileSync(target, '{}\n');
  const started = Date.now();
  const result = await runCli(['report', '--out', target]);
  assert.equal(result.timedOut, false, 'non-interactive report must not wait on stdin');
  assert.equal(result.code, 2, `expected exit 2, got ${result.code}: ${result.stderr}`);
  assert.ok(result.stderr.includes('non-interactive'), `stderr must mention non-interactive: ${result.stderr}`);
  assert.ok(Date.now() - started < BUDGET_MS);
});

// CI-GUIDE contract: piped stdin is never a confirmation in CI.
test('report ignores piped stdin confirmation', async () => {
  const dir = scratch();
  const target = path.join(dir, 'report.json');
  fs.writeFileSync(target, '{}\n');
  const result = await runCli(['report', '--out', target], { input: 'y\n' });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 2, `piped y must not confirm; got exit ${result.code}`);
  assert.ok(result.stderr.includes('non-interactive'));
});
