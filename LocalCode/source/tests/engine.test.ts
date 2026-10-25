import { workspaceContext } from '../src/core/workspace-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { AgentEngine, sessionStorage, type EngineSession, type EngineToolContext } from '../src/agent/engine.js';
import type { AgentEvent, RunRequest } from '../src/shared/contracts.js';

const temporary: string[] = [];
afterEach(async () => { for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function request(runId = 'run1', sessionId = 'session1'): Promise<RunRequest> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localcode-engine-'));
  temporary.push(root);
  const projectPath = path.join(root, 'project'); const dataDir = path.join(root, 'data');
  await Promise.all([mkdir(projectPath), mkdir(dataDir)]);
  return { type: 'run', runId, sessionId, ...workspaceContext(await realpath(projectPath), dataDir), prompt: '测试',
    provider: { id: 'mock', name: 'Mock', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1',
      model: 'mock-model', contextWindow: 8192, maxTokens: 1024, apiKey: 'mock-never-persist-this-test-key', hasKey: true } };
}
class FakeSession implements EngineSession {
  listeners = new Set<(event: AgentSessionEvent) => void>();
  started = false; disposed = false; queueCleared = false;
  private finishPrompt!: () => void;
  private promptPromise = new Promise<void>(resolve => { this.finishPrompt = resolve; });
  sessionManager = { getSessionFile: () => undefined };
  subscribe(listener: (event: AgentSessionEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  prompt() { this.started = true; return this.promptPromise; }
  emit(event: Record<string, unknown>) { for (const listener of this.listeners) listener(event as unknown as AgentSessionEvent); }
  settle(aborted = false) { this.emit({ type: 'agent_settled', aborted }); this.finishPrompt(); }
  async abort() { this.settle(true); }
  async waitForIdle() { await this.promptPromise; }
  clearQueue() { this.queueCleared = true; }
  dispose() { this.disposed = true; }
}
function fakeEngine(killCommands: () => Promise<unknown> = async () => {}) {
  const events: AgentEvent[] = []; const sessions: FakeSession[] = []; const contexts: EngineToolContext[] = [];
  const engine = new AgentEngine(event => events.push(event), { killCommands,
    createSession: async (_request, ctx) => { contexts.push(ctx); const session = new FakeSession(); sessions.push(session); return session; } });
  return { engine, events, sessions, contexts };
}

describe('AgentEngine lifecycle and approval fencing', () => {
  it('preserves truncated output but never marks a length-limited answer completed', async () => {
    const f = fakeEngine(); const done = f.engine.handle(await request());
    await vi.waitFor(() => expect(f.sessions[0]?.started).toBe(true));
    f.sessions[0].emit({ type: 'message_start', message: { role: 'assistant' } });
    f.sessions[0].emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '只输出了前半段' }], stopReason: 'length' } });
    f.sessions[0].settle(); await done;
    expect(f.events.find(event => event.type === 'message_end')).toMatchObject({ text: '只输出了前半段' });
    expect(f.events.at(-1)).toMatchObject({ type: 'settled', status: 'failed', error: expect.stringContaining('长度上限') });
    expect(f.events.some(event => event.type === 'settled' && event.status === 'completed')).toBe(false);
    expect(f.sessions[0].queueCleared).toBe(true);
    expect(() => f.contexts[0].beforeTool('write_file', {})).toThrow();
  });

  it('does not finish on agent_end, and releases a run only after cleanup', async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    const f = fakeEngine(() => cleanup); const req = await request(); const done = f.engine.handle(req);
    await vi.waitFor(() => expect(f.sessions[0]?.started).toBe(true));
    f.sessions[0].emit({ type: 'agent_end', messages: [], willRetry: false });
    expect(f.events.some(event => event.type === 'settled')).toBe(false);
    f.sessions[0].settle();
    await Promise.resolve();
    expect(f.events.some(event => event.type === 'settled')).toBe(false);
    await expect(f.engine.handle({ ...req, runId: 'overlap' })).rejects.toThrow('已有任务');
    finishCleanup(); await done;
    expect(f.events.at(-1)).toMatchObject({ type: 'settled', status: 'completed' });
    expect(f.sessions[0].disposed).toBe(true);
  });

  it('requires matching run and approval IDs; denial and abort cannot execute a command', async () => {
    const f = fakeEngine(); const req = await request(); const done = f.engine.handle(req);
    await vi.waitFor(() => expect(f.sessions[0]?.started).toBe(true));
    const execute = vi.fn();
    const wait = f.contexts[0].requestApproval({ command: 'throw "do not run"', cwd: req.projectPath }).then(allowed => { if (allowed) execute(); return allowed; });
    const approval = f.events.find(event => event.type === 'approval');
    if (approval?.type !== 'approval') throw new Error('Missing approval');
    await f.engine.handle({ type: 'approve', runId: 'stale-run', approvalId: approval.approval.id, allow: true });
    await f.engine.handle({ type: 'approve', runId: req.runId, approvalId: 'wrong-id', allow: true });
    expect(execute).not.toHaveBeenCalled();
    expect(f.events.filter(event => event.type === 'approval_resolved')).toHaveLength(0);
    await f.engine.handle({ type: 'approve', runId: req.runId, approvalId: approval.approval.id, allow: false });
    expect(await wait).toBe(false); expect(execute).not.toHaveBeenCalled();
    const cancelled = f.contexts[0].requestApproval({ command: 'Write-Output test', cwd: req.projectPath });
    const pending = f.events.filter(event => event.type === 'approval').at(-1)!;
    await f.engine.handle({ type: 'abort', runId: req.runId }); await done;
    expect(await cancelled).toBe(false);
    if (pending.type !== 'approval') throw new Error('Missing approval');
    await f.engine.handle({ type: 'approve', runId: req.runId, approvalId: pending.approval.id, allow: true });
    expect(f.sessions[0].queueCleared).toBe(true);
    expect(f.events.at(-1)).toMatchObject({ type: 'settled', status: 'interrupted' });
    const next = f.engine.handle({ ...req, runId: 'run2' });
    await vi.waitFor(() => expect(f.sessions[1]?.started).toBe(true));
    const nextApproval = f.contexts[1].requestApproval({ command: 'new command', cwd: req.projectPath });
    await f.engine.handle({ type: 'approve', runId: 'run2', approvalId: pending.approval.id, allow: true });
    expect(f.events.at(-1)?.type).toBe('approval');
    await f.engine.abort(); expect(await nextApproval).toBe(false); await next;
  });

  it('allows one schema correction and stops on the second invalid call', async () => {
    const f = fakeEngine(); const done = f.engine.handle(await request());
    await vi.waitFor(() => expect(f.sessions[0]?.started).toBe(true));
    for (let i = 0; i < 2; i++) {
      f.sessions[0].emit({ type: 'tool_execution_start', toolCallId: `bad${i}`, toolName: 'read_file', args: {} });
      f.sessions[0].emit({ type: 'tool_execution_end', toolCallId: `bad${i}`, toolName: 'read_file', isError: true,
        result: { content: [{ type: 'text', text: 'Validation failed for tool "read_file": path missing' }] } });
      if (i === 0) expect(f.events.some(event => event.type === 'settled')).toBe(false);
    }
    await done;
    expect(f.events.filter(event => event.type === 'notice')).toHaveLength(1);
    expect(f.events.at(-1)).toMatchObject({ type: 'settled', status: 'failed', error: expect.stringContaining('参数') });
  });

  it('allows exactly one final text response after twelve calls and preserves stable message IDs', async () => {
    const f = fakeEngine(); const done = f.engine.handle(await request());
    await vi.waitFor(() => expect(f.sessions[0]?.started).toBe(true));
    const session = f.sessions[0];
    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好' }], stopReason: 'toolUse' } });
    for (let i = 0; i < 12; i++) {
      session.emit({ type: 'tool_execution_start', toolCallId: `tool${i}`, toolName: 'read_file', args: { path: 'a' } });
      f.contexts[0].beforeTool('read_file', { path: 'a' });
      session.emit({ type: 'tool_execution_end', toolCallId: `tool${i}`, toolName: 'read_file', isError: false,
        result: { content: [{ type: 'text', text: 'budget' }], details: { fullOutput: 'complete output' } } });
    }
    expect(f.events.some(event => event.type === 'settled')).toBe(false);
    expect(() => f.contexts[0].beforeTool('write_file', {})).toThrow(/上限/);
    expect(f.contexts[0].beforeModelRequest?.()).toBe(true);
    session.emit({ type: 'message_start', message: { role: 'assistant' } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '已读取文件，尚未修改或验证。' }], stopReason: 'stop' } });
    session.settle(); await done;
    const messages = f.events.filter(event => 'messageId' in event);
    expect(new Set(messages.map(event => 'messageId' in event && event.messageId)).size).toBe(2);
    expect(f.events.filter(event => event.type === 'message_end')).toEqual([
      expect.objectContaining({ messageId: 'run1:assistant:1', text: '你好' }),
      expect.objectContaining({ messageId: 'run1:assistant:2', text: '已读取文件，尚未修改或验证。' }),
    ]);
    expect(f.events.find(event => event.type === 'tool_result')).toMatchObject({ result: 'complete output' });
    expect(f.events.at(-1)).toMatchObject({ type: 'settled', status: 'failed', error: expect.stringContaining('预算已耗尽') });
    expect(() => f.contexts[0].beforeTool('read_file', {})).toThrow();
  });

  it.each(['extra request', 'extra tool', 'user cancellation'] as const)('keeps the summary phase bounded for %s', async action => {
    const f = fakeEngine(); const done = f.engine.handle(await request());
    await vi.waitFor(() => expect(f.sessions[0]?.started).toBe(true));
    const session = f.sessions[0];
    for (let i = 0; i < 12; i++) {
      session.emit({ type: 'tool_execution_start', toolCallId: `tool${i}`, toolName: 'read_file', args: {} });
      f.contexts[0].beforeTool('read_file', {});
      session.emit({ type: 'tool_execution_end', toolCallId: `tool${i}`, toolName: 'read_file', isError: false, result: { content: [] } });
    }
    expect(f.contexts[0].beforeModelRequest?.()).toBe(true);
    if (action === 'extra request') expect(() => f.contexts[0].beforeModelRequest?.()).toThrow(/预算已耗尽/);
    else if (action === 'extra tool') {
      session.emit({ type: 'tool_execution_start', toolCallId: 'forbidden', toolName: 'write_file', args: {} });
      expect(() => f.contexts[0].beforeTool('write_file', {})).toThrow();
    } else await f.engine.abort();
    await done;
    expect(f.events.at(-1)).toMatchObject({ type: 'settled', status: action === 'user cancellation' ? 'interrupted' : 'failed' });
    expect(f.sessions[0].queueCleared).toBe(true);
  });

  it.each(['excess compaction', 'compaction after final'] as const)('bounds hidden final-phase requests: %s', async action => {
    const f = fakeEngine(); const done = f.engine.handle(await request());
    await vi.waitFor(() => expect(f.sessions[0]?.started).toBe(true));
    for (let i = 0; i < 12; i++) {
      f.sessions[0].emit({ type: 'tool_execution_start', toolCallId: `tool${i}`, toolName: 'read_file', args: {} });
      f.contexts[0].beforeTool('read_file', {});
      f.sessions[0].emit({ type: 'tool_execution_end', toolCallId: `tool${i}`, toolName: 'read_file', isError: false, result: { content: [] } });
    }
    expect(f.contexts[0].beforeModelRequest?.('compaction')).toBe(false);
    expect(f.contexts[0].beforeModelRequest?.('compaction')).toBe(false);
    if (action === 'compaction after final') expect(f.contexts[0].beforeModelRequest?.('assistant')).toBe(true);
    expect(() => f.contexts[0].beforeModelRequest?.('compaction')).toThrow(/收尾上下文整理/);
    await done;
    expect(f.events.at(-1)).toMatchObject({ type: 'settled', status: 'failed' });
  });
});

