import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ access: vi.fn(), readFile: vi.fn(), execute: vi.fn() }));
vi.mock('node:fs/promises', () => ({ default: { access: mocks.access, readFile: mocks.readFile } }));
vi.mock('node:util', () => ({ promisify: () => mocks.execute }));
import { managedOllamaState, startManagedOllama } from '../src/main/managed-ollama';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const home = path.resolve('/fixture/LocalCode');
beforeEach(() => {
  vi.resetAllMocks(); Object.defineProperty(process, 'platform', { value: 'win32' });
  mocks.access.mockResolvedValue(undefined); mocks.readFile.mockResolvedValue('1234'); mocks.execute.mockResolvedValue({ stdout: 'ready\n' });
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });
describe('explicit managed Ollama ownership and start', () => {
  it('does not inspect or launch a missing runtime', async () => {
    mocks.access.mockRejectedValue(new Error('missing'));
    expect(await managedOllamaState(home)).toBe('missing_runtime');
    await expect(startManagedOllama(home)).rejects.toThrow('Install-LocalModel.cmd');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('rejects malformed PID input before any process inspection', async () => {
    for (const pid of ['1; start-process evil', '-5', '', '999999999999999999999']) {
      mocks.readFile.mockResolvedValue(pid);
      expect(await managedOllamaState(home)).toBe('unverified');
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('checks executable and listener ownership in a bounded read-only subprocess', async () => {
    expect(await managedOllamaState(home)).toBe('ready');
    const [executable, args, options] = mocks.execute.mock.calls[0];
    expect(executable).toContain('powershell.exe');
    expect(args.at(-1)).toContain('Get-Process'); expect(args.at(-1)).toContain('Get-NetTCPConnection');
    expect(args.at(-1)).not.toMatch(/Start-Process|Stop-Process/);
    expect(options).toMatchObject({ timeout: 4000, maxBuffer: 4096, env: expect.objectContaining({ LOCALCODE_INSPECT_PID: '1234', LOCALCODE_INSPECT_EXE: path.resolve(home, '../Ollama/runtime/ollama.exe') }) });
    mocks.execute.mockResolvedValue({ stdout: 'some untrusted result' }); expect(await managedOllamaState(home)).toBe('unverified');
    mocks.execute.mockRejectedValue(new Error('private process data')); expect(await managedOllamaState(home)).toBe('unverified');
  });
  it('starts only the fixed bundled script, never an inherited override or shell string', async () => {
    vi.stubEnv('LOCALCODE_OLLAMA_START', '/untrusted/override.ps1');
    await startManagedOllama(home);
    const [, args, options] = mocks.execute.mock.calls[0];
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(home, '../Ollama/Start.ps1')]);
    expect(options).toMatchObject({ timeout: 60000, maxBuffer: 16384, cwd: path.resolve(home, '../Ollama') });
    expect(options.shell).toBeUndefined();
    mocks.execute.mockRejectedValue(new Error('private server error'));
    await expect(startManagedOllama(home)).rejects.toThrow('未主动停止或复用其他服务');
  });
  it('never launches a Windows service on another platform', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(await managedOllamaState(home)).toBe('unverified');
    await expect(startManagedOllama(home)).rejects.toThrow('仅支持 Windows');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
