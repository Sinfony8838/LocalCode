/** Adapted from OpenCode v1.19.4 permission/index.ts and util/wildcard.ts (MIT).
 * See THIRD_PARTY_NOTICES.md. LocalCode keeps grants session-local and exact.
 */
import { createHash } from 'node:crypto';
import type { ApprovalMode, WorkMode } from '../shared/contracts.js';
import { parsePowerShellCommands } from './powershell-safety.js';

export type PermissionAction = 'allow' | 'ask' | 'deny';
export interface PermissionRule { permission: string; pattern: string; action: PermissionAction }
export function matchPermission(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/');
  let escaped = pattern.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?';
  return new RegExp('^' + escaped + '$', process.platform === 'win32' ? 'si' : 's').test(normalized);
}
/** Upstream rule precedence: last matching rule wins; unknown actions ask. */
export function evaluateRule(permission: string, pattern: string, ...rulesets: PermissionRule[][]): PermissionRule {
  const rules = rulesets.flat();
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (matchPermission(permission, rule.permission) && matchPermission(pattern, rule.pattern)) return rule;
  }
  return { permission, pattern: '*', action: 'ask' };
}
export interface PermissionInput {
  mode: ApprovalMode; workMode: WorkMode; kind: 'read' | 'write' | 'command';
  resource: string; cwd: string; command?: string; inWorkspace: boolean; grants?: string[];
  /** Host-owned explicit rules only. Never populate from model or project content. */
  rules?: PermissionRule[];
}
export interface PermissionDecision { action: PermissionAction; permissionKey: string; reason?: string; commands?: string[][] }
export async function evaluatePermission(input: PermissionInput): Promise<PermissionDecision> {
  const permissionKey = createHash('sha256').update(JSON.stringify([input.kind, input.resource, input.cwd, input.command ?? ''])).digest('hex');
  const result = (action: PermissionAction, reason?: string): PermissionDecision => ({ action, permissionKey, reason });
  if (input.workMode === 'plan' && input.kind !== 'read') return result('deny', '计划模式仅提供受控读取、搜索和问答，请先切换执行模式。');
  if (input.mode === 'full') return result('allow');
  if (input.grants?.includes(permissionKey)) return result('allow');
  if (input.kind !== 'command') return result(input.inWorkspace ? 'allow' : 'ask', input.inWorkspace ? undefined : '该操作访问所选项目之外的文件。');
  if (input.mode === 'ask') return result('ask', '请求批准模式下终端命令需要批准。');
  const commands = await parsePowerShellCommands(input.command ?? '');
  if (!commands) return result('ask', '命令包含动态或无法完整解析的 PowerShell 语法，需要批准。');
  const decisions = commands.map(command => evaluateRule('command', command.join(' '), input.rules ?? []));
  const action = decisions.some(rule => rule.action === 'deny') ? 'deny' : decisions.every(rule => rule.action === 'allow') ? 'allow' : 'ask';
  // Codex exec_policy_windows_tests::unmatched_powershell_read_requires_approval_without_sandbox.
  // Parsing does not prove safety. There is no Windows sandbox here, so unmatched
  // shell operations ask even if their names look read-only. Do not add a heuristic allowlist.
  return { ...result(action, action === 'ask' ? '没有匹配的本会话授权规则；终端以当前 Windows 用户权限运行，需要批准。' : undefined), commands };
}
