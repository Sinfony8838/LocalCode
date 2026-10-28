import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export interface CommandResult { exitCode: number | null; output: string; logPath: string; cancelled: boolean; timedOut: boolean; outputLimited: boolean }
interface OwnedCommand { pid: number; workerPid?: number; encodedCommand: string; token: string; exe: string; createdAt: string }
const active = new Map<number, { child: ChildProcess; kill: () => Promise<void> }>();

// A job owns only command-process lifetime. It does NOT restrict file/network rights.
const jobCode = `using System; using System.ComponentModel; using System.Runtime.InteropServices;
public static class LocalCodeCommandJob {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic BasicLimitInformation; public Counters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr value);
 static IntPtr handle;
 public static void Attach(uint parentPid) {
  handle=CreateJobObject(IntPtr.Zero,null); if(handle==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
  var limits=new Extended(); limits.BasicLimitInformation.LimitFlags=0x2000;
  if(!SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended)))) { var err=Marshal.GetLastWin32Error(); CloseHandle(handle); throw new Win32Exception(err); }
  if(!AssignProcessToJobObject(handle,GetCurrentProcess())) { var err=Marshal.GetLastWin32Error(); CloseHandle(handle); throw new Win32Exception(err); }
  // Parent-death watchdog: waiting on the worker's process handle replaces the
  // former stdin-EOF probe. Sharing the stdin pipe handle with grandchildren
  // deadlocked CPython at interpreter shutdown (command code had already run,
  // then the process hung until the outer timeout); see
  // docs/incident-2026-10-28-python-command-deadlock.md.
  const uint SYNCHRONIZE=0x00100000, WAIT_OBJECT_0=0;
  var parent=OpenProcess(SYNCHRONIZE,false,parentPid);
  if(parent==IntPtr.Zero) { Environment.Exit(130); }
  var lifetime=new System.Threading.Thread(()=> { try { while(WaitForSingleObject(parent,5000)!=WAIT_OBJECT_0) {} CloseHandle(parent); Environment.Exit(130); } catch {} });
  lifetime.IsBackground=true; lifetime.Start();
 }
}`;
function powershellExe() { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }
/** Read-only prerequisite check; never installs a runtime or falls back to another shell. */
export async function assertPowerShellExecutable(executable: string): Promise<void> {
  try {
    if ((await fs.stat(executable)).isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`无法检查 Windows PowerShell：${executable}。请检查文件访问权限后重试；命令尚未执行。`, { cause: error });
    }
  }
  throw new Error(`未找到 Windows PowerShell 5.1：${executable}。请启用或修复 Windows 自带的 Windows PowerShell 后重试。使用云端模型不需要 Ollama，但执行终端命令仍需要此组件；命令尚未执行。`);
}
function bootstrap(command: string, token: string, readyPath: string, parentPid: number) {
  // A non-interactive process cannot accidentally wait forever at Read-Host.
  const gate = readyPath.replaceAll("'", "''");
  // The command cannot run until its PID ownership record is durable. A worker
  // crash between spawn and record creation leaves a process that times out.
  return `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)\n[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\n$OutputEncoding=[Console]::OutputEncoding\n$env:LOCALCODE_COMMAND_TOKEN='${token}'\nAdd-Type -TypeDefinition @'\n${jobCode}\n'@\n[LocalCodeCommandJob]::Attach(${parentPid})\n$deadline=[DateTime]::UtcNow.AddSeconds(15)\nwhile (-not [System.IO.File]::Exists('${gate}')) { if ([DateTime]::UtcNow -gt $deadline) { throw 'LocalCode command ownership handshake expired.' }; Start-Sleep -Milliseconds 50 }\nif ([System.IO.File]::ReadAllText('${gate}') -ne '${token}') { throw 'LocalCode command ownership handshake mismatch.' }\n[System.IO.File]::Delete('${gate}')\n$global:LASTEXITCODE=0\ntry {\n& {\n${command}\n}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nexit 0\n} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`;
}
function capture(exe: string, args: string[], timeout = 10_000): Promise<{ code: number | null; text: string; errorText: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', errorText = ''; const timer = setTimeout(() => child.kill(), timeout);
    child.stdout?.on('data', bytes => { if (text.length < 100_000) text += bytes.toString(); });
    child.stderr?.on('data', bytes => { if (errorText.length < 100_000) errorText += bytes.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, text, errorText }); });
  });
}
function abortError() { const error = new Error('操作已取消。'); error.name = 'AbortError'; return error; }
export async function executePowerShell(options: { command: string; cwd: string; dataDir: string; signal?: AbortSignal; timeoutMs?: number }): Promise<CommandResult> {
  if (options.signal?.aborted) throw abortError();
  if (process.platform !== 'win32') throw new Error('此版本的命令工具仅支持 Windows PowerShell。');
  const token = randomUUID();
  const executable = powershellExe();
  await assertPowerShellExecutable(executable);
  const logs = path.join(options.dataDir, 'logs', 'commands');
  const owned = path.join(options.dataDir, 'owned-commands');
  const temp = path.join(options.dataDir, 'temp', 'commands');
  const readyPath = path.join(owned, `${token}.ready`);
  const encodedCommand = Buffer.from(bootstrap(options.command, token, readyPath, process.pid), 'utf16le').toString('base64');
  await Promise.all([fs.mkdir(logs, { recursive: true }), fs.mkdir(owned, { recursive: true }), fs.mkdir(temp, { recursive: true })]);
  if (options.signal?.aborted) throw abortError();
  const logPath = path.join(logs, `${Date.now()}-${token}.log`);
  let spawnedError: Error | undefined;
  let stopOnLogError = () => {};
  const stream = createWriteStream(logPath, { flags: 'wx' });
  stream.on('error', error => { spawnedError = error; stopOnLogError(); });
  stream.write(`Working directory: ${options.cwd}\nCommand:\n${options.command}\n\n`);
  // stdin is deliberately closed (NUL): grandchildren must never inherit a
  // live stdin pipe handle. The previous watchdog read that pipe for parent-death
  // EOF and deadlocked CPython's interpreter shutdown on the shared handle.
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand], {
    cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TEMP: temp, TMP: temp, LOCALCODE_COMMAND_TOKEN: token },
  });
  const completion = new Promise<number | null>(resolve => {
    child.once('error', error => { spawnedError = error; });
    child.once('close', resolve);
  });
  if (!child.pid) { await completion; stream.end(); throw spawnedError ?? new Error('命令进程未能启动。'); }
  const pid = child.pid;
  const recordFile = path.join(owned, `${pid}-${token}.json`);
  const record: OwnedCommand = { pid, workerPid: process.pid, encodedCommand, token, exe: executable, createdAt: new Date().toISOString() };
  let killing: Promise<void> | undefined;
  const kill = () => killing ??= (async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // PID belongs to the retained live ChildProcess. Job close also kills descendants.
    const result = await capture(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F']).catch(() => null);
    if (result?.code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
  })();
  stopOnLogError = () => { void kill(); };
  active.set(pid, { child, kill });
  let cancelled = false, timedOut = false, outputLimited = false, observed = 0;
  let output = '';
  const maximumObserved = 8 * 1024 * 1024;
  const abort = () => { cancelled = true; void kill(); };
  const timeout = setTimeout(() => { timedOut = true; void kill(); }, Math.min(options.timeoutMs ?? 120_000, 300_000));
  options.signal?.addEventListener('abort', abort, { once: true });
  const append = (text: string) => { if (output.length < 1024 * 1024) output += text.slice(0, 1024 * 1024 - output.length); };
  const consume = (bytes: Buffer, decoder: StringDecoder) => {
    observed += bytes.length;
    if (observed <= maximumObserved) stream.write(bytes);
    append(decoder.write(bytes));
    if (observed > maximumObserved && !outputLimited) { outputLimited = true; stream.write('\n[LocalCode: output limit reached; command terminated.]\n'); void kill(); }
  };
  const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
  child.stdout?.on('data', bytes => consume(bytes, stdoutDecoder));
  child.stderr?.on('data', bytes => consume(bytes, stderrDecoder));
  child.stdout?.on('end', () => append(stdoutDecoder.end()));
  child.stderr?.on('end', () => append(stderrDecoder.end()));
  try {
    await fs.writeFile(recordFile, JSON.stringify(record), { flag: 'wx' });
    if (options.signal?.aborted) abort();
    else if (spawnedError) throw spawnedError;
    else await fs.writeFile(readyPath, token, { flag: 'wx' });
    const exitCode = await completion;
    if (spawnedError) throw spawnedError;
    if (outputLimited) output += '\n[输出超过 8MiB，命令已终止；日志保留截至限制前的输出。]';
    if (observed > 1024 * 1024) output += '\n[界面输出截断；完整观察输出见日志。]';
    return { exitCode, output, logPath, cancelled, timedOut, outputLimited };
  } catch (error) { await kill(); await completion; throw error; }
  finally {
    clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); active.delete(pid);
    await new Promise<void>(resolve => { if (stream.destroyed) resolve(); else stream.end(() => resolve()); });
    await fs.unlink(recordFile).catch(() => {});
    await fs.unlink(readyPath).catch(() => {});
  }
}
export async function killActiveCommands(): Promise<void> { await Promise.all([...active.values()].map(entry => entry.kill())); }

