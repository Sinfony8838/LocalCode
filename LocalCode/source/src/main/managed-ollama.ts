import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ManagedServiceState } from './local-model-health';
const execute = promisify(execFile);
const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ollamaRoot = (home: string) => path.resolve(home, '../Ollama');

/** Fail closed: a listening loopback port does not prove this installation owns it. */
export async function managedOllamaState(home: string): Promise<ManagedServiceState> {
  const root = ollamaRoot(home);
  const executable = path.join(root, 'runtime', 'ollama.exe');
  try { await fs.access(executable); } catch { return 'missing_runtime'; }
  if (process.platform !== 'win32') return 'unverified';
  let pid: string;
  try { pid = (await fs.readFile(path.join(root, 'logs', 'server.pid'), 'utf8')).trim(); } catch { return 'stopped'; }
  if (!/^[1-9][0-9]{0,9}$/.test(pid)) return 'unverified';
  try {
    const result = await execute(powershell(), ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $p=Get-Process -Id ([int]$env:LOCALCODE_INSPECT_PID) -ErrorAction SilentlyContinue; if (-not $p) { Write-Output 'stopped'; exit }; if ($p.Path -ne $env:LOCALCODE_INSPECT_EXE) { Write-Output 'unverified'; exit }; $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 11434 -ErrorAction SilentlyContinue); if ($listeners.Count -gt 0 -and @($listeners | Where-Object { $_.OwningProcess -ne $p.Id }).Count -eq 0) { Write-Output 'ready' } else { Write-Output 'unverified' }"],
      { windowsHide: true, timeout: 4000, maxBuffer: 4096, env: { ...process.env, LOCALCODE_INSPECT_PID: pid, LOCALCODE_INSPECT_EXE: executable } });
    const state = result.stdout.trim();
    return state === 'ready' || state === 'stopped' ? state : 'unverified';
  } catch { return 'unverified'; }
}

/** Only an explicitly clicked action may start the bundled, already-installed service. */
export async function startManagedOllama(home: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('本套 Ollama 启动器仅支持 Windows。已有服务请显式选择“已有 Ollama”。');
  const root = ollamaRoot(home);
  try { await fs.access(path.join(root, 'runtime', 'ollama.exe')); await fs.access(path.join(root, 'Start.ps1')); }
  catch { throw new Error('本套 Ollama 尚未安装。请运行 Install-LocalModel.cmd（便携版）或 Setup.cmd（源码版）；未下载任何内容。'); }
  try {
    await execute(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'Start.ps1')], { windowsHide: true, cwd: root, timeout: 60000, maxBuffer: 16384 });
  } catch { throw new Error('本套 Ollama 未能启动。请检查 Ollama/logs；端口可能被其他服务占用，未主动停止或复用其他服务。'); }
}
