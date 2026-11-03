import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import { workspaceContext } from '../src/core/workspace-context.js';
import { createWorkspaceTools, applyTextReplacement, extractFileOutline } from '../src/agent/tools.js';
import {
  AgentEngine,
  buildTurnContextReminder,
  createExploreSubagentTools,
  loadWorkspaceConventions,
  maxToolCallsFor,
  pruneContextMessages,
  resolveThinkingLevel,
} from '../src/agent/engine.js';
import { isPrivateOrReservedIp, validateSafeHttpsUrl, fetchWebText } from '../src/core/web-fetch.js';
import { killAllBackgroundProcesses } from '../src/core/process-manager.js';
import type { AgentEvent, RunRequest } from '../src/shared/contracts.js';

const tempRoots: string[] = [];
afterEach(async () => {
  await killAllBackgroundProcesses();
  for (const root of tempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localcode-frontier-'));
  tempRoots.push(root);
  const projectPath = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  await Promise.all([fs.mkdir(projectPath), fs.mkdir(dataDir)]);
  const ctx = {
    ...workspaceContext(await fs.realpath(projectPath), dataDir),
    sessionId: 'frontier-session',
    runId: 'frontier-run',
    maxResultChars: 4000,
    approvalMode: 'full' as const,
    emit: () => {},
    requestApproval: async () => true,
  };
  return { root, projectPath: ctx.projectPath, dataDir, ctx };
}

describe('Step 1: Search, Read Outline, and Resilient Multi-Hunk Edit', () => {
  it('extracts file outlines for TypeScript, Python, and Markdown', async () => {
    const { projectPath, ctx } = await createFixture();
    await fs.writeFile(
      path.join(projectPath, 'sample.ts'),
      [
        'import path from "node:path";',
        'export interface UserConfig {',
        '  name: string;',
        '}',
        'export async function runTask(input: UserConfig) {',
        '  return input.name;',
        '}',
        'export class EngineRunner {}',
      ].join('\n'),
    );
    const tools = createWorkspaceTools(ctx);
    const outlineTool = tools.find((t) => t.name === 'read_outline')!;
    const res = await outlineTool.execute('o1', { path: 'sample.ts' }, undefined, undefined, {} as never);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('L2: export interface UserConfig');
    expect(text).toContain('L5: export async function runTask');
    expect(text).toContain('L8: export class EngineRunner');
    expect(extractFileOutline('README.md', '# Title\ntext\n## Section 2')).toContain('L3: ## Section 2');
    expect(extractFileOutline('app.py', 'class Worker:\n  def run(self):\n    pass')).toContain('L2: def run(self)');
  });

  it('supports regex, includePattern glob filtering, and contextLines in search', async () => {
    const { projectPath, ctx } = await createFixture();
    await fs.writeFile(path.join(projectPath, 'alpha.ts'), 'const a = 1;\nfunction computeMetric(x: number) {\n  return x * 2;\n}\nconst b = 2;');
    await fs.writeFile(path.join(projectPath, 'notes.md'), 'function computeMetric in markdown should be filtered by glob');
    const tools = createWorkspaceTools(ctx);
    const searchTool = tools.find((t) => t.name === 'search')!;
    const res = await searchTool.execute(
      's1',
      {
        query: 'function\\s+compute\\w+',
        isRegex: true,
        includePattern: '*.ts',
        contextLines: 1,
      },
      undefined,
      undefined,
      {} as never,
    );
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('alpha.ts:1- const a = 1;');
    expect(text).toContain('alpha.ts:2: function computeMetric(x: number) {');
    expect(text).toContain('alpha.ts:3-   return x * 2;');
    expect(text).not.toContain('notes.md');
  });

  it('applies multi-hunk edits with CRLF and trailing-whitespace tolerance and validates JSON syntax', async () => {
    const { projectPath, ctx } = await createFixture();
    const modified: string[] = [];
    const tools = createWorkspaceTools({ ...ctx, onFileModified: (p) => modified.push(p) });
    const editTool = tools.find((t) => t.name === 'edit_file')!;

    // File has CRLF and trailing spaces on line 1
    await fs.writeFile(path.join(projectPath, 'code.ts'), 'const first = 1;   \r\nconst second = 2;\r\nconst third = 3;\r\n');
    await editTool.execute(
      'e1',
      {
        path: 'code.ts',
        edits: [
          { oldText: 'const first = 1;\nconst second = 2;', newText: 'const first = 10;\nconst second = 20;' },
          { oldText: 'const third = 3;', newText: 'const third = 30;' },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    const updated = await fs.readFile(path.join(projectPath, 'code.ts'), 'utf8');
    expect(updated).toBe('const first = 10;\r\nconst second = 20;\r\nconst third = 30;\r\n');
    expect(modified).toContain('code.ts');

    // Duplicate match reports line numbers
    expect(() => applyTextReplacement('dup\nother\ndup', 'dup', 'new')).toThrow(/第 1、3 行/);

    // Invalid JSON edit appends syntax warning diagnostic
    await fs.writeFile(path.join(projectPath, 'config.json'), '{\n  "ok": true\n}');
    const jsonRes = await editTool.execute(
      'e2',
      { path: 'config.json', oldText: '"ok": true', newText: '"ok": true,' },
      undefined,
      undefined,
      {} as never,
    );
    expect((jsonRes.content[0] as { text: string }).text).toContain('语法检查警告');
  });
});

describe('Step 2: Monotonic Observation Pruning and Turn Context Reminder', () => {
  it('folds large historical tool outputs monotonically while protecting recent results and invalidated reads', () => {
    const largeRead = ['sample.ts（共 60 行）', ...Array.from({ length: 60 }, (_, i) => `${i + 1}: const line_${i + 1} = ${i};`)].join('\n');
    const messages = [
      { role: 'user', content: 'read files' },
      { role: 'toolResult', toolCallId: 'call-1', content: largeRead },
      { role: 'toolResult', toolCallId: 'call-2', content: 'short output 2' },
      { role: 'toolResult', toolCallId: 'call-3', content: 'short output 3' },
      { role: 'toolResult', toolCallId: 'call-4', content: 'short output 4' },
      { role: 'toolResult', toolCallId: 'call-5', content: largeRead },
    ];
    const prunedCache = new Map<string, string>();
    const pruned = pruneContextMessages(messages, {
      forcePrune: true,
      protectRecentToolResults: 2,
      minFoldLines: 20,
      prunedCache,
    });
    expect(String(pruned[1].content)).toContain('已折叠');
    // call-5 is within the 2 most recent tool results, so it stays intact
    expect(String(pruned[5].content)).toBe(largeRead);

    // Even if forcePrune is false on the next turn, call-1 remains pruned identically (monotonicity)
    const nextTurn = pruneContextMessages(messages, {
      forcePrune: false,
      contextWindow: 128000,
      prunedCache,
    });
    expect(String(nextTurn[1].content)).toBe(String(pruned[1].content));

    // If sample.ts is modified, even a recent read of sample.ts is folded immediately
    const invalidated = pruneContextMessages(messages, {
      forcePrune: false,
      contextWindow: 128000,
      modifiedFiles: new Set(['sample.ts']),
      minFoldLines: 20,
    });
    expect(String(invalidated[5].content)).toContain('已折叠');
  });
});

describe('Step 3: Loop Detector, Configurable Tool Budget, and Opt-in Project Conventions', () => {
  it('warns on 3rd consecutive identical tool call, trips circuit breaker on 5th, and resets after file edit', async () => {
    const { projectPath, ctx } = await createFixture();
    await fs.writeFile(path.join(projectPath, 'a.txt'), 'hello world');
    const tools = createWorkspaceTools(ctx);
    const readTool = tools.find((t) => t.name === 'read_file')!;
    const writeTool = tools.find((t) => t.name === 'write_file')!;

    const r1 = await readTool.execute('1', { path: 'a.txt' }, undefined, undefined, {} as never);
    const r2 = await readTool.execute('2', { path: 'a.txt' }, undefined, undefined, {} as never);
    expect((r1.content[0] as { text: string }).text).not.toContain('<loop-warning>');
    expect((r2.content[0] as { text: string }).text).not.toContain('<loop-warning>');

    const r3 = await readTool.execute('3', { path: 'a.txt' }, undefined, undefined, {} as never);
    expect((r3.content[0] as { text: string }).text).toContain('<loop-warning>');

    const r4 = await readTool.execute('4', { path: 'a.txt' }, undefined, undefined, {} as never);
    expect((r4.content[0] as { text: string }).text).toContain('<loop-warning>');

    await expect(readTool.execute('5', { path: 'a.txt' }, undefined, undefined, {} as never)).rejects.toThrow(/死循环熔断/);

    // Writing resets the loop detector
    await writeTool.execute('w1', { path: 'a.txt', content: 'updated' }, undefined, undefined, {} as never);
    const afterReset = await readTool.execute('6', { path: 'a.txt' }, undefined, undefined, {} as never);
    expect((afterReset.content[0] as { text: string }).text).not.toContain('<loop-warning>');
  });

  it('supports configurable maxToolCalls and opt-in loadWorkspaceConventions', async () => {
    const { projectPath, ctx } = await createFixture();
    await fs.writeFile(path.join(projectPath, 'AGENTS.md'), '<!-- hidden comment -->\nUse strict TypeScript.');
    const conventions = await loadWorkspaceConventions(ctx);
    expect(conventions).toContain('<project-conventions');
    expect(conventions).toContain('Use strict TypeScript.');
    expect(conventions).not.toContain('hidden comment');

    const baseReq: RunRequest = {
      ...ctx,
      type: 'run' as const,
      runId: 'r1',
      sessionId: 's1',
      prompt: 'hi',
      provider: { id: 'p', name: 'P', kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:1', model: 'm', contextWindow: 8192, maxTokens: 1024, hasKey: false, apiKey: '' },
    };
    expect(maxToolCallsFor(baseReq)).toBe(12);
    expect(maxToolCallsFor({ ...baseReq, maxToolCalls: 30 })).toBe(30);
    expect(buildTurnContextReminder({ ...baseReq, maxToolCalls: 30 }, conventions)).toContain('每轮最多 30 次');
  });
});

describe('Step 4: Configurable Thinking Level', () => {
  it('activates reasoning_effort and omits temperature=0.2 when thinkingLevel is configured', async () => {
    const { projectPath, dataDir } = await createFixture();
    const payloads: Record<string, unknown>[] = [];
    const server: Server = createServer(async (incoming, response) => {
      let body = '';
      for await (const chunk of incoming) body += chunk;
      payloads.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({
          id: 'think-1',
          object: 'chat.completion.chunk',
          model: 'mock-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: '思考完成。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind server');

    const req: RunRequest = {
      type: 'run',
      runId: 'think-run',
      sessionId: 'think-session',
      ...workspaceContext(projectPath, dataDir),
      prompt: '分析架构',
      thinkingLevel: 'high',
      provider: {
        id: 'openai',
        name: 'OpenAI',
        kind: 'openai',
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        model: 'mock-model',
        contextWindow: 16384,
        maxTokens: 2048,
        hasKey: true,
        apiKey: 'test-key-secret',
      },
    };
    expect(resolveThinkingLevel(req)).toBe('high');
    const events: AgentEvent[] = [];
    const engine = new AgentEngine((e) => events.push(e));
    try {
      await engine.handle(req);
      expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'completed' });
      expect(payloads[0]).toMatchObject({ reasoning_effort: 'high' });
      expect(payloads[0]).not.toHaveProperty('temperature');
    } finally {
      await engine.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Step 5: Isolated Read-Only Explore Codebase Subagent', () => {
  it('restricts explore subagent tools to read-only operations and enforces the 6-step cap', async () => {
    const { projectPath, ctx } = await createFixture();
    await fs.writeFile(path.join(projectPath, 'feature.ts'), 'export function calculateTotal(items: number[]) { return items.reduce((a, b) => a + b, 0); }');

    const subTools = createExploreSubagentTools(ctx);
    expect(subTools.map((t) => t.name).sort()).toEqual(['list_files', 'read_file', 'read_outline', 'search']);

    const listTool = subTools.find((t) => t.name === 'list_files')!;
    for (let i = 0; i < 6; i++) {
      await listTool.execute(`step-${i}`, { path: `dir-${i}` }, undefined, undefined, {} as never).catch(() => {});
    }
    await expect(listTool.execute('step-7', {}, undefined, undefined, {} as never)).rejects.toThrow(/最大步数上限/);

    const mainTools = createWorkspaceTools(ctx);
    const exploreTool = mainTools.find((t) => t.name === 'explore_codebase')!;
    const res = await exploreTool.execute('exp-1', { question: 'Where is calculateTotal defined?' }, undefined, undefined, {} as never);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('feature.ts');
    expect(text).toContain('calculateTotal');
  });
});

describe('Step 6: Background Process Manager and SSRF-Protected Web Fetch', () => {
  it('starts, polls, and stops a background PowerShell command via workspace tools', async () => {
    const { ctx } = await createFixture();
    const tools = createWorkspaceTools(ctx);
    const startTool = tools.find((t) => t.name === 'start_background_command')!;
    const pollTool = tools.find((t) => t.name === 'poll_process_output')!;
    const stopTool = tools.find((t) => t.name === 'stop_process')!;

    const started = await startTool.execute(
      'bg-1',
      { command: '[Console]::Out.WriteLine("READY_BG_SERVER"); [Console]::Out.Flush(); Start-Sleep -Seconds 30' },
      undefined,
      undefined,
      {} as never,
    );
    const startText = (started.content[0] as { text: string }).text;
    const match = /processId:\s*(bg-[A-Za-z0-9-]+)/.exec(startText);
    expect(match).not.toBeNull();
    const processId = match![1];

    const polled = await pollTool.execute('bg-poll', { processId, waitMs: 10000 }, undefined, undefined, {} as never);
    expect((polled.content[0] as { text: string }).text).toContain('READY_BG_SERVER');

    const stopped = await stopTool.execute('bg-stop', { processId }, undefined, undefined, {} as never);
    expect((stopped.content[0] as { text: string }).text).toContain('stopped');
  }, 25_000);

  it('blocks private, loopback, link-local, and DNS-rebound IPs and extracts readable HTTPS text', async () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.5.4')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);

    await expect(validateSafeHttpsUrl('http://example.com')).rejects.toThrow(/HTTPS/);
    await expect(validateSafeHttpsUrl('https://user:pass@example.com')).rejects.toThrow(/凭据/);
    await expect(validateSafeHttpsUrl('https://localhost/admin')).rejects.toThrow(/本地或内网/);
    await expect(validateSafeHttpsUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/内网或保留 IP/);
    await expect(
      validateSafeHttpsUrl('https://rebind.example.com', async () => [{ address: '127.0.0.1' }]),
    ).rejects.toThrow(/内网或保留地址/);

    const text = await fetchWebText('https://example.com/docs', {
      lookupFn: async () => [{ address: '93.184.216.34' }],
      fetchFn: (async () =>
        new Response('<html><head><style>body{color:red}</style></head><body><h1>API Reference</h1><script>alert(1)</script><p>Hello World</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })) as unknown as typeof fetch,
    });
    expect(text).toContain('API Reference');
    expect(text).toContain('Hello World');
    expect(text).not.toContain('alert(1)');
  });
});
