import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(repo, 'scripts/acceptance');
const testBase = path.join(repo, 'LocalCode/evidence/acceptance-launcher-tests');
const windowsPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const marker = '__LOCALCODE_POLICY_RESULT__';
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

async function fixture(t, includeScript = true) {
  await fs.mkdir(testBase, { recursive: true });
  const base = await fs.realpath(testBase);
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(async () => {
    const stat = await fs.lstat(root);
    const actual = await fs.realpath(root);
    // Windows cleanup never follows a replaced link or leaves this task's prefix.
    assert(!stat.isSymbolicLink(), 'Refuse to remove a replaced fixture link');
    assert.equal(path.dirname(actual).toLowerCase(), base.toLowerCase());
    assert(path.basename(actual).startsWith('case-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const folder = path.join(root, '中文 空格检查');
  await fs.mkdir(folder);
  await fs.copyFile(path.join(source, 'Check-Environment.cmd'), path.join(folder, 'Check-Environment.cmd'));
  if (includeScript) await fs.copyFile(path.join(source, 'Check-Environment.ps1'), path.join(folder, 'Check-Environment.ps1'));
  return { folder, launcher: path.join(folder, 'Check-Environment.cmd'), script: path.join(folder, 'Check-Environment.ps1') };
}

async function runUnderRestrictedParent(f, probeScript) {
  const command = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Policy-Snapshot {
  @(Get-ExecutionPolicy -List | ForEach-Object {
    [pscustomobject]@{ scope = $_.Scope.ToString(); policy = $_.ExecutionPolicy.ToString() }
  })
}
$before = Policy-Snapshot
$managed = @($before | Where-Object { $_.scope -in @('MachinePolicy', 'UserPolicy') -and $_.policy -ne 'Undefined' }).Count -gt 0
$directBlocked = $false
$directError = ''
$exitCode = $null
$launcherOutput = ''
$beforeReportCount = 0
if (-not $managed) {
  if (${probeScript ? '$true' : '$false'}) {
    try { & ${psQuote(f.script)} }
    catch { $directBlocked = $_.Exception -is [System.Management.Automation.PSSecurityException]; $directError = $_.FullyQualifiedErrorId }
    $beforeReportCount = @(Get-ChildItem -LiteralPath ${psQuote(path.join(f.folder, 'results'))} -Filter 'environment-*.json' -ErrorAction SilentlyContinue).Count
  }
  $env:LOCALCODE_NO_PAUSE = '1'
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path $env:SystemRoot 'System32\\cmd.exe'
  $start.Arguments = '/d /s /c ""' + ${psQuote(f.launcher)} + '""'
  $start.WorkingDirectory = ${psQuote(f.folder)}
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  try {
    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $launcherOutput = $stdout.Result + $stderr.Result
  } finally { $process.Dispose() }
}
$after = Policy-Snapshot
$result = [ordered]@{ managed = $managed; before = $before; after = $after; effectiveAfter = (Get-ExecutionPolicy).ToString(); directBlocked = $directBlocked; directError = $directError; beforeReportCount = $beforeReportCount; exitCode = $exitCode; launcherOutput = $launcherOutput }
Write-Output (${psQuote(marker)} + ($result | ConvertTo-Json -Depth 6 -Compress))
`;
  // Model a native CMD launch: WinPS builds its default module path rather than
  // inheriting incompatible PS7 modules from the test runner. No persistent env changes.
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'psmodulepath') delete childEnv[key];
  // UTF-16LE is WinPS's native encoded-command transport; parent policy stays Restricted.
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const pending = execute(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', encoded], {
    cwd: f.folder, windowsHide: true, timeout: probeScript ? 60000 : 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    env: childEnv,
  });
  pending.child.stdin.end();
  const { stdout, stderr } = await pending;
  const line = stdout.split(/\r?\n/).find(item => item.startsWith(marker));
  assert(line, `Missing policy result. stderr: ${stderr}; stdout: ${stdout}`);
  return JSON.parse(line.slice(marker.length));
}

function assertPoliciesUnchanged(result) {
  const processBefore = result.before.find(item => item.scope === 'Process');
  const processAfter = result.after.find(item => item.scope === 'Process');
  assert.equal(processBefore?.policy, 'Restricted');
  assert.equal(processAfter?.policy, 'Restricted');
  assert.equal(result.effectiveAfter, 'Restricted');
  const persistent = snapshot => snapshot.filter(item => item.scope !== 'Process');
  assert.deepEqual(persistent(result.after), persistent(result.before), 'Organization and persistent execution policies must remain unchanged');
}

test('environment launcher runs from a Restricted parent in a Chinese/space path without changing policy', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const f = await fixture(t);
  const result = await runUnderRestrictedParent(f, true);
  if (result.managed) return t.skip('Organization execution policy is configured; this regression does not override it');
  assertPoliciesUnchanged(result);
  assert.equal(result.directBlocked, true, `Restricted direct-script control did not block: ${result.directError}`);
  assert.equal(result.beforeReportCount, 0, 'Blocked direct-script control must not generate a report');
  assert.equal(result.exitCode, 0, result.launcherOutput);
  const reports = (await fs.readdir(path.join(f.folder, 'results'))).filter(name => /^environment-.*\.json$/.test(name));
  assert.equal(reports.length, 1, 'Launcher must generate one real environment report at its default location');
  const report = JSON.parse((await fs.readFile(path.join(f.folder, 'results', reports[0]), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(report.schemaVersion, 1);
  assert.equal(typeof report.eligibleCleanInstall, 'boolean');
  assert.equal(report.inferenceValidation, 'UNRUN');
  assert.match(report.powershellVersion, /^5\.1\./);
});

test('environment launcher missing its checker returns nonzero without a false report or policy change', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const f = await fixture(t, false);
  const result = await runUnderRestrictedParent(f, false);
  if (result.managed) return t.skip('Organization execution policy is configured; this regression does not override it');
  assertPoliciesUnchanged(result);
  assert.equal(result.exitCode, 2, result.launcherOutput);
  await assert.rejects(fs.stat(path.join(f.folder, 'results')), { code: 'ENOENT' });
});