describe('session boundary', () => {
  it('rejects another session transcript and traversal identifiers', async () => {
    const req = await request();
    await mkdir(path.join(req.dataDir, 'sessions', 'another'), { recursive: true });
    const outside = path.join(req.dataDir, 'sessions', 'another', 'old.jsonl'); await writeFile(outside, '{}');
    await expect(sessionStorage({ ...req, piFile: outside })).rejects.toThrow('当前会话目录');
    await expect(sessionStorage({ ...req, sessionId: '../outside' })).rejects.toThrow('标识');
  });
});

async function closeServer(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
it.each(['text', 'forbidden tool'] as const)('uses real pi to offer one tool-disabled final response after call twelve: %s', async finalResponse => {
  const req = await request();
  const payloads: Record<string, unknown>[] = [];
  const server = createServer(async (incoming, response) => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    payloads.push(JSON.parse(body));
    const index = payloads.length;
    const tool = index <= 12 || finalResponse === 'forbidden tool';
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `budget-${index}`, type: 'function', function: {
      name: 'write_file', arguments: JSON.stringify({ path: index <= 12 ? 'budget.txt' : 'forbidden.txt', content: `write ${index}` }),
    } }] } : { role: 'assistant', content: '已修改 budget.txt；未运行测试，仍需验证。' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: `budget-${index}`, object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: `budget-${index}`, object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local server');
  req.provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const events: AgentEvent[] = []; const engine = new AgentEngine(event => events.push(event));
  try {
    await engine.handle(req);
    expect(payloads).toHaveLength(13);
    expect(payloads[11].tools).toBeDefined();
    expect(payloads[12].tools ?? []).toEqual([]);
    expect(JSON.stringify(payloads[12].messages)).toContain('禁止再调用任何工具');
    expect(await readFile(path.join(req.projectPath, 'budget.txt'), 'utf8')).toBe('write 12');
    await expect(readFile(path.join(req.projectPath, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events.filter(event => event.type === 'tool_result' && !event.isError)).toHaveLength(12);
    if (finalResponse === 'text') expect(events.find(event => event.type === 'message_end' && event.text.includes('未运行测试'))).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'failed', error: expect.stringContaining('预算已耗尽') });
    if (finalResponse === 'text') {
      const saved = events.find(event => event.type === 'session_file');
      if (saved?.type !== 'session_file') throw new Error('Missing saved session');
      await engine.handle({ ...req, runId: 'after-budget', piFile: saved.file, prompt: '继续检查' });
      expect(payloads).toHaveLength(14);
      expect(payloads[13].tools).toBeDefined();
      expect(JSON.stringify(payloads[13].messages)).not.toContain('禁止再调用任何工具');
      expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'completed', runId: 'after-budget' });
    }
  } finally { await engine.shutdown(); await closeServer(server); }
}, 30_000);

