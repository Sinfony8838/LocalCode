import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPowerShellExecutable, executePowerShell } from '../src/core/command';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('tests/.command-environment-'));
  roots.push(root); return root;
}

describe('PowerShell prerequisite diagnostics', () => {
  it('explains a missing runtime without creating files or suggesting Ollama for cloud commands', async () => {
    const root = await fixture(); const executable = path.join(root, 'powershell.exe');
    await expect(assertPowerShellExecutable(executable)).rejects.toThrow(/未找到 Windows PowerShell 5\.1/);
    await expect(assertPowerShellExecutable(executable)).rejects.toThrow(/启用或修复/);
    await expect(assertPowerShellExecutable(executable)).rejects.toThrow(/使用云端模型不需要 Ollama/);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('accepts a regular file without executing it and rejects a directory at the executable path', async () => {
    const root = await fixture(); const executable = path.join(root, 'powershell.exe');
    await fs.writeFile(executable, 'fixture only, never executed');
    await expect(assertPowerShellExecutable(executable)).resolves.toBeUndefined();
    await expect(assertPowerShellExecutable(root)).rejects.toThrow(/命令尚未执行/);
  });

  it('keeps permission failures distinct from a missing runtime', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(error);
    await expect(assertPowerShellExecutable('powershell.exe')).rejects.toMatchObject({
      message: expect.stringContaining('请检查文件访问权限'), cause: error,
    });
  });

  it.skipIf(process.platform === 'win32')('reports unsupported platforms before creating command state', async () => {
    const root = await fixture();
    await expect(executePowerShell({ cwd: root, dataDir: path.join(root, 'data'), command: 'must not run' })).rejects.toThrow(/仅支持 Windows PowerShell/);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
