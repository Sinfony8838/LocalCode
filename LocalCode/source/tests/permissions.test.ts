import { describe, expect, it } from 'vitest';
import { evaluatePermission, evaluateRule, matchPermission, type PermissionInput } from '../src/core/permissions.js';
import { parsePowerShellCommands } from '../src/core/powershell-safety.js';
import fixtures from '../third_party/codex/codex-rs/shell-command/src/command_safety/fixtures/powershell_lowering.json';

describe('upstream permission contracts', () => {
  it('uses OpenCode ordered rules, wildcard semantics and default ask', () => {
    expect(evaluateRule('command', 'git status').action).toBe('ask');
    expect(evaluateRule('command', 'git status', [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'command', pattern: 'git status *', action: 'allow' }]).action).toBe('allow');
    expect(matchPermission('git status', 'git status *')).toBe(true);
    expect(matchPermission('C:\\project\\src\\a.ts', 'C:/project/src/*')).toBe(true);
  });
  const base: PermissionInput = { mode: 'auto', workMode: 'execute', kind: 'command', command: 'Get-Content README.md', resource: 'D:\\project', cwd: 'D:\\project', inWorkspace: true };
  it('matches Codex Windows no-sandbox contract: unmatched reads still ask', async () => {
    expect((await evaluatePermission(base)).action).toBe('ask');
    expect((await evaluatePermission({ ...base, command: 'Remove-Item -Recurse -Force .' })).action).toBe('ask');
    expect((await evaluatePermission({ ...base, command: 'Write-Output $(Remove-Item x)' })).action).toBe('ask');
  });
  it('binds session grants to exact command, working directory and operation', async () => {
    const { permissionKey } = await evaluatePermission(base);
    expect((await evaluatePermission({ ...base, grants: [permissionKey] })).action).toBe('allow');
    expect((await evaluatePermission({ ...base, grants: [permissionKey], command: 'Get-Content secrets' })).action).toBe('ask');
    expect((await evaluatePermission({ ...base, grants: [permissionKey], cwd: 'D:\\other' })).action).toBe('ask');
  });
  it('plan restrictions survive full mode and grants', async () => {
    const { permissionKey } = await evaluatePermission(base);
    expect((await evaluatePermission({ ...base, mode: 'full', workMode: 'plan', grants: [permissionKey] })).action).toBe('deny');
    expect((await evaluatePermission({ ...base, kind: 'write', mode: 'full', workMode: 'plan' })).action).toBe('deny');
    expect((await evaluatePermission({ ...base, kind: 'read', workMode: 'plan' })).action).toBe('allow');
  });
  it('allows controlled workspace writes and asks for external resources', async () => {
    expect((await evaluatePermission({ ...base, kind: 'write', mode: 'ask' })).action).toBe('allow');
    expect((await evaluatePermission({ ...base, kind: 'write', inWorkspace: false })).action).toBe('ask');
    expect((await evaluatePermission({ ...base, kind: 'read', inWorkspace: false })).action).toBe('ask');
    expect((await evaluatePermission({ ...base, kind: 'write', inWorkspace: false, mode: 'full' })).action).toBe('allow');
  });
});

describe('Codex production PowerShell lowering fixture corpus', () => {
  for (const fixture of fixtures) it(fixture.name, async () => {
    expect(await parsePowerShellCommands(fixture.script)).toEqual(fixture.expected);
  });
  it('treats excessive and malformed input as opaque', async () => {
    expect(await parsePowerShellCommands('x'.repeat(65537))).toBeNull();
    expect(await parsePowerShellCommands('echo x\0')).toBeNull();
  });
});