it('uses real pi against a local mock API: streams, strictly validates tools, persists and resumes without storing keys', async () => {
  const req = await request(); await writeFile(path.join(req.projectPath, 'hello.txt'), '原有内容\n');
  await writeFile(path.join(req.projectPath, 'AGENTS.md'), 'AUTO_RESOURCE_SHOULD_NOT_LOAD');
  const payloads: Record<string, unknown>[] = [];
  const server = createServer(async (incoming, response) => {
    if (incoming.method === 'GET') { response.end('ok'); return; }
    let body = ''; for await (const chunk of incoming) body += chunk;
    payloads.push(JSON.parse(body));
    const index = payloads.length;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const tool = index <= 2;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: {
      name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt', startLine: index === 1 ? '1' : 1 }),
    } }] } : { role: 'assistant', content: index === 3 ? '已读取中文文件。' : '记得之前读取的原有内容。' };
    response.write(`data: ${JSON.stringify({ id: `completion-${index}`, object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: `completion-${index}`, object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local server');
  req.provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  expect(await (await fetch(req.provider.baseUrl)).text()).toBe('ok');
  // Ollama uses the same compatible transport; the local fixture verifies off/max_tokens request fields.
  req.provider.kind = 'ollama';
  req.provider.contextWindow = 16384;
  req.provider.maxTokens = 2048;
  const events: AgentEvent[] = []; const engine = new AgentEngine(event => events.push(event));
  try {
    await engine.handle(req);
    expect(events.at(-1), JSON.stringify({ errors: events.filter(event => event.type === 'error'), requests: payloads.length })).toMatchObject({ type: 'settled', status: 'completed' });
    expect(events.filter(event => event.type === 'tool_result')).toEqual([
      expect.objectContaining({ isError: true, result: expect.stringContaining('Validation failed') }),
      expect.objectContaining({ isError: false, result: expect.stringContaining('原有内容') }),
    ]);
    expect(events.some(event => event.type === 'text_delta' && event.delta.includes('中文'))).toBe(true);
    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toMatchObject({ max_tokens: 2048, reasoning_effort: 'none', parallel_tool_calls: false });
    const selectedTools = (payloads[0].tools as { function: { name: string } }[]).map(tool => tool.function.name);
    expect(selectedTools).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'powershell']));
    expect(selectedTools).not.toContain('bash');
    expect(JSON.stringify(payloads[0])).not.toContain('AUTO_RESOURCE_SHOULD_NOT_LOAD');
    const saved = events.find(event => event.type === 'session_file');
    if (saved?.type !== 'session_file') throw new Error('No saved session file');
    const jsonl = await readFile(saved.file, 'utf8');
    expect(jsonl).toContain('原有内容'); expect(jsonl).not.toContain(req.provider.apiKey);
    await engine.handle({ ...req, runId: 'resumed', provider: { ...req.provider, kind: 'openai' }, piFile: saved.file, prompt: '之前读到了什么？' });
    expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'completed', runId: 'resumed' });
    expect(JSON.stringify(payloads[3].messages)).toContain('原有内容');
    expect(payloads[3]).not.toHaveProperty('reasoning_effort');
    expect((await readdir(path.dirname(saved.file))).filter(file => file.endsWith('.jsonl'))).toHaveLength(1);
  } finally { await engine.shutdown(); await closeServer(server); }
}, 30_000);

it('keeps threshold compaction separate from the one visible final summary after tool twelve', async () => {
  const req = await request('budget-compaction');
  const payloads: Record<string, unknown>[] = []; const compactions: Record<string, unknown>[] = [];
  let assistantRequests = 0;
  const server = createServer(async (incoming, response) => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    const payload = JSON.parse(body); payloads.push(payload);
    const compacting = (payload.messages as { role: string; content: string }[]).some(message => message.role === 'system' && message.content.startsWith('You are a context summarization assistant.'));
    if (compacting) compactions.push(payload); else assistantRequests++;
    const tool = !compacting && assistantRequests <= 12;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `compact-${assistantRequests}`, type: 'function', function: {
      name: 'write_file', arguments: JSON.stringify({ path: 'compacted.txt', content: `write ${assistantRequests}\n${'x'.repeat(1400)}` }),
    } }] } : { role: 'assistant', content: compacting ? 'Context checkpoint: compacted.txt was edited. Testing has not run.' : '可见最终总结：文件已修改，测试尚未运行。' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: `compact-${payloads.length}`, object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    const inputTokens = !compacting && (assistantRequests === 12 || assistantRequests === 14) ? 7000 : 100;
    response.write(`data: ${JSON.stringify({ id: `compact-${payloads.length}`, object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: 20, total_tokens: inputTokens + 20 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local server');
  req.provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const events: AgentEvent[] = []; const engine = new AgentEngine(event => events.push(event));
  try {
    await engine.handle(req);
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions.length).toBeLessThanOrEqual(2);
    for (const payload of compactions) expect(payload.tools ?? []).toEqual([]);
    expect(assistantRequests).toBe(13);
    expect(events.filter(event => event.type === 'message_end' && event.text.includes('可见最终总结'))).toHaveLength(1);
    expect(JSON.stringify(compactions)).not.toContain('禁止再调用任何工具');
    expect(payloads.at(-1)?.tools ?? []).toEqual([]);
    expect(events.filter(event => event.type === 'tool_result' && !event.isError)).toHaveLength(12);
    expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'failed', error: expect.stringContaining('预算已耗尽') });
    const saved = events.find(event => event.type === 'session_file');
    if (saved?.type !== 'session_file') throw new Error('Missing saved session');
    const firstCompactions = compactions.length;
    await engine.handle({ ...req, runId: 'compaction-restored', piFile: saved.file, prompt: `继续处理，恢复正常上下文压缩。${'r'.repeat(10000)}` });
    expect(compactions.length).toBeGreaterThan(firstCompactions);
    expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'completed', runId: 'compaction-restored' });
  } finally { await engine.shutdown(); await closeServer(server); }
}, 30_000);

