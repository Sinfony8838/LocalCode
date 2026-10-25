import { workspaceBoundary, type WorkspaceContext } from '../core/workspace-context.js';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Compile } from 'typebox/compile';
import { InMemoryCredentialStore, normalizeContext } from '@earendil-works/pi-ai';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionEvent, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentEvent, Approval, RunRequest, WorkerCommand, RunProgress } from '../shared/contracts.js';
import { killActiveCommands } from '../core/command.js';
import { createWorkspaceTools } from './tools.js';
import { managedTransport, type RequestLease } from './transport.js';

type EventBody = AgentEvent extends infer E ? E extends AgentEvent ? Omit<E, 'runId' | 'sessionId'> : never : never;
export interface EngineSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  clearQueue(): unknown;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): void;
  sessionManager: { getSessionFile(): string | undefined };
}
export interface EngineToolContext extends WorkspaceContext {
  sessionId: string; runId: string; maxResultChars: number;
  emit(event: AgentEvent): void;
  requestApproval(input: { command: string; cwd: string }, signal?: AbortSignal): Promise<boolean>;
  beforeTool(name: string, args: unknown): void;
  /** True only for the single, tool-disabled response allowed after the tool budget. */
  beforeModelRequest?(purpose?: 'assistant' | 'compaction'): boolean;
  acquireRequest?(signal: AbortSignal): Promise<RequestLease>;
  telemetry?(type: string, fields?: Record<string, unknown>): void;
  transportFailure?(message: string): void;
}
export interface EngineOptions {
  createSession?: (request: RunRequest, context: EngineToolContext, signal: AbortSignal) => Promise<EngineSession>;
  killCommands?: () => Promise<unknown> | unknown;
  acquireRequest?: (request: RunRequest, signal: AbortSignal) => Promise<RequestLease>;
}
interface ActiveRun {
  request: RunRequest; controller: AbortController; session?: EngineSession;
  toolCalls: number; invalidCalls: number; assistantSeq: number; messageId?: string;
  budgetExhausted: boolean; summaryRequests: number; summaryCompactionRequests: number;
  userAborted: boolean; failure?: string; settled: boolean;
  settledPromise: Promise<void>; resolveSettled(): void;
  done: Promise<void>; pending: Map<string, { resolve(value: boolean): void }>;
  cleanup?: Promise<unknown>; logFile?: string; startedAt: number; firstTextAt?: number; publishedFile?: string;
  redactionKey: string; streamBuffers: Map<string, string>;
  parts: Map<number, { kind: 'text' | 'thinking'; ended: boolean }>; firstThinkingAt?: number;
  progress?: RunProgress;
}

function cloudKey(request: RunRequest): string { return request.provider.kind !== 'ollama' ? request.provider.apiKey : ''; }
function redactionMarker(key: string): string {
  return !'[API 密钥已隐藏]'.includes(key) ? '[API 密钥已隐藏]' : !'[REDACTED]'.includes(key) ? '[REDACTED]' : '';
}
/** Clone at the persistence/IPC boundary so even nested provider error data cannot retain the configured key. */
function redactValue<T>(value: T, key: string): T {
  if (!key) return value;
  if (typeof value === 'string') return value.replaceAll(key, redactionMarker(key)) as T;
  if (Array.isArray(value)) return value.map(item => redactValue(item, key)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, key)])) as T;
  }
  return value;
}

const MAX_TOOL_CALLS = 12;
// pi may compact a history and a split-turn prefix with separate requests.
const MAX_FINAL_COMPACTION_REQUESTS = 2;
const BUDGET_EXHAUSTED = '本轮 12 次工具调用预算已耗尽，未继续执行工具。已收到的回复和文件修改已保留；请根据实际验证结果判断完成情况，需要继续时请发送新消息。';
const FINAL_SUMMARY_PROMPT = '本轮工具调用预算已耗尽。现在只能输出最后一条简短中文总结，禁止再调用任何工具。仅根据已有结果说明已做的工作、实际验证结果，以及未完成或未验证的事项；不要把预算耗尽说成任务已通过验收。';

