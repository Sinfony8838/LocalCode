import { readResourceText, resourceWorkspace } from '../core/resources.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createHash, randomUUID } from 'node:crypto';
import { Type, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import type { AgentEvent, Approval, ApprovalMode, WorkMode, AttachmentResource, QuestionItem } from '../shared/contracts.js';
import { executePowerShell } from '../core/command.js';
import { listWorkspaceFiles, readWorkspaceText, walkWorkspaceFiles, writeWorkspaceText } from '../core/workspace.js';
import { childResource, resolveResource, type ResolvedResource } from '../core/resources.js';
import { evaluatePermission } from '../core/permissions.js';
import { startBackgroundCommand, pollBackgroundProcess, stopBackgroundProcess } from '../core/process-manager.js';
import { fetchWebText } from '../core/web-fetch.js';

export type ApprovalRequest = Omit<Approval, 'id' | 'runId' | 'sessionId'>;

export interface WorkspaceToolContext extends WorkspaceContext {
  sessionId: string;
  runId: string;
  maxResultChars: number;
  approvalMode?: ApprovalMode; workMode?: WorkMode; grants?: string[]; attachments?: AttachmentResource[];
  goal?: { id: string; objective: string };
  emit: (event: AgentEvent) => void;
  requestApproval: (input: ApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  requestQuestion?: (questions: QuestionItem[], signal?: AbortSignal) => Promise<string[][] | null>;
  beforeTool?: (name: string, args: unknown) => void;
  onFileModified?: (path: string) => void;
  exploreCodebase?: (input: { question: string; scopePath?: string }, signal?: AbortSignal) => Promise<string>;
}
export function canonicalToolArgs(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalToolArgs).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalToolArgs(v)).join(',') + '}';
}
function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += pattern[i + 2] === '/' ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close > i) {
        out += '(?:' + pattern.slice(i + 1, close).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = close;
      } else out += '\\{';
    } else if (/[.+^$()|[\]\\]/.test(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(out + '$', 'i');
}
function matchesIncludePattern(displayPath: string, pattern?: string): boolean {
  if (!pattern || !pattern.trim()) return true;
  const normalized = displayPath.replaceAll('\\', '/');
  const cleanPattern = pattern.trim().replaceAll('\\', '/');
  const regex = globToRegExp(cleanPattern);
  const baseName = normalized.split('/').pop() ?? normalized;
  return cleanPattern.includes('/') ? regex.test(normalized) : (regex.test(baseName) || regex.test(normalized));
}
function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}
export function applyTextReplacement(text: string, oldText: string, newText: string): string {
  const first = text.indexOf(oldText);
  if (first >= 0) {
    const second = text.indexOf(oldText, first + 1);
    if (second !== -1) throw new Error(`oldText 出现多次（第 ${lineNumberAt(text, first)}、${lineNumberAt(text, second)} 行），未修改。请提供更多上下文，使匹配唯一。`);
    return text.slice(0, first) + newText + text.slice(first + oldText.length);
  }
  const fileEol = text.includes('\r\n') ? '\r\n' : '\n';
  const normOld = oldText.replace(/\r?\n/g, fileEol);
  const normNew = newText.replace(/\r?\n/g, fileEol);
  if (normOld !== oldText) {
    const nFirst = text.indexOf(normOld);
    if (nFirst >= 0) {
      const nSecond = text.indexOf(normOld, nFirst + 1);
      if (nSecond !== -1) throw new Error(`oldText 出现多次（第 ${lineNumberAt(text, nFirst)}、${lineNumberAt(text, nSecond)} 行），未修改。请提供更多上下文，使匹配唯一。`);
      return text.slice(0, nFirst) + normNew + text.slice(nFirst + normOld.length);
    }
  }
  const oldLines = oldText.split(/\r?\n/).map(l => l.trimEnd());
  if (oldLines.length >= 1 && oldLines.some(l => l.trim().length > 0)) {
    const spans: { trimmedEnd: string; start: number; end: number }[] = [];
    const lineRegex = /[^\r\n]*(\r?\n|$)/g;
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(text)) !== null) {
      const full = match[0];
      const eol = match[1] ?? '';
      const body = full.slice(0, full.length - eol.length);
      spans.push({ trimmedEnd: body.trimEnd(), start: match.index, end: match.index + body.length });
      if (!eol) break;
    }
    const hits: number[] = [];
    for (let i = 0; i + oldLines.length <= spans.length; i++) {
      if (oldLines.every((ol, k) => spans[i + k].trimmedEnd === ol)) hits.push(i);
    }
    if (hits.length > 1) throw new Error(`oldText 出现多次（第 ${hits.slice(0, 5).map(h => h + 1).join('、')} 行），未修改。请提供更多上下文，使匹配唯一。`);
    if (hits.length === 1) {
      const startOffset = spans[hits[0]].start;
      const endOffset = spans[hits[0] + oldLines.length - 1].end;
      return text.slice(0, startOffset) + normNew + text.slice(endOffset);
    }
  }
  const anchor = oldText.split(/\r?\n/).map(l => l.trim()).find(l => l.length >= 3);
  let hint = '';
  if (anchor) {
    const nearLines: number[] = [];
    for (const [idx, line] of text.split(/\r?\n/).entries()) {
      if (line.includes(anchor)) { nearLines.push(idx + 1); if (nearLines.length >= 3) break; }
    }
    if (nearLines.length) hint = `（提示：首行片段在第 ${nearLines.join('、')} 行附近出现，请先用 read_file 查看该区域精确文本。）`;
  }
  throw new Error(`oldText 与文件不匹配，未修改。请重新读取并使用精确文本。${hint}`);
}
export function extractFileOutline(filePath: string, text: string): string {
  const lines = text.split(/\r?\n/);
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const items: string[] = [];
  const pattern = ext === 'md' || ext === 'mdx'
    ? /^(#{1,6}\s+.+)$/
    : ext === 'py'
      ? /^(\s*(?:async\s+def|def|class)\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:\([^)]*\))?)/
      : /^(\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+[A-Za-z_$][A-Za-z0-9_$]*|class\s+[A-Za-z_$][A-Za-z0-9_$]*|interface\s+[A-Za-z_$][A-Za-z0-9_$]*|type\s+[A-Za-z_$][A-Za-z0-9_$]*|enum\s+[A-Za-z_$][A-Za-z0-9_$]*|(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>))/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (pattern.test(line)) {
      items.push(`L${i + 1}: ${line.trim().slice(0, 160)}`);
      if (items.length >= 200) break;
    }
  }
  if (!items.length) return `${filePath}（共 ${lines.length} 行）：未提取到顶层符号大纲，请使用 read_file 分页读取。`;
  return `${filePath}（共 ${lines.length} 行，提取到 ${items.length} 个符号）：\n${items.join('\n')}`;
}
async function localExploreFallback(ctx: WorkspaceToolContext, resource: ResolvedResource, question: string, signal?: AbortSignal): Promise<string> {
  const ws = resourceWorkspace(ctx, resource.root);
  const files = await walkWorkspaceFiles(ws, resource.relative, 200);
  const keywords = question
    .split(/[^A-Za-z0-9_\u4e00-\u9fa5]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2)
    .slice(0, 8);
  const sections: string[] = [`探索问题：${question}`, `扫描范围：${resource.displayPath || '.'}（共发现 ${files.length} 个文件）`];
  const matchedOutlines: string[] = [];
  for (const file of files.slice(0, 60)) {
    ensureActive(signal);
    const display = childResource(resource, file);
    try {
      await resolveResource(ctx, display);
      const text = await readResourceText(ctx, { ...resource, relative: file });
      const lower = text.toLowerCase();
      if (!keywords.length || keywords.some(k => display.toLowerCase().includes(k.toLowerCase()) || lower.includes(k.toLowerCase()))) {
        matchedOutlines.push(extractFileOutline(display, text));
      }
      if (matchedOutlines.length >= 12) break;
    } catch { /* ignore unreadable files */ }
  }
  if (matchedOutlines.length) {
    sections.push('关键文件与符号大纲：\n' + matchedOutlines.join('\n\n'));
  } else {
    sections.push('目录文件列表：\n' + files.slice(0, 50).map(f => childResource(resource, f)).join('\n'));
  }
  return sections.join('\n\n').slice(0, 3200);
}
function ensureActive(signal?: AbortSignal) { if (signal?.aborted) { const error = new Error('任务已取消，工具未执行。'); error.name = 'AbortError'; throw error; } }
function defineTool<T extends TSchema>(tool: ToolDefinition<T>): ToolDefinition { return tool as ToolDefinition; }
const MUTATION_TOOLS = ['edit_file', 'write_file', 'powershell', 'start_background_command', 'poll_process_output', 'stop_process'];
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
    if (ctx.workMode === 'plan' && MUTATION_TOOLS.includes(name)) throw new Error('计划模式只允许读取，不能修改文件或运行命令。');
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
          const found = await walkWorkspaceFiles(resourceWorkspace(ctx, resource.root), resource.relative, 500);
          const entries = []; for (const file of found) { try { await resolveResource(ctx, childResource(resource, file)); entries.push(file); } catch { /* Private data and unsafe paths are omitted. */ } }
          ensureActive(signal);
          return result(entries.map(entry => childResource(resource, entry)).join('\n') + (entries.length >= 500 ? '\n[最多返回 500 个文件，请缩小目录范围。]' : '') || '目录中没有可读取的文件。');
        }
        const found = await listWorkspaceFiles(resourceWorkspace(ctx, resource.root), resource.relative);
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
        const text = await readResourceText(ctx, resource); ensureActive(signal);
        const lines = text.split(/\r?\n/); const start = (args.startLine as number | undefined) ?? 1; const count = (args.maxLines as number | undefined) ?? 100;
        if (start > lines.length) return result(`文件共 ${lines.length} 行，起始行超出范围。`);
        const selected = lines.slice(start - 1, start - 1 + count).map((line, index) => `${start + index}: ${line}`).join('\n');
        return result(`${args.path}（共 ${lines.length} 行）\n${selected}${start - 1 + count < lines.length ? `\n[还有更多内容；下一页从 ${start + count} 行开始。]` : ''}`);
      },
    }),
    defineTool({
      name: 'read_outline', label: '文件大纲', description: 'Extract top-level symbols (functions, classes, interfaces, types, exports, or markdown headings) with 1-based line numbers before reading specific line ranges with read_file.', executionMode: 'sequential',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('read_outline', args, signal);
        const resource = await resolve(args.path as string, {}, _id, signal);
        const text = await readResourceText(ctx, resource); ensureActive(signal);
        return result(extractFileOutline(String(args.path), text));
      },
    }),
    defineTool({
      name: 'search', label: '搜索代码', description: 'Search text, regex, or file paths in the project, an approved absolute path, or a read-only attachment:<id> reference. Supports regex (isRegex), glob filter (includePattern, e.g. "*.ts"), and context lines (contextLines).', executionMode: 'sequential',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 500 }),
        path: Type.Optional(Type.String({ maxLength: 500 })),
        mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('path')])),
        isRegex: Type.Optional(Type.Boolean()),
        caseSensitive: Type.Optional(Type.Boolean()),
        includePattern: Type.Optional(Type.String({ maxLength: 200 })),
        contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('search', args, signal);
        const input = String(args.path ?? ''); const attachment = ctx.attachments?.find(a => input === `attachment:${a.id}` && a.kind === 'text');
        const resource = await resolve(input, { directory: !attachment }, _id, signal);
        const rawQuery = String(args.query);
        const caseSensitive = Boolean(args.caseSensitive);
        const isRegex = Boolean(args.isRegex);
        const contextLines = Number(args.contextLines ?? 0);
        const maxResults = Number(args.maxResults ?? 50);
        const includePattern = typeof args.includePattern === 'string' ? args.includePattern : undefined;
        let regex: RegExp | undefined;
        if (isRegex) {
          try { regex = new RegExp(rawQuery, caseSensitive ? '' : 'i'); }
          catch (err) { throw new Error(`正则表达式无效：${(err as Error).message}`); }
        }
        const needle = caseSensitive ? rawQuery : rawQuery.toLowerCase();
        const matchText = (line: string) => {
          const bounded = line.length > 10_000 ? line.slice(0, 10_000) : line;
          return regex ? regex.test(bounded) : (caseSensitive ? bounded.includes(needle) : bounded.toLowerCase().includes(needle));
        };
        const entries = attachment ? [resource.relative] : await walkWorkspaceFiles(resourceWorkspace(ctx, resource.root), resource.relative, 5000);
        const hits: string[] = [];
        for (const file of entries) {
          ensureActive(signal);
          const display = attachment ? resource.displayPath : childResource(resource, file);
          if (!matchesIncludePattern(display, includePattern)) continue;
          try { await resolveResource(ctx, display); } catch { continue; }
          if (args.mode === 'path') {
            if (matchText(display)) hits.push(display);
          } else {
            try {
              const text = await readResourceText(ctx, { ...resource, relative: file });
              const lines = text.split(/\r?\n/);
              for (let index = 0; index < lines.length; index++) {
                if (matchText(lines[index])) {
                  if (contextLines > 0) {
                    const start = Math.max(0, index - contextLines);
                    const end = Math.min(lines.length - 1, index + contextLines);
                    const block: string[] = [];
                    for (let k = start; k <= end; k++) {
                      block.push(`${display}:${k + 1}${k === index ? ':' : '-'} ${lines[k].slice(0, 300)}`);
                    }
                    hits.push(block.join('\n'));
                  } else {
                    hits.push(`${display}:${index + 1}: ${lines[index].slice(0, 300)}`);
                  }
                  if (hits.length >= maxResults) break;
                }
              }
            } catch { /* Binary, large, inaccessible, and unsafe files are excluded. */ }
          }
          if (hits.length >= maxResults) break;
        }
        return result(hits.join('\n') + (hits.length >= maxResults || entries.length >= 5000 ? '\n[搜索达到结果/扫描上限，请缩小范围。]' : '') || '未找到匹配项。');
      },
    }),
    defineTool({
      name: 'explore_codebase', label: '探索代码库', description: 'Delegate an open-ended codebase exploration question to an isolated read-only subagent (up to 6 read/search steps) and receive a concise summary (<800 tokens) with file paths and line numbers.', executionMode: 'sequential',
      parameters: Type.Object({
        question: Type.String({ minLength: 1, maxLength: 2000 }),
        scopePath: Type.Optional(Type.String({ maxLength: 500 })),
      }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('explore_codebase', args, signal);
        const scopeInput = typeof args.scopePath === 'string' ? args.scopePath : '';
        const resource = await resolve(scopeInput, { directory: true }, _id, signal);
        const question = String(args.question).trim();
        const summary = ctx.exploreCodebase
          ? await ctx.exploreCodebase({ question, scopePath: resource.relative }, signal)
          : await localExploreFallback(ctx, resource, question, signal);
        ensureActive(signal);
        return result(summary.slice(0, 3200));
      },
    }),
    defineTool({
      name: 'web_fetch', label: '读取网页', description: 'Fetch a public HTTPS documentation or web page (SSRF-protected, blocks private/loopback/metadata IPs) and extract readable text.', executionMode: 'sequential',
      parameters: Type.Object({
        url: Type.String({ minLength: 8, maxLength: 2000 }),
        maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 32_000 })),
      }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('web_fetch', args, signal);
        const url = String(args.url).trim();
        const permissionKey = createHash('sha256').update(JSON.stringify(['web_fetch', url])).digest('hex');
        if ((ctx.approvalMode ?? 'ask') === 'ask' && !ctx.grants?.includes(permissionKey)) {
          const approved = await ctx.requestApproval({
            kind: 'read',
            resource: url,
            toolCallId: _id,
            permissionKey,
            command: `读取外部网页 ${url}`,
            cwd: ctx.projectPath || '.',
            reason: '请求批准模式下访问外部 HTTPS 网页需要批准。',
          }, signal);
          if (!approved) throw new Error('用户拒绝了该操作，未执行。不要绕过拒绝或改写后自动重试。');
        }
        ensureActive(signal);
        const text = await fetchWebText(url, { maxChars: Number(args.maxChars ?? 16_000), signal });
        return result(text);
      },
    }),
    defineTool({
      name: 'edit_file', label: '编辑文件', description: 'Replace one or more unique occurrences in a UTF-8 project file. Supports single (oldText/newText) or multi-hunk (edits: [{oldText, newText}]) atomic replacements with CRLF/trailing-whitespace tolerance. Read the file first.', executionMode: 'sequential',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 500 }),
        oldText: Type.Optional(Type.String({ minLength: 1, maxLength: 500_000 })),
        newText: Type.Optional(Type.String({ maxLength: 500_000 })),
        edits: Type.Optional(Type.Array(Type.Object({
          oldText: Type.String({ minLength: 1, maxLength: 500_000 }),
          newText: Type.String({ maxLength: 500_000 }),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 50 })),
      }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('edit_file', args, signal);
        const hunks: { oldText: string; newText: string }[] = [];
        if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
          hunks.push({ oldText: args.oldText, newText: args.newText });
        }
        if (Array.isArray(args.edits)) {
          for (const item of args.edits as { oldText: string; newText: string }[]) {
            hunks.push({ oldText: String(item.oldText), newText: String(item.newText) });
          }
        }
        if (!hunks.length) throw new Error('工具 edit_file 的参数无效，未执行。请提供 oldText/newText 或 edits 列表。');
        const resource = await resolve(args.path as string, {}, _id, signal);
        const text = await readResourceText(ctx, resource);
        let updated = text;
        for (const hunk of hunks) {
          updated = applyTextReplacement(updated, hunk.oldText, hunk.newText);
        }
        ensureActive(signal);
        const preview = hunks.map(h => `替换：\n${h.oldText}\n为：\n${h.newText}`).join('\n---\n');
        const checked = await resolve(args.path as string, { write: true }, _id, signal, preview);
        if (checked.absolute !== resource.absolute) throw new Error('读取后资源路径发生变化，未修改。');
        await writeWorkspaceText({ ...ctx, resourceRoot: checked.root, relativePath: checked.relative, displayPath: checked.displayPath, content: updated, expectedText: text });
        ctx.onFileModified?.(checked.displayPath);
        changed();
        let diagnostic = '';
        if (String(args.path).toLowerCase().endsWith('.json')) {
          try { JSON.parse(updated); }
          catch (err) { diagnostic = `\n[语法检查警告：修改后的 JSON 格式无效（${(err as Error).message}），请立即修复。]`; }
        }
        return result(`已修改 ${args.path}（共 ${hunks.length} 处替换），原始内容已保存，可在差异面板撤销。${diagnostic}`);
      },
    }),
    defineTool({
      name: 'write_file', label: '写入文件', description: 'Create or replace a small UTF-8 project file. Existing content is snapshotted for safe undo. Prefer edit_file for existing files.', executionMode: 'sequential',
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }), content: Type.String({ maxLength: 500_000 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('write_file', args, signal); ensureActive(signal);
        const resource = await resolve(args.path as string, { write: true, allowMissing: true }, _id, signal, String(args.content));
        await writeWorkspaceText({ ...ctx, resourceRoot: resource.root, relativePath: resource.relative, displayPath: resource.displayPath, content: args.content as string });
        ctx.onFileModified?.(resource.displayPath);
        changed();
        let diagnostic = '';
        if (String(args.path).toLowerCase().endsWith('.json')) {
          try { JSON.parse(String(args.content)); }
          catch (err) { diagnostic = `\n[语法检查警告：写入的 JSON 格式无效（${(err as Error).message}），请立即修复。]`; }
        }
        return result(`已写入 ${args.path}，修改记录已保存。${diagnostic}`);
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
    defineTool({
      name: 'start_background_command', label: '启动后台命令', description: 'Start a long-running Windows PowerShell 5.1 command in the background (up to 3 per session, e.g. dev server). Returns a processId for poll_process_output and stop_process.', executionMode: 'sequential',
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 12_000 }), cwd: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('start_background_command', args, signal);
        const directory = await resolveResource(ctx, String(args.cwd ?? ''), { directory: true });
        if (directory.attachment) throw new Error('不能在附件文件夹运行命令。');
        const command = String(args.command);
        await authorize('command', directory, _id, signal, command);
        const checked = await resolveResource(ctx, String(args.cwd ?? ''), { directory: true });
        if (checked.absolute !== directory.absolute) throw new Error('审批后工作目录发生变化，命令未执行。');
        ensureActive(signal);
        const snapshot = await startBackgroundCommand({ sessionId: ctx.sessionId, command, cwd: directory.absolute, signal });
        return result(`已启动后台命令（processId: ${snapshot.id}，PID: ${snapshot.pid}，状态: ${snapshot.running ? 'running' : 'exited'}）\n${snapshot.output}`);
      },
    }),
    defineTool({
      name: 'poll_process_output', label: '查看后台输出', description: 'Read buffered stdout/stderr and status of a background command started in this session.', executionMode: 'sequential',
      parameters: Type.Object({ processId: Type.String({ minLength: 1, maxLength: 100 }), waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('poll_process_output', args, signal);
        const processId = String(args.processId);
        const waitMs = Number(args.waitMs ?? 0);
        const initialLen = pollBackgroundProcess(ctx.sessionId, processId).output.length;
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline && !signal?.aborted) {
          const cur = pollBackgroundProcess(ctx.sessionId, processId);
          if (cur.output.length > initialLen || !cur.running) break;
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, Math.min(50, Math.max(10, deadline - Date.now())));
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
        ensureActive(signal);
        const snapshot = pollBackgroundProcess(ctx.sessionId, processId);
        return result(`后台进程 ${snapshot.id}（状态: ${snapshot.running ? 'running' : 'exited'}，退出码: ${snapshot.exitCode ?? '运行中'}）\n${snapshot.output || '（暂无新输出）'}`);
      },
    }),
    defineTool({
      name: 'stop_process', label: '停止后台命令', description: 'Terminate a background command tree started in this session.', executionMode: 'sequential',
      parameters: Type.Object({ processId: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
      async execute(_id, args, signal) {
        begin('stop_process', args, signal);
        const snapshot = await stopBackgroundProcess(ctx.sessionId, String(args.processId));
        return result(`已停止后台进程 ${snapshot.id}（状态: stopped，退出码: ${snapshot.exitCode ?? '无'}）\n${snapshot.output}`);
      },
    }),
  ];
  tools.push(...createConversationTools(ctx, begin, result));
  let lastCallKey = '';
  let repeatCount = 0;
  return tools
    .filter(tool => {
      if (!ctx.projectPath && [...MUTATION_TOOLS, 'explore_codebase', 'web_fetch'].includes(tool.name)) return false;
      if (ctx.workMode === 'plan' && MUTATION_TOOLS.includes(tool.name)) return false;
      return true;
    })
    .map(tool => ({
      ...tool,
      async execute(id, args, signal, update, context) {
        ensureActive(signal);
        if (!Check(tool.parameters, args)) throw new Error(`工具 ${tool.name} 的参数无效，未执行。请按声明的参数格式纠正。`);
        if (tool.name !== 'poll_process_output') {
          const callKey = `${tool.name}:${canonicalToolArgs(args)}`;
          if (callKey === lastCallKey) {
            repeatCount += 1;
          } else {
            lastCallKey = callKey;
            repeatCount = 1;
          }
          if (repeatCount >= 5) {
            throw new Error(`检测到连续 ${repeatCount} 次完全相同的工具调用（${tool.name}），已触发死循环熔断。请更换排查方法或直接汇报当前进展。`);
          }
        }
        const out = await tool.execute(id, args, signal, update, context);
        if (tool.name === 'edit_file' || tool.name === 'write_file') {
          lastCallKey = '';
          repeatCount = 0;
        } else if (repeatCount >= 3 && Array.isArray(out.content) && out.content[0]?.type === 'text') {
          const warning = `\n<loop-warning>检测到连续 ${repeatCount} 次重复调用 ${tool.name} 且参数完全相同，请立即更换排查策略或读取其他区域。</loop-warning>`;
          out.content[0].text += warning;
        }
        return out;
      },
    }));
}