it('redacts a cloud key split across SSE deltas and provider errors before events, JSONL, and logs', async () => {
  const req = await request('secret-stream', 'secret-session');
  const key = req.provider.apiKey;
  const prefix = '正常中文流式内容。'.repeat(25); const suffix = '；流式结束。';
  let requests = 0; let streamEnded = false; let streamedBeforeEnd = false;
  const payloads: unknown[] = [];
  const server = createServer(async (incoming, response) => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    payloads.push(JSON.parse(body));
    if (++requests === 2) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Invalid configured API key: ${key}`, type: 'authentication_error' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (content: string, finish = false) => response.write(`data: ${JSON.stringify({ id: 'secret-stream', object: 'chat.completion.chunk', model: 'mock-model',
      choices: [{ index: 0, delta: finish ? {} : { content }, finish_reason: finish ? 'stop' : null }],
      ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } } : {}),
    })}\n\n`);
    chunk(prefix);
    await new Promise(resolve => setTimeout(resolve, 100));
    // No individual provider delta contains the full key: a per-delta replace cannot pass this test.
    for (const piece of [key.slice(0, 3), key.slice(3, 11), key.slice(11), suffix]) {
      chunk(piece); await new Promise(resolve => setTimeout(resolve, 5));
    }
    streamEnded = true; chunk('', true); response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local server');
  req.provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const events: AgentEvent[] = [];
  const engine = new AgentEngine(event => {
    events.push(event);
    if (event.type === 'text_delta' && !streamEnded) streamedBeforeEnd = true;
  });
  try {
    await engine.handle(req);
    expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'completed' });
    expect(streamedBeforeEnd).toBe(true);
    const deltas = events.filter(event => event.type === 'text_delta').map(event => event.delta).join('');
    expect(deltas).toBe(`${prefix}[API 密钥已隐藏]${suffix}`);
    expect(deltas).not.toContain(key);
    const saved = events.find(event => event.type === 'session_file');
    if (saved?.type !== 'session_file') throw new Error('No saved session file');
    await engine.handle({ ...req, runId: 'secret-error', piFile: saved.file, prompt: '触发模拟鉴权错误' });
    expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'failed', error: expect.stringContaining('[API 密钥已隐藏]') });
    expect(JSON.stringify(events)).not.toContain(key);
    expect(JSON.stringify(payloads[1])).not.toContain(key);
    const jsonl = await readFile(saved.file, 'utf8');
    expect(jsonl).not.toContain(key);
    expect(jsonl).toContain('Invalid configured API key: [API 密钥已隐藏]');
    expect(jsonl).toContain(`${prefix}[API 密钥已隐藏]${suffix}`);
    for (const file of await readdir(path.join(req.dataDir, 'logs'))) {
      expect(await readFile(path.join(req.dataDir, 'logs', file), 'utf8')).not.toContain(key);
    }
  } finally { await engine.shutdown(); await closeServer(server); }
}, 30_000);