const SYSTEM_PROMPT = `你是 LocalCode，本机中文编程助手。只使用提供的工具完成用户任务。
先浏览和分页读取相关文件，再做最小必要修改。不要臆测文件内容。文件路径相对当前项目。
命令由用户逐次审批；拒绝后不要绕过审批。命令以当前用户权限执行，没有系统沙箱。
工具参数必须严格匹配声明。参数错误只有一次纠正机会。每轮最多12次工具调用；接近上限时收尾。
工具输出若标注截断，可缩小范围再次读取；界面保留完整日志。
阶段性回复只说明当前发现和下一步，不要在每次工具调用或模型消息结束时宣称整轮完成。
只有本轮用户任务实际结束、不再调用工具时，给出一次简洁的中文最终总结：先说完成了什么，再说明实际验证结果、生成或修改的文件；若仍有失败、未验证或未完成事项，明确写出。不要虚构检查通过、文件数量或完成状态。
文件链接使用项目相对路径，便于在应用内查看。修改数量和耗时由应用在整轮结束后统计，无需反复列举。`;

/** Never discovers resources from the project, home directory, or pi's global configuration. */
export function isolatedResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** Resolve the exact per-session directory before reading a persisted pi transcript. */
export async function sessionStorage(request: RunRequest): Promise<{ directory: string; file?: string }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.sessionId)) throw new Error('会话标识无效。');
  const dataRoot = await realpath(request.dataDir);
  const sessions = path.join(dataRoot, 'sessions');
  await mkdir(sessions, { recursive: true });
  const sessionsReal = await realpath(sessions);
  if (!isWithin(dataRoot, sessionsReal)) throw new Error('会话目录不能指向数据目录以外。');
  const directory = path.join(sessionsReal, request.sessionId);
  await mkdir(directory, { recursive: true });
  const directoryReal = await realpath(directory);
  if (path.relative(sessionsReal, directoryReal) !== request.sessionId) throw new Error('会话目录链接无效。');
  if (!request.piFile) return { directory: directoryReal };
  const file = await realpath(request.piFile);
  if (path.dirname(file).toLowerCase() !== directoryReal.toLowerCase() || path.extname(file) !== '.jsonl' || !(await stat(file)).isFile()) {
    throw new Error('会话文件必须属于当前会话目录。');
  }
  return { directory: directoryReal, file };
}

export function strictTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map(tool => {
    const validator = Compile(tool.parameters);
    return { ...tool, prepareArguments: (args: unknown) => {
      // pi normally coerces primitive values. File/terminal tools must reject invalid raw input instead.
      if (!validator.Check(args)) {
        const errors = validator.Errors(args).map(error => `${error.instancePath || '/'}: ${error.message}`).join('; ');
        throw new Error(`Validation failed for tool "${tool.name}": ${errors}. 请按工具声明纠正参数。`);
      }
      return args as Record<string, unknown>;
    } };
  });
}

