import { workspaceContext } from '../src/core/workspace-context';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { executePowerShell, cleanupOwnedCommands, killActiveCommands } from '../src/core/command.js';
import { createWorkspaceTools } from '../src/agent/tools.js';

const testBase = path.resolve('tests'); const roots: string[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
async function waitFor(check: () => Promise<boolean> | boolean, maxMs = 20_000) { const end = Date.now() + maxMs; while (Date.now() < end) { if (await check()) return; await delay(100); } throw new Error('Timed out waiting for command condition'); }
afterEach(async () => {
  await killActiveCommands();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== testBase || !path.basename(root).startsWith('.command-')) throw new Error('Unexpected test cleanup target');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(testBase, '.command-')); roots.push(root);
  const projectPath = path.join(root, 'project with spaces'); const dataDir = path.join(root, 'data'); await fs.mkdir(projectPath);
  return { root, ...workspaceContext(projectPath, dataDir), cwd: projectPath, sessionId: 'commands', runId: 'run-one', maxResultChars: 400, emit: () => {} };
}
const win = describe.skipIf(process.platform !== 'win32');

describe('approval boundary', () => {
  it('never starts a denied command and displays the exact command and canonical working directory', async () => {
    const f = await fixture(); const seen: unknown[] = []; const command = "Set-Content -LiteralPath 'denied.txt' -Value 'BAD'";
    const tool = createWorkspaceTools({ ...f, requestApproval: async input => { seen.push(input); return false; } }).find(t => t.name === 'powershell')!;
    await expect(tool.execute('denied', { command }, undefined, undefined, {} as never)).rejects.toThrow(/拒绝/);
    expect(seen).toEqual([{ command, cwd: await fs.realpath(f.projectPath) }]);
    await expect(fs.stat(path.join(f.projectPath, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(f.dataDir, 'owned-commands'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('ignores approval that arrives after cancellation and rejects malformed arguments before approval', async () => {
    const f = await fixture(); const controller = new AbortController(); let approvals = 0;
    const tool = createWorkspaceTools({ ...f, requestApproval: async () => { approvals++; controller.abort(); return true; } }).find(t => t.name === 'powershell')!;
    await expect(tool.execute('late', { command: "Set-Content late.txt 'BAD'" }, controller.signal, undefined, {} as never)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(tool.execute('invalid', { command: ['invalid'] }, undefined, undefined, {} as never)).rejects.toThrow(/参数无效/);
    expect(approvals).toBe(1); expect(await fs.readdir(f.projectPath)).toEqual([]);
  });
});

win('Windows command lifecycle', () => {
  it('executes in the approved directory, logs Chinese output and propagates native exit codes', async () => {
    const f = await fixture();
    const result = await executePowerShell({ ...f, command: "[Console]::WriteLine('中文输出'); [Console]::WriteLine((Get-Location).Path); cmd.exe /c exit 7", timeoutMs: 20_000 });
    expect(result.exitCode).toBe(7); expect(result.cancelled).toBe(false); expect(result.output).toContain('中文输出'); expect(result.output).toContain(f.projectPath);
    expect(await fs.readFile(result.logPath, 'utf8')).toContain('中文输出'); expect(await fs.readdir(path.join(f.dataDir, 'owned-commands'))).toEqual([]);
  }, 30_000);

  it('retains complete observed output in the log while bounding model and UI output', async () => {
    const f = await fixture();
    const tool = createWorkspaceTools({ ...f, requestApproval: async () => true }).find(t => t.name === 'powershell')!;
    const response = await tool.execute('large-output', { command: "[Console]::Write(('x' * 1200000)); [Console]::Write('OUTPUT-END')" }, undefined, undefined, {} as never);
    const text = (response.content[0] as { text: string }).text;
    const details = response.details as { fullOutput: string; logPath: string };
    expect(text.length).toBeLessThanOrEqual(f.maxResultChars); expect(text).toContain('截断');
    expect(details.fullOutput.length).toBeLessThanOrEqual(1024 * 1024);
    const log = await fs.readFile(details.logPath, 'utf8'); expect(log).toContain('x'.repeat(1200000) + 'OUTPUT-END');
  }, 30_000);

  it('terminates the approved PowerShell process and its child on cancellation', async () => {
    const f = await fixture(); const controller = new AbortController();
    const task = executePowerShell({ ...f, signal: controller.signal, timeoutMs: 40_000, command: "$child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120' -PassThru -WindowStyle Hidden; [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'child.pid'), [string]$child.Id); Start-Sleep -Seconds 120" });
    const marker = path.join(f.projectPath, 'child.pid');
    try {
      await waitFor(async () => Boolean(await fs.stat(marker).catch(() => false)));
      const childPid = Number(await fs.readFile(marker, 'utf8')); expect(alive(childPid)).toBe(true);
      const recordName = (await fs.readdir(path.join(f.dataDir, 'owned-commands')))[0]; const record = JSON.parse(await fs.readFile(path.join(f.dataDir, 'owned-commands', recordName), 'utf8'));
      expect(alive(record.pid)).toBe(true); controller.abort(); const result = await task;
      expect(result.cancelled).toBe(true); await waitFor(() => !alive(childPid) && !alive(record.pid));
      expect(await fs.readdir(path.join(f.dataDir, 'owned-commands'))).toEqual([]);
    } finally { controller.abort(); await task.catch(() => {}); }
  }, 60_000);

  it('kills descendants when the approved parent exits normally and cancels a timed-out command', async () => {
    const f = await fixture();
    const result = await executePowerShell({ ...f, timeoutMs: 20_000, command: "$child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120' -PassThru -WindowStyle Hidden; [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'child.pid'), [string]$child.Id)" });
    expect(result.exitCode).toBe(0); const childPid = Number(await fs.readFile(path.join(f.projectPath, 'child.pid'), 'utf8'));
    await waitFor(() => !alive(childPid));
    const timed = await executePowerShell({ ...f, command: 'Start-Sleep -Seconds 120', timeoutMs: 1500 });
    expect(timed.timedOut).toBe(true); expect(timed.cancelled).toBe(false);
  }, 40_000);

  it('refuses PID reuse cleanup and treats a missing owned-command directory as a no-op', async () => {
    const f = await fixture(); await cleanupOwnedCommands(f.dataDir);
    const owned = path.join(f.dataDir, 'owned-commands'); await fs.mkdir(owned, { recursive: true });
    await fs.writeFile(path.join(owned, `${process.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json`), JSON.stringify({ pid: process.pid, encodedCommand: Buffer.from('not this process', 'utf16le').toString('base64'), token: 'fake', exe: process.execPath, createdAt: new Date().toISOString() }));
    await cleanupOwnedCommands(f.dataDir); expect(alive(process.pid)).toBe(true); expect(await fs.readdir(owned)).toEqual([]);
  }, 45_000);

  it('cleans up an exact owned process record after a simulated worker failure', async () => {
    const f = await fixture(); const controller = new AbortController();
    const task = executePowerShell({ ...f, signal: controller.signal, timeoutMs: 40_000, command: "$child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120' -PassThru -WindowStyle Hidden; [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'child.pid'), [string]$child.Id); Start-Sleep -Seconds 120" });
    const marker = path.join(f.projectPath, 'child.pid');
    try {
      await waitFor(async () => Boolean(await fs.stat(marker).catch(() => false)));
      const childPid = Number(await fs.readFile(marker, 'utf8'));
      await cleanupOwnedCommands(f.dataDir);
      await task; await waitFor(() => !alive(childPid));
      expect(await fs.readdir(path.join(f.dataDir, 'owned-commands'))).toEqual([]);
    } finally { controller.abort(); await task.catch(() => {}); }
  }, 60_000);

  it('terminates the command tree when its owning worker process crashes', async () => {
    const f = await fixture(); const workerFile = path.join(f.root, 'crash-worker.mjs');
    const command = "$child=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120' -PassThru -WindowStyle Hidden; [System.IO.File]::WriteAllText((Join-Path (Get-Location) 'child.pid'), [string]$child.Id); Start-Sleep -Seconds 120";
    const moduleUrl = pathToFileURL(path.resolve('src/core/command.ts')).href;
    await fs.writeFile(workerFile, `import { executePowerShell } from ${JSON.stringify(moduleUrl)}; await executePowerShell(${JSON.stringify({ command, cwd: f.cwd, dataDir: f.dataDir, timeoutMs: 60_000 })});`);
    const worker = spawn(process.execPath, [workerFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorOutput = ''; worker.stderr.on('data', bytes => { errorOutput += bytes.toString(); });
    const exited = new Promise<void>((resolve, reject) => { worker.once('error', reject); worker.once('close', () => resolve()); });
    try {
      const marker = path.join(f.projectPath, 'child.pid');
      await waitFor(async () => {
        if (worker.exitCode !== null) throw new Error(`Worker exited before command started: ${errorOutput}`);
        return Boolean(await fs.stat(marker).catch(() => false));
      });
      const childPid = Number(await fs.readFile(marker, 'utf8'));
      const records = (await fs.readdir(path.join(f.dataDir, 'owned-commands'))).filter(name => name.endsWith('.json'));
      const record = JSON.parse(await fs.readFile(path.join(f.dataDir, 'owned-commands', records[0]), 'utf8'));
      worker.kill(); await exited;
      // No cleanup call is involved here: pipe EOF closes the command's job.
      await waitFor(() => !alive(record.pid) && !alive(childPid), 10_000);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill();
      await exited; await cleanupOwnedCommands(f.dataDir);
    }
  }, 60_000);
});