/** Parent/main calls this after worker crash. An exact encoded-command match fences PID reuse. */
export async function cleanupOwnedCommands(dataDir: string, workerPid?: number): Promise<void> {
  const directory = path.join(dataDir, 'owned-commands');
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of names) {
    if (!/^\d+-[a-f0-9-]+\.json$/i.test(name)) continue;
    const recordFile = path.join(directory, name);
    let record: OwnedCommand;
    try { record = JSON.parse(await fs.readFile(recordFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (workerPid !== undefined && record.workerPid !== workerPid) continue;
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !/^[A-Za-z0-9+/=]+$/.test(record.encodedCommand)) continue;
    const query = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}'; if($p) { $p | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress }`;
    const response = await capture(powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(query, 'utf16le').toString('base64')], 30_000);
    if (response.code !== 0) throw new Error(`无法核验遗留命令进程，未按未验证的 PID 终止进程。（核验退出码：${response.code ?? '超时'}）`);
    if (response.text.trim()) {
      const current = JSON.parse(response.text.trim()) as { CommandLine?: string; ExecutablePath?: string };
      if (current.CommandLine?.includes(record.encodedCommand) && current.ExecutablePath?.toLowerCase() === record.exe.toLowerCase()) {
        const killed = await capture(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(record.pid), '/T', '/F']);
        if (killed.code !== 0) throw new Error(`无法终止已验证的遗留命令进程 ${record.pid}；保留所属记录供下次清理。`);
      }
    }
    await fs.unlink(recordFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    if (/^[a-f0-9-]{36}$/i.test(record.token)) await fs.unlink(path.join(directory, `${record.token}.ready`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