export async function createPiSession(request: RunRequest, context: EngineToolContext, signal: AbortSignal): Promise<EngineSession> {
  const storage = await sessionStorage(request);
  signal.throwIfAborted();
  const providerId = 'localcode-selected';
  const local = request.provider.kind === 'ollama';
  const lowContext = request.provider.contextWindow <= 4096;
  const maxTokens = request.provider.maxTokens;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false, signal });
  let transportError: string | undefined;
  const transport = !local ? managedTransport({ signal,
    acquire: context.acquireRequest ?? (async () => ({ release() {} })),
    progress: progress => context.emit({ type: 'progress', runId: request.runId, sessionId: request.sessionId, progress }),
    telemetry: (type, fields) => context.telemetry?.(type, fields),
    failure: message => { transportError = message; context.transportFailure?.(message); },
  }) : undefined;
  if (transport) {
    const original = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = (model, ctx, options) => original(model, ctx, { ...options,
      fetch: transport.fetch, maxRetries: 0,
      onProviderStreamEvent: async (event, currentModel) => { transport.observe(event); await options?.onProviderStreamEvent?.(event, currentModel); },
    });
  }
  runtime.registerProvider(providerId, {
    name: request.provider.name, api: request.provider.kind === 'anthropic' ? 'anthropic-messages' : request.provider.kind === 'responses' ? 'openai-responses' : 'openai-completions', baseUrl: request.provider.baseUrl,
    models: [{ id: request.provider.model, name: request.provider.model, reasoning: local, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: request.provider.contextWindow, maxTokens,
      thinkingLevelMap: local ? { off: 'none' } : undefined,
      samplingParams: { ...(request.provider.kind === 'responses' ? { max_output_tokens: maxTokens } : { max_tokens: maxTokens }), temperature: 0.2, ...(request.provider.kind === 'anthropic' ? {} : { parallel_tool_calls: false }),
        ...(local ? { reasoning_effort: 'none' } : {}) },
      compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false, supportsStore: false,
        supportsReasoningEffort: local },
    }],
  });
  await runtime.setRuntimeApiKey(providerId, request.provider.apiKey || (local ? 'ollama-local' : 'localcode-configured'));
  signal.throwIfAborted();
  const model = runtime.getModel(providerId, request.provider.model);
  if (!model) throw new Error('指定模型未注册；未尝试其他模型。');
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: lowContext ? 1024 : 1536, keepRecentTokens: lowContext ? 1024 : 2048 },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, cacheWarming: 'off',
  });
  const customTools = strictTools(createWorkspaceTools(context));
  const sessionManager = storage.file ? SessionManager.open(storage.file, storage.directory, request.projectPath)
    : SessionManager.create(request.projectPath, storage.directory);
  const key = cloudKey(request);
  if (key) {
    // AgentSession writes messages itself, before main-process/UI filtering can protect JSONL.
    const appendMessage = sessionManager.appendMessage.bind(sessionManager);
    sessionManager.appendMessage = message => appendMessage(redactValue(message.role === 'assistant' && message.stopReason === 'error' && transportError
      ? { ...message, errorMessage: transportError } : message, key));
  }
  const { session } = await createAgentSession({
    cwd: request.projectPath, agentDir: path.join(request.dataDir, 'pi'), modelRuntime: runtime, model,
    thinkingLevel: 'off', sessionManager, settingsManager, resourceLoader: isolatedResourceLoader(),
    noTools: 'builtin', tools: customTools.map(tool => tool.name), customTools,
  });
  session.agent.toolExecution = 'sequential';
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, ctx, options) => {
    // pi also uses this function for hidden compaction. It must not consume or
    // receive the prompt for the user-visible final response.
    if (!context.beforeModelRequest?.(session.isCompacting ? 'compaction' : 'assistant')) return stream(model, ctx, options);
    // Preparation may compact first; once the final response starts, no hidden
    // post-response compaction or overflow retry may extend this final phase.
    session.setAutoCompactionEnabled(false);
    // Tool declarations may live in any system message, not just ctx.tools.
    // Modify only this request: resumed turns must retain their normal tool loadout.
    const messages = ctx.messages.map(message => {
      if (message.role !== 'system') return message;
      const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
      return rest;
    });
    return stream(model, normalizeContext({ messages: [...messages,
      { role: 'system', content: FINAL_SUMMARY_PROMPT, timestamp: Date.now() }], tools: [] }), options);
  };
  if (transport) { const dispose = session.dispose.bind(session); session.dispose = () => { transport.close(); dispose(); }; }
  if (signal.aborted) session.dispose();
  signal.throwIfAborted();
  return session;
}

function resultText(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const value = result as { details?: { fullOutput?: unknown }; content?: { type: string; text?: string }[] };
  if (typeof value.details?.fullOutput === 'string') return value.details.fullOutput.slice(0, 1024 * 1024);
  return (value.content ?? []).filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
}

