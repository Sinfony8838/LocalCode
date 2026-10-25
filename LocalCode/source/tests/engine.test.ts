import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  return { type: 'run', runId, sessionId, projectPath, dataDir, prompt: '测试',
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

  it('stops at twelve calls and preserves stable assistant message IDs', async () => {
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
    await done;
    const messages = f.events.filter(event => 'messageId' in event);
    expect(new Set(messages.map(event => 'messageId' in event && event.messageId)).size).toBe(1);
    expect(f.events.find(event => event.type === 'tool_result')).toMatchObject({ result: 'complete output' });
    expect(f.events.at(-1)).toMatchObject({ type: 'settled', status: 'failed', error: expect.stringContaining('12') });
    expect(() => f.contexts[0].beforeTool('read_file', {})).toThrow();
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
