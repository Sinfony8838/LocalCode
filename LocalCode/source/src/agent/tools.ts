import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import type { AgentEvent } from '../shared/contracts.js';
import { executePowerShell } from '../core/command.js';
import { listWorkspaceFiles, readWorkspaceText, resolveWorkspacePath, walkWorkspaceFiles, writeWorkspaceText } from '../core/workspace.js';

export interface WorkspaceToolContext {
  projectPath: string;
  dataDir: string;
  sessionId: string;
  runId: string;
  maxResultChars: number;
  emit: (event: AgentEvent) => void;
  requestApproval: (input: { command: string; cwd: string }, signal?: AbortSignal) => Promise<boolean>;
  beforeTool?: (name: string, args: unknown) => void;
}
function ensureActive(signal?: AbortSignal) { if (signal?.aborted) { const error = new Error('任务已取消，工具未执行。'); error.name = 'AbortError'; throw error; } }
function defineTool<T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition { return tool as ToolDefinition; }
export function createWorkspaceTools(ctx: WorkspaceToolContext): ToolDefinition[] {
  const begin = (name: string, args: unknown, signal?: AbortSignal) => { ensureActive(signal); ctx.beforeTool?.(name, args); };
  const result = (text: string, extra: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text: text.length > ctx.maxResultChars ? text.slice(0, Math.max(0, ctx.maxResultChars - 100)) + '\n[已按模型上下文预算截断；请缩小范围或分页读取。]' : text }],
    details: { fullOutput: text.slice(0, 1024 * 1024), ...extra },
  });
  const changed = () => ctx.emit({ type: 'changes_updated', runId: ctx.runId, sessionId: ctx.sessionId });
  // The SDK's default TSchema resolves params to unknown; schemas are checked at
  // this boundary even when a caller bypasses the SDK's own validator.
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'list_files', label: '浏览目录', description: 'List project files. Paths are relative. Hidden dependency/build/model directories are excluded.', executionMode: 'sequential',
      parameters: Type.Object({ path: Type.Optional(Type.String({ maxLength: 500 })), recursive: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('list_files', args, signal);
        const directory = typeof args.path === 'string' ? args.path : '';
        if (args.recursive) {
          const entries = await walkWorkspaceFiles(ctx.projectPath, directory, 500);
          ensureActive(signal);
          return result(entries.join('\n') + (entries.length >= 500 ? '\n[最多返回 500 个文件，请缩小目录范围。]' : '') || '目录中没有可读取的文件。');
        }
        const entries = await listWorkspaceFiles(ctx.projectPath, directory);
        ensureActive(signal);
        return result(entries.map(entry => `${entry.directory ? '[目录]' : '[文件]'} ${entry.path}`).join('\n') || '目录为空。');
      },
    }),
    defineTool({
      name: 'read_file', label: '读取文件', description: 'Read a UTF-8 project file by line range. Start at line 1; read more pages if truncated.', executionMode: 'sequential',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }), startLine: Type.Optional(Type.Integer({ minimum: 1 })), maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('read_file', args, signal);
        const text = await readWorkspaceText(ctx.projectPath, args.path as string); ensureActive(signal);
        const lines = text.split(/\r?\n/); const start = (args.startLine as number | undefined) ?? 1; const count = (args.maxLines as number | undefined) ?? 100;
        if (start > lines.length) return result(`文件共 ${lines.length} 行，起始行超出范围。`);
        const selected = lines.slice(start - 1, start - 1 + count).map((line, index) => `${start + index}: ${line}`).join('\n');
        return result(`${args.path}（共 ${lines.length} 行）\n${selected}${start - 1 + count < lines.length ? `\n[还有更多内容；下一页从 ${start + count} 行开始。]` : ''}`);
      },
    }),
    defineTool({
      name: 'search', label: '搜索代码', description: 'Search literal text in project source files, or search file paths. Returns at most 40 matches.', executionMode: 'sequential',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), path: Type.Optional(Type.String({ maxLength: 500 })), mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('path')])) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('search', args, signal);
        const query = String(args.query).toLowerCase(); const entries = await walkWorkspaceFiles(ctx.projectPath, String(args.path ?? ''), 1500); const hits: string[] = [];
        for (const file of entries) {
          ensureActive(signal);
          if (args.mode === 'path') { if (file.toLowerCase().includes(query)) hits.push(file); }
          else {
            try {
              const text = await readWorkspaceText(ctx.projectPath, file);
              if (text.length > 256_000) continue;
              for (const [index, line] of text.split(/\r?\n/).entries()) { if (line.toLowerCase().includes(query)) hits.push(`${file}:${index + 1}: ${line.slice(0, 300)}`); if (hits.length >= 40) break; }
            } catch { /* Binary, large, inaccessible, and unsafe files are excluded. */ }
          }
          if (hits.length >= 40) break;
        }
        return result(hits.join('\n') + (hits.length >= 40 || entries.length >= 1500 ? '\n[搜索达到结果/扫描上限，请缩小范围。]' : '') || '未找到匹配项。');
      },
    }),
    defineTool({
      name: 'edit_file', label: '编辑文件', description: 'Replace one exact, unique occurrence in a UTF-8 project file. Read the file first. Preserve all unrelated content.', executionMode: 'sequential',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }), oldText: Type.String({ minLength: 1, maxLength: 500_000 }), newText: Type.String({ maxLength: 500_000 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('edit_file', args, signal);
        const text = await readWorkspaceText(ctx.projectPath, args.path as string); const oldText = args.oldText as string; const index = text.indexOf(oldText);
        if (index < 0) throw new Error('oldText 与文件不匹配，未修改。请重新读取并使用精确文本。');
        if (text.indexOf(oldText, index + 1) !== -1) throw new Error('oldText 出现多次，未修改。请提供更多上下文，使匹配唯一。');
        ensureActive(signal);
        await writeWorkspaceText({ ...ctx, relativePath: args.path as string, content: text.slice(0, index) + String(args.newText) + text.slice(index + oldText.length), expectedText: text });
        changed(); return result(`已修改 ${args.path}，原始内容已保存，可在差异面板撤销。`);
      },
    }),
    defineTool({
      name: 'write_file', label: '写入文件', description: 'Create or replace a small UTF-8 project file. Existing content is snapshotted for safe undo. Prefer edit_file for existing files.', executionMode: 'sequential',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }), content: Type.String({ maxLength: 500_000 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('write_file', args, signal); ensureActive(signal);
        await writeWorkspaceText({ ...ctx, relativePath: args.path as string, content: args.content as string });
        changed(); return result(`已写入 ${args.path}，修改记录已保存。`);
      },
    }),
    defineTool({
      name: 'powershell', label: '运行命令', description: 'Run Windows PowerShell 5.1 after explicit user approval. Show an exact command. This has normal user rights, NOT an OS sandbox. Do not use Bash or && syntax.', executionMode: 'sequential',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 12_000 }), cwd: Type.Optional(Type.String({ maxLength: 500 })), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('powershell', args, signal);
        const directory = await resolveWorkspacePath(ctx.projectPath, String(args.cwd ?? ''), { directory: true });
        const command = String(args.command);
        const allowed = await ctx.requestApproval({ command, cwd: directory.absolute }, signal);
        ensureActive(signal);
        if (!allowed) throw new Error('用户拒绝了该命令，未执行。不要绕过拒绝或改写后自动重试。');
        // Recheck the directory after approval, which may arrive much later.
        const checked = await resolveWorkspacePath(ctx.projectPath, String(args.cwd ?? ''), { directory: true });
        if (checked.absolute !== directory.absolute) throw new Error('审批后工作目录发生变化，命令未执行。');
        ensureActive(signal);
        const execution = await executePowerShell({ command, cwd: directory.absolute, dataDir: ctx.dataDir, signal, timeoutMs: Number(args.timeoutSeconds ?? 120) * 1000 });
        const summary = `退出码：${execution.exitCode ?? '无'}${execution.cancelled ? '；已取消' : ''}${execution.timedOut ? '；超时' : ''}\n${execution.output}\n日志：${execution.logPath}`;
        if (execution.cancelled) throw new Error('命令已取消，其子进程已终止。');
        return result(summary, { logPath: execution.logPath, exitCode: execution.exitCode, timedOut: execution.timedOut, outputLimited: execution.outputLimited });
      },
    }),
  ];
  return tools.map(tool => ({ ...tool, async execute(id, args, signal, update, context) {
    ensureActive(signal);
    if (!Check(tool.parameters, args)) throw new Error(`工具 ${tool.name} 的参数无效，未执行。请按声明的参数格式纠正。`);
    return tool.execute(id, args, signal, update, context);
  } }));
}
