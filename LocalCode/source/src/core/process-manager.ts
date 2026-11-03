import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assertPowerShellExecutable } from './command.js';

export interface BackgroundProcessInfo {
  id: string;
  sessionId: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  running: boolean;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

interface ManagedBackgroundProcess {
  id: string;
  sessionId: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcess;
  running: boolean;
  exitCode: number | null;
  buffer: string;
  truncated: boolean;
  kill: () => Promise<void>;
}

const MAX_BUFFER_CHARS = 64 * 1024;
const MAX_CONCURRENT_PER_SESSION = 3;
const processes = new Map<string, ManagedBackgroundProcess>();

function powershellExe(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function appendRingBuffer(entry: ManagedBackgroundProcess, chunk: string): void {
  if (!chunk) return;
  const combined = entry.buffer + chunk;
  if (combined.length > MAX_BUFFER_CHARS) {
    entry.buffer = combined.slice(combined.length - MAX_BUFFER_CHARS);
    entry.truncated = true;
  } else {
    entry.buffer = combined;
  }
}

export async function startBackgroundCommand(options: {
  sessionId: string;
  command: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<BackgroundProcessInfo> {
  if (options.signal?.aborted) {
    const err = new Error('操作已取消。');
    err.name = 'AbortError';
    throw err;
  }
  if (process.platform !== 'win32') {
    throw new Error('此版本的命令工具仅支持 Windows PowerShell。');
  }
  const activeCount = [...processes.values()].filter(p => p.sessionId === options.sessionId && p.running).length;
  if (activeCount >= MAX_CONCURRENT_PER_SESSION) {
    throw new Error(`当前会话后台进程已达上限（最多 ${MAX_CONCURRENT_PER_SESSION} 个），请先停止已有后台进程。`);
  }
  const executable = powershellExe();
  await assertPowerShellExecutable(executable);
  const script = `$ErrorActionPreference='Continue'\n$ProgressPreference='SilentlyContinue'\ntry { [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding } catch {}\n${options.command}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.pid) {
    throw new Error('命令进程未能启动。');
  }
  const id = `bg-${randomUUID().slice(0, 8)}`;
  const pid = child.pid;
  let killing: Promise<void> | undefined;
  const kill = () => killing ??= new Promise<void>(resolve => {
    if (!entry.running && child.exitCode !== null) {
      resolve();
      return;
    }
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {
      try { child.kill(); } catch { /* ignore */ }
      resolve();
    });
    killer.on('close', () => {
      try { if (child.exitCode === null) child.kill(); } catch { /* ignore */ }
      entry.running = false;
      resolve();
    });
  });

  const entry: ManagedBackgroundProcess = {
    id,
    sessionId: options.sessionId,
    pid,
    command: options.command,
    cwd: options.cwd,
    startedAt: new Date().toISOString(),
    child,
    running: true,
    exitCode: null,
    buffer: '',
    truncated: false,
    kill,
  };

  const outDecoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');
  child.stdout?.on('data', (bytes: Buffer) => appendRingBuffer(entry, outDecoder.write(bytes)));
  child.stderr?.on('data', (bytes: Buffer) => appendRingBuffer(entry, errDecoder.write(bytes)));
  child.stdout?.on('end', () => appendRingBuffer(entry, outDecoder.end()));
  child.stderr?.on('end', () => appendRingBuffer(entry, errDecoder.end()));
  child.on('close', code => {
    entry.running = false;
    entry.exitCode = code;
  });

  processes.set(id, entry);
  return toProcessInfo(entry);
}

function toProcessInfo(entry: ManagedBackgroundProcess): BackgroundProcessInfo {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    pid: entry.pid,
    command: entry.command,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
    running: entry.running,
    exitCode: entry.exitCode,
    output: entry.buffer,
    truncated: entry.truncated,
  };
}

export function pollBackgroundProcess(sessionId: string, processId: string): BackgroundProcessInfo {
  const entry = processes.get(processId);
  if (!entry || entry.sessionId !== sessionId) {
    throw new Error(`未找到后台进程 ${processId}。`);
  }
  return toProcessInfo(entry);
}

export async function stopBackgroundProcess(sessionId: string, processId: string): Promise<BackgroundProcessInfo> {
  const entry = processes.get(processId);
  if (!entry || entry.sessionId !== sessionId) {
    throw new Error(`未找到后台进程 ${processId}。`);
  }
  await entry.kill();
  const info = toProcessInfo(entry);
  processes.delete(processId);
  return info;
}

export async function killSessionBackgroundProcesses(sessionId: string): Promise<void> {
  const matching = [...processes.values()].filter(p => p.sessionId === sessionId);
  await Promise.all(matching.map(async entry => {
    await entry.kill();
    processes.delete(entry.id);
  }));
}

export async function killAllBackgroundProcesses(): Promise<void> {
  const all = [...processes.values()];
  processes.clear();
  await Promise.all(all.map(entry => entry.kill()));
}