/** One active run. Authoritative model context lives in pi's session manager, never UI message arrays. */
export class AgentEngine {
  private active?: ActiveRun;
  private closed = false;
  private readonly createSession: NonNullable<EngineOptions['createSession']>;
  private readonly killCommands: NonNullable<EngineOptions['killCommands']>;
  private readonly optionsAcquire: NonNullable<EngineOptions['acquireRequest']>;
  constructor(private readonly emit: (event: AgentEvent) => void, options: EngineOptions = {}) {
    this.createSession = options.createSession ?? createPiSession;
    this.killCommands = options.killCommands ?? killActiveCommands;
    this.optionsAcquire = options.acquireRequest ?? (async () => ({ release() {} }));
  }

  async handle(command: WorkerCommand): Promise<void> {
    if (command.type === 'shutdown') return this.shutdown();
    if (command.type === 'approve') {
      const run = this.active;
      if (!run || command.runId !== run.request.runId || run.controller.signal.aborted) return;
      run.pending.get(command.approvalId)?.resolve(command.allow);
      return;
    }
    if (command.type === 'abort') {
      if (this.active?.request.runId === command.runId) await this.abort();
      return;
    }
    if (this.closed) throw new Error('Agent 已关闭。');
    if (this.active) throw new Error('已有任务正在运行。');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(command.runId)) throw new Error('任务标识无效。');
    let resolveSettled!: () => void;
    const run: ActiveRun = { request: command, controller: new AbortController(), toolCalls: 0, invalidCalls: 0,
      assistantSeq: 0, budgetExhausted: false, summaryRequests: 0, summaryCompactionRequests: 0,
      userAborted: false, settled: false, pending: new Map(), startedAt: Date.now(),
      redactionKey: cloudKey(command), streamBuffers: new Map(), parts: new Map(),
      settledPromise: new Promise<void>(resolve => { resolveSettled = resolve; }), resolveSettled: () => resolveSettled(), done: Promise.resolve() };
    this.active = run;
    run.done = this.run(run);
    return run.done;
  }

  async abort(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.userAborted = true;
    this.cancel(run);
    await run.done;
  }

  async shutdown(): Promise<void> { this.closed = true; await this.abort(); }

  private send(run: ActiveRun, event: EventBody): void {
    if (event.type === 'progress') {
      if (run.progress?.phase === event.progress.phase && run.progress.retryAt === event.progress.retryAt) return;
      run.progress = event.progress;
    }
    this.emit(redactValue({ ...event, runId: run.request.runId, sessionId: run.request.sessionId } as AgentEvent, run.redactionKey));
  }

  private streamText(run: ActiveRun, messageId: string, delta: string, flush = false, index?: number): void {
    const bufferId = index === undefined ? messageId : `${messageId}:part:${index}`;
    const emit = (delta: string) => {
      this.send(run, index === undefined ? { type: 'text_delta', messageId, delta } : { type: 'part_delta', messageId, index, delta });
      if (index !== undefined && run.parts.get(index)?.kind === 'text') this.send(run, { type: 'text_delta', messageId, delta });
    };
    const key = run.redactionKey;
    if (!key) {
      if (delta) emit(delta);
      return;
    }
    const text = (run.streamBuffers.get(bufferId) ?? '') + delta;
    const safeEnd = flush ? text.length : Math.max(0, text.length - key.length + 1);
    let cursor = 0; let output = '';
    while (cursor < safeEnd) {
      const match = text.indexOf(key, cursor);
      if (match !== -1 && match < safeEnd) {
        output += text.slice(cursor, match) + redactionMarker(key);
        cursor = match + key.length;
      } else { output += text.slice(cursor, safeEnd); cursor = safeEnd; }
    }
    if (flush) run.streamBuffers.delete(bufferId);
    else run.streamBuffers.set(bufferId, text.slice(cursor));
    if (output) emit(output);
  }

  private log(run: ActiveRun, data: Record<string, unknown>): void {
    if (!run.logFile) return;
    // Only explicit telemetry fields are accepted here; never serialize RunRequest/provider secrets.
    try { appendFileSync(run.logFile, JSON.stringify(redactValue({ at: new Date().toISOString(), elapsedMs: Date.now() - run.startedAt, ...data }, run.redactionKey)) + '\n', 'utf8'); }
    catch { /* UI results remain available if the log disk becomes unavailable mid-run. */ }
  }

  private publishSessionFile(run: ActiveRun): void {
    const file = run.session?.sessionManager.getSessionFile();
    // New pi sessions are lazy: avoid indexing a nonexistent file if startup is cancelled.
    if (file && file !== run.publishedFile && existsSync(file)) {
      run.publishedFile = file;
      this.send(run, { type: 'session_file', file });
    }
  }

  private cancel(run: ActiveRun): void {
    if (!run.controller.signal.aborted) run.controller.abort();
    for (const pending of [...run.pending.values()]) pending.resolve(false);
    run.session?.clearQueue();
    run.cleanup ??= Promise.resolve(this.killCommands());
    // Never await an abort from a pi event listener: it waits for that same event to return.
    if (run.session) void run.session.abort().catch(error => { run.failure ??= String(error); });
  }

  private fail(run: ActiveRun, message: string): void {
    if (run.failure) return;
    run.failure = message;
    this.send(run, { type: 'error', message });
    this.cancel(run);
  }

  private requestApproval(run: ActiveRun, input: { command: string; cwd: string }, signal?: AbortSignal): Promise<boolean> {
    if (run.controller.signal.aborted || signal?.aborted || this.active !== run) return Promise.resolve(false);
    const approval: Approval = { ...input, id: randomUUID(), runId: run.request.runId, sessionId: run.request.sessionId };
    return new Promise(resolve => {
      const abort = () => finish(false);
      const finish = (allow: boolean) => {
        if (!run.pending.delete(approval.id)) return;
        signal?.removeEventListener('abort', abort);
        run.controller.signal.removeEventListener('abort', abort);
        this.send(run, { type: 'approval_resolved', approvalId: approval.id });
        if (!run.controller.signal.aborted) this.send(run, { type: 'status', status: 'running' });
        resolve(allow && !signal?.aborted && !run.controller.signal.aborted && this.active === run);
      };
      run.pending.set(approval.id, { resolve: finish });
      signal?.addEventListener('abort', abort, { once: true });
      run.controller.signal.addEventListener('abort', abort, { once: true });
      this.send(run, { type: 'status', status: 'awaiting_approval' });
      this.send(run, { type: 'approval', approval });
    });
  }

  private onEvent(run: ActiveRun, event: AgentSessionEvent): void {
    if (this.active !== run) return;
    this.publishSessionFile(run);
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') {
          run.messageId = `${run.request.runId}:assistant:${++run.assistantSeq}`;
          run.parts.clear();
          this.send(run, { type: 'message_start', messageId: run.messageId });
        }
        break;
      case 'message_update': {
        const update = event.assistantMessageEvent;
        if (!run.messageId) break;
        if (update.type === 'text_start' || update.type === 'thinking_start' || update.type === 'text_delta' || update.type === 'thinking_delta') {
          const index = update.contentIndex ?? 0;
          const kind = update.type.startsWith('thinking') ? 'thinking' : 'text';
          // Redacted/encrypted content and signatures must never reach UI or display storage.
          const block = update.partial?.content?.[index];
          if (kind === 'thinking' && block?.type === 'thinking' && block.redacted) break;
          if (!run.parts.has(index)) {
            run.parts.set(index, { kind, ended: false });
            this.send(run, { type: 'part_start', messageId: run.messageId, index, kind, at: new Date().toISOString() });
          }
          if (update.type === 'text_delta' || update.type === 'thinking_delta') {
            if (kind === 'text' && !run.firstTextAt) { run.firstTextAt = Date.now(); this.log(run, { type: 'first_text' }); }
            if (kind === 'thinking' && !run.firstThinkingAt) { run.firstThinkingAt = Date.now(); this.log(run, { type: 'first_thinking' }); }
            this.send(run, { type: 'progress', progress: { phase: kind === 'text' ? 'output' : 'thinking', since: new Date().toISOString() } });
            this.streamText(run, run.messageId, update.delta, false, index);
          }
        } else if (update.type === 'text_end' || update.type === 'thinking_end') {
          this.endPart(run, update.contentIndex, false, update.content);
        } else if (update.type === 'toolcall_start' || update.type === 'toolcall_delta') {
          this.send(run, { type: 'progress', progress: { phase: 'output', since: new Date().toISOString() } });
        }
        break;
      }
      case 'message_end':
        if (event.message.role === 'assistant') {
          const id = run.messageId ?? `${run.request.runId}:assistant:${++run.assistantSeq}`;
          for (const [index] of run.parts) this.endPart(run, index, event.message.stopReason === 'aborted' || event.message.stopReason === 'error');
          this.streamText(run, id, '', true);
          this.send(run, { type: 'message_end', messageId: id, text: resultText(event.message) });
          this.log(run, { type: 'model_usage', messageId: id, usage: event.message.usage, stopReason: event.message.stopReason });
          if (event.message.stopReason === 'error') run.failure ??= event.message.errorMessage || '模型请求失败。';
          if (event.message.stopReason === 'length') this.fail(run, '模型输出达到长度上限，回复已截断，本轮未完整完成。已收到的内容和文件修改已保留，可以发送新消息继续。');
          run.messageId = undefined;
        }
        break;
      case 'tool_execution_start':
        this.send(run, { type: 'progress', progress: { phase: 'tool', since: new Date().toISOString() } });
        this.send(run, { type: 'tool_start', toolCallId: event.toolCallId, name: event.toolName, args: event.args });
        if (run.toolCalls >= MAX_TOOL_CALLS) this.fail(run, BUDGET_EXHAUSTED);
        else ++run.toolCalls;
        break;
      case 'tool_execution_end': {
        const text = resultText(event.result);
        this.send(run, { type: 'tool_result', toolCallId: event.toolCallId, result: text, isError: event.isError });
        if (event.isError && /^(?:Validation failed for tool |Invalid arguments for tool |Tool .+ not found)/.test(text)) {
          if (++run.invalidCalls >= 2) this.fail(run, '工具参数再次未通过验证，本轮已停止。请调整请求后重试。');
          else if (run.toolCalls < MAX_TOOL_CALLS) this.send(run, { type: 'notice', message: '工具参数未通过验证，允许模型纠正一次；无效调用未执行。' });
        }
        if (run.toolCalls >= MAX_TOOL_CALLS && !run.controller.signal.aborted && !run.budgetExhausted) {
          run.budgetExhausted = true;
          this.send(run, { type: 'notice', message: '本轮 12 次工具调用预算已耗尽，正在根据已有结果生成最后一条总结；不会再执行工具。' });
        }
        break;
      }
      case 'compaction_start': this.send(run, { type: 'notice', message: '正在压缩会话上下文…' }); break;
      case 'compaction_end':
        if (event.errorMessage && !event.aborted) this.fail(run, `上下文压缩失败：${event.errorMessage}`);
        break;
      case 'agent_settled': run.settled = true; run.resolveSettled(); break;
    }
  }

  private endPart(run: ActiveRun, index: number, interrupted: boolean, text?: string) {
    const part = run.parts.get(index);
    if (!part || part.ended || !run.messageId) return;
    this.streamText(run, run.messageId, '', true, index);
    part.ended = true;
    this.send(run, { type: 'part_end', messageId: run.messageId, index, at: new Date().toISOString(), interrupted, ...(text === undefined ? {} : { text }) });
  }

  private async run(run: ActiveRun): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    try {
      this.send(run, { type: 'status', status: 'running' });
      const request = run.request;
      await workspaceBoundary(request);
      const logs = path.join(request.dataDir, 'logs'); await mkdir(logs, { recursive: true });
      run.logFile = path.join(logs, `agent-${request.runId}.jsonl`);
      this.log(run, { type: 'run_start', sessionId: request.sessionId, model: request.provider.model,
        contextWindow: request.provider.contextWindow, maxTokens: request.provider.maxTokens });
      run.controller.signal.throwIfAborted();
      const context: EngineToolContext = { projectPath: request.projectPath, dataDir: request.dataDir, protectedRoots: request.protectedRoots,
        sessionId: request.sessionId, runId: request.runId,
        maxResultChars: request.provider.contextWindow <= 4096 ? 1800 : 4000,
        emit: event => { if (this.active === run) this.send(run, event); },
        acquireRequest: signal => this.optionsAcquire(request, signal),
        telemetry: (type, fields) => this.log(run, { type, ...fields }),
        transportFailure: message => { run.failure ??= message; },
        requestApproval: (input, signal) => this.requestApproval(run, input, signal),
        beforeTool: () => {
          run.controller.signal.throwIfAborted();
          if (this.active !== run || run.budgetExhausted) throw new Error('当前任务已失效或已达到工具调用上限。');
        },
        beforeModelRequest: (purpose = 'assistant') => {
          run.controller.signal.throwIfAborted();
          if (!run.budgetExhausted) return false;
          if (purpose === 'compaction') {
            if (run.summaryRequests === 0 && run.summaryCompactionRequests < MAX_FINAL_COMPACTION_REQUESTS) {
              run.summaryCompactionRequests++;
              return false;
            }
            const message = '本轮工具预算已耗尽，收尾上下文整理达到请求上限或最终回复已经开始，已停止进一步请求。已有回复和修改已保留，请发送新消息继续。';
            this.fail(run, message);
            throw new Error(message);
          }
          if (run.summaryRequests === 0) { run.summaryRequests++; return true; }
          // Even a provider ignoring the no-tools request cannot extend the loop.
          this.fail(run, BUDGET_EXHAUSTED);
          throw new Error(BUDGET_EXHAUSTED);
        },
      };
      run.session = await this.createSession(request, context, run.controller.signal);
      run.controller.signal.throwIfAborted();
      this.publishSessionFile(run);
      unsubscribe = run.session.subscribe(event => this.onEvent(run, event));
      await run.session.prompt(request.prompt, { expandPromptTemplates: false });
      await run.settledPromise;
      await run.session.waitForIdle();
    } catch (error) {
      if (!run.userAborted && !run.failure) run.failure = error instanceof Error ? error.message : String(error);
    } finally {
      run.controller.abort();
      this.publishSessionFile(run);
      for (const pending of [...run.pending.values()]) pending.resolve(false);
      run.session?.clearQueue();
      try {
        await run.session?.abort();
        await (run.cleanup ?? this.killCommands());
      } catch (error) { run.failure ??= `任务清理失败：${String(error)}`; }
      unsubscribe?.();
      run.session?.dispose();
      for (const [index] of run.parts) this.endPart(run, index, true);
      for (const messageId of run.streamBuffers.keys()) this.streamText(run, messageId, '', true);
      if (this.active === run) this.active = undefined;
      if (run.budgetExhausted && !run.userAborted) run.failure ??= BUDGET_EXHAUSTED;
      const status = run.userAborted ? 'interrupted' : run.failure ? 'failed' : 'completed';
      this.log(run, { type: 'run_settled', status, toolCalls: run.toolCalls, invalidCalls: run.invalidCalls,
        summaryRequests: run.summaryRequests, summaryCompactionRequests: run.summaryCompactionRequests,
        firstTextMs: run.firstTextAt ? run.firstTextAt - run.startedAt : undefined,
        firstThinkingMs: run.firstThinkingAt ? run.firstThinkingAt - run.startedAt : undefined });
      if (run.failure && !run.userAborted) this.send(run, { type: 'error', message: run.failure });
      this.send(run, { type: 'settled', status, ...(run.failure ? { error: run.failure } : {}) });
    }
  }
}
