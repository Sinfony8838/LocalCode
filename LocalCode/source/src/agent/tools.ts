import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { Type, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import type { AgentEvent, Approval, ApprovalMode, WorkMode, AttachmentResource, QuestionItem } from '../shared/contracts.js';
import { executePowerShell } from '../core/command.js';
import { listWorkspaceFiles, readWorkspaceText, walkWorkspaceFiles, writeWorkspaceText } from '../core/workspace.js';
import { childResource, resolveResource, type ResolvedResource } from '../core/resources.js';
import { evaluatePermission } from '../core/permissions.js';

export type ApprovalRequest = Omit<Approval, 'id' | 'runId' | 'sessionId'>;

export interface WorkspaceToolContext {
  projectPath: string;
  dataDir: string;
  sessionId: string;
  runId: string;
  maxResultChars: number;
  approvalMode?: ApprovalMode; workMode?: WorkMode; grants?: string[]; attachments?: AttachmentResource[];
  goal?: { id: string; objective: string };
  emit: (event: AgentEvent) => void;
  requestApproval: (input: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  requestQuestion?: (questions: QuestionItem[], signal?: AbortSignal) => Promise<string[][] | null>;
  beforeTool?: (name: string, args: unknown) => void;
}
function ensureActive(signal?: AbortSignal) { if (signal?.aborted) { const error = new Error('任务已取消，工具未执行。'); error.name = 'AbortError'; throw error; } }
function defineTool<T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition { return tool as ToolDefinition; }
function createConversationTools(ctx: WorkspaceToolContext, begin: (name: string, args: unknown, signal?: AbortSignal) => void, result: (text: string) => { content: { type: 'text'; text: string }[]; details: { fullOutput: string } }): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (ctx.workMode === 'plan') tools.push(
    defineTool({ name: 'ask_question', label: '确认方案', description: 'Ask 1–3 questions that materially change the plan. Options are suggestions; free-text answers are supported. Wait for user answers.', executionMode: 'sequential',
      parameters: Type.Object({ questions: Type.Array(Type.Object({ header: Type.String({ minLength: 1, maxLength: 40 }), question: Type.String({ minLength: 1, maxLength: 1000 }),
        options: Type.Array(Type.Object({ label: Type.String({ minLength: 1, maxLength: 100 }), description: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false }), { minItems: 2, maxItems: 5 }), multiple: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) { begin('ask_question', args, signal); if (!ctx.requestQuestion) throw new Error('问题交互不可用。'); const answers = await ctx.requestQuestion(args.questions as QuestionItem[], signal); ensureActive(signal); return result(answers === null ? '用户取消了问题。不要替用户选择；继续规划时注明未确认假设。' : JSON.stringify({ answers })); } }),
    defineTool({ name: 'propose_plan', label: '提出计划', description: 'Present a decision-complete plan card with implementation and acceptance criteria. This does not authorize execution; wait for the user to click Implement.', executionMode: 'sequential',
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 30000 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) { begin('propose_plan', args, signal); ctx.emit({ type: 'plan', runId: ctx.runId, sessionId: ctx.sessionId, plan: { id: randomUUID(), runId: ctx.runId, text: String(args.text), status: 'proposed' } }); return result('计划已展示。等待用户点击“实施计划”，当前仍为只读计划模式。'); } }),
  );
  if (ctx.goal) tools.push(
    defineTool({ name: 'get_goal', label: '查看目标', description: 'Read the user-configured goal for this conversation.', executionMode: 'sequential', parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, args, signal) { begin('get_goal', args, signal); return result(JSON.stringify(ctx.goal)); } }),
    defineTool({ name: 'update_goal', label: '更新目标状态', description: 'Mark complete only after concrete evidence verifies every requirement. Mark blocked only when the same blocker persists for three consecutive goal turns with no possible progress. Pause only at the user explicit request. Cannot resume or increase budget.', executionMode: 'sequential',
      parameters: Type.Object({ status: Type.Union([Type.Literal('complete'), Type.Literal('blocked'), Type.Literal('paused')]), reason: Type.String({ minLength: 1, maxLength: 8000 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) { begin('update_goal', args, signal); const reason = String(args.reason).trim(); if (!reason) throw new Error('必须说明完成依据或停止原因。'); ctx.emit({ type: 'goal_update', runId: ctx.runId, sessionId: ctx.sessionId, goalId: ctx.goal!.id, status: args.status as 'complete' | 'blocked' | 'paused', reason }); return result(`目标状态已提交：${args.status}。依据：${reason}`); } }),
  );
  return tools;
}
export function createWorkspaceTools(ctx: WorkspaceToolContext): ToolDefinition[] {
  const begin = (name: string, args: unknown, signal?: AbortSignal) => {
    ensureActive(signal);
    if (ctx.workMode === 'plan' && ['edit_file', 'write_file', 'powershell'].includes(name)) throw new Error('计划模式只允许读取，不能修改文件或运行命令。');
    ctx.beforeTool?.(name, args);
  };
  const authorize = async (kind: 'read' | 'write' | 'command', resource: ResolvedResource, toolCallId: string, signal?: AbortSignal, command?: string, preview?: string) => {
    ensureActive(signal);
    const cwd = kind === 'command' ? resource.absolute : ctx.projectPath || resource.root;
    const decision = await evaluatePermission({ mode: ctx.approvalMode ?? 'ask', workMode: ctx.workMode ?? 'execute', kind,
      resource: resource.absolute, cwd, command, inWorkspace: resource.inWorkspace, grants: ctx.grants ?? [] });
    if (decision.action === 'deny') throw new Error(decision.reason || '当前权限不允许此操作。');
    if (decision.action === 'ask' && !await ctx.requestApproval({ kind, resource: resource.absolute, toolCallId, permissionKey: decision.permissionKey,
      command: command ?? `${kind === 'write' ? '写入' : '读取'} ${resource.absolute}`, cwd, preview: preview?.slice(0, 12000), reason: decision.reason }, signal)) {
      throw new Error('用户拒绝了该操作，未执行。不要绕过拒绝或改写后自动重试。');
    }
    ensureActive(signal);
  };
  const resolve = async (input: string, options: { directory?: boolean; write?: boolean; allowMissing?: boolean }, id: string, signal?: AbortSignal, preview?: string) => {
    const resource = await resolveResource(ctx, input, options);
    await authorize(options.write ? 'write' : 'read', resource, id, signal, undefined, preview);
    const checked = await resolveResource(ctx, input, options);
    if (checked.absolute !== resource.absolute) throw new Error('审批后资源路径发生变化，操作未执行。');
    ensureActive(signal); return checked;
  };
  const result = (text: string, extra: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text: text.length > ctx.maxResultChars ? text.slice(0, Math.max(0, ctx.maxResultChars - 100)) + '\n[已按模型上下文预算截断；请缩小范围或分页读取。]' : text }],
    details: { fullOutput: text.slice(0, 1024 * 1024), ...extra },
  });
  const changed = () => ctx.emit({ type: 'changes_updated', runId: ctx.runId, sessionId: ctx.sessionId });
  // The SDK's default TSchema resolves params to unknown; schemas are checked at
  // this boundary even when a caller bypasses the SDK's own validator.
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'list_files', label: '浏览目录', description: 'List files using a project-relative path, an approved absolute path, or a read-only attachment:<id> directory. Hidden dependency/build/model directories are excluded.', executionMode: 'sequential',
      parameters: Type.Object({ path: Type.Optional(Type.String({ maxLength: 500 })), recursive: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('list_files', args, signal);
        const directory = typeof args.path === 'string' ? args.path : '';
        if (!directory && !ctx.projectPath) return result((ctx.attachments ?? []).filter(a => a.kind !== 'image').map(a => `${a.kind === 'folder' ? '[目录]' : '[文件]'} attachment:${a.id} (${a.name})`).join('\n') || '没有可读取的附件。');
        const resource = await resolve(directory, { directory: true }, _id, signal);
        if (args.recursive) {
          const found = await walkWorkspaceFiles(resource.root, resource.relative, 500);
          const entries = []; for (const file of found) { try { await resolveResource(ctx, childResource(resource, file)); entries.push(file); } catch { /* Private data and unsafe paths are omitted. */ } }
          ensureActive(signal);
          return result(entries.map(entry => childResource(resource, entry)).join('\n') + (entries.length >= 500 ? '\n[最多返回 500 个文件，请缩小目录范围。]' : '') || '目录中没有可读取的文件。');
        }
        const found = await listWorkspaceFiles(resource.root, resource.relative);
        const entries = []; for (const entry of found) { try { await resolveResource(ctx, childResource(resource, entry.path), { directory: entry.directory }); entries.push(entry); } catch { /* Private data and unsafe paths are omitted. */ } }
        ensureActive(signal);
        return result(entries.map(entry => `${entry.directory ? '[目录]' : '[文件]'} ${childResource(resource, entry.path)}`).join('\n') || '目录为空。');
      },
    }),
    defineTool({
      name: 'read_file', label: '读取文件', description: 'Read a UTF-8 file by line range using a project-relative path, an approved absolute path, or a read-only attachment:<id> reference. Start at line 1; read more pages if truncated.', executionMode: 'sequential',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }), startLine: Type.Optional(Type.Integer({ minimum: 1 })), maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('read_file', args, signal);
        const resource = await resolve(args.path as string, {}, _id, signal);
        const text = await readWorkspaceText(resource.root, resource.relative); ensureActive(signal);
        const lines = text.split(/\r?\n/); const start = (args.startLine as number | undefined) ?? 1; const count = (args.maxLines as number | undefined) ?? 100;
        if (start > lines.length) return result(`文件共 ${lines.length} 行，起始行超出范围。`);
        const selected = lines.slice(start - 1, start - 1 + count).map((line, index) => `${start + index}: ${line}`).join('\n');
        return result(`${args.path}（共 ${lines.length} 行）\n${selected}${start - 1 + count < lines.length ? `\n[还有更多内容；下一页从 ${start + count} 行开始。]` : ''}`);
      },
    }),
    defineTool({
      name: 'search', label: '搜索代码', description: 'Search literal text or file paths in the project, an approved absolute path, or a read-only attachment:<id> reference. Returns at most 40 matches.', executionMode: 'sequential',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), path: Type.Optional(Type.String({ maxLength: 500 })), mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('path')])) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('search', args, signal);
        const input = String(args.path ?? ''); const attachment = ctx.attachments?.find(a => input === `attachment:${a.id}` && a.kind === 'text');
        const resource = await resolve(input, { directory: !attachment }, _id, signal);
        const query = String(args.query).toLowerCase(); const entries = attachment ? [resource.relative] : await walkWorkspaceFiles(resource.root, resource.relative, 1500); const hits: string[] = [];
        for (const file of entries) {
          ensureActive(signal);
          const display = attachment ? resource.displayPath : childResource(resource, file);
          try { await resolveResource(ctx, display); } catch { continue; }
          if (args.mode === 'path') { if (display.toLowerCase().includes(query)) hits.push(display); }
          else {
            try {
              const text = await readWorkspaceText(resource.root, file);
              if (text.length > 256_000) continue;
              for (const [index, line] of text.split(/\r?\n/).entries()) { if (line.toLowerCase().includes(query)) hits.push(`${display}:${index + 1}: ${line.slice(0, 300)}`); if (hits.length >= 40) break; }
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
        const resource = await resolve(args.path as string, {}, _id, signal);
        const text = await readWorkspaceText(resource.root, resource.relative); const oldText = args.oldText as string; const index = text.indexOf(oldText);
        if (index < 0) throw new Error('oldText 与文件不匹配，未修改。请重新读取并使用精确文本。');
        if (text.indexOf(oldText, index + 1) !== -1) throw new Error('oldText 出现多次，未修改。请提供更多上下文，使匹配唯一。');
        ensureActive(signal);
        const checked = await resolve(args.path as string, { write: true }, _id, signal, `替换：\n${oldText}\n为：\n${args.newText}`);
        if (checked.absolute !== resource.absolute) throw new Error('读取后资源路径发生变化，未修改。');
        await writeWorkspaceText({ ...ctx, projectPath: checked.root, relativePath: checked.relative, displayPath: checked.displayPath, content: text.slice(0, index) + String(args.newText) + text.slice(index + oldText.length), expectedText: text });
        changed(); return result(`已修改 ${args.path}，原始内容已保存，可在差异面板撤销。`);
      },
    }),
    defineTool({
      name: 'write_file', label: '写入文件', description: 'Create or replace a small UTF-8 project file. Existing content is snapshotted for safe undo. Prefer edit_file for existing files.', executionMode: 'sequential',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }), content: Type.String({ maxLength: 500_000 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('write_file', args, signal); ensureActive(signal);
        const resource = await resolve(args.path as string, { write: true, allowMissing: true }, _id, signal, String(args.content));
        await writeWorkspaceText({ ...ctx, projectPath: resource.root, relativePath: resource.relative, displayPath: resource.displayPath, content: args.content as string });
        changed(); return result(`已写入 ${args.path}，修改记录已保存。`);
      },
    }),
    defineTool({
      name: 'powershell', label: '运行命令', description: 'Run Windows PowerShell 5.1 after explicit user approval. Show an exact command. This has normal user rights, NOT an OS sandbox. Do not use Bash or && syntax.', executionMode: 'sequential',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 12_000 }), cwd: Type.Optional(Type.String({ maxLength: 500 })), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('powershell', args, signal);
        const directory = await resolveResource(ctx, String(args.cwd ?? ''), { directory: true });
        if (directory.attachment) throw new Error('不能在附件文件夹运行命令。');
        const command = String(args.command);
        await authorize('command', directory, _id, signal, command);
        // Recheck the directory after approval, which may arrive much later.
        const checked = await resolveResource(ctx, String(args.cwd ?? ''), { directory: true });
        if (checked.absolute !== directory.absolute) throw new Error('审批后工作目录发生变化，命令未执行。');
        ensureActive(signal);
        const execution = await executePowerShell({ command, cwd: directory.absolute, dataDir: ctx.dataDir, signal, timeoutMs: Number(args.timeoutSeconds ?? 120) * 1000 });
        const summary = `退出码：${execution.exitCode ?? '无'}${execution.cancelled ? '；已取消' : ''}${execution.timedOut ? '；超时' : ''}\n${execution.output}\n日志：${execution.logPath}`;
        if (execution.cancelled) throw new Error('命令已取消，其子进程已终止。');
        return result(summary, { logPath: execution.logPath, exitCode: execution.exitCode, timedOut: execution.timedOut, outputLimited: execution.outputLimited });
      },
    }),
  ];
  tools.push(...createConversationTools(ctx, begin, result));
  return tools.filter(tool => (ctx.projectPath && ctx.workMode !== 'plan') || !['edit_file', 'write_file', 'powershell'].includes(tool.name)).map(tool => ({ ...tool, async execute(id, args, signal, update, context) {
    ensureActive(signal);
    if (!Check(tool.parameters, args)) throw new Error(`工具 ${tool.name} 的参数无效，未执行。请按声明的参数格式纠正。`);
    return tool.execute(id, args, signal, update, context);
  } }));
}
