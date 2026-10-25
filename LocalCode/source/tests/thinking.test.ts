import { workspaceContext } from '../src/core/workspace-context';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentEngine } from '../src/agent/engine';
import { Store } from '../src/main/store';
import { reduceAgentEvent } from '../src/shared/session-events';
import type { AgentEvent, RunRequest, SessionView } from '../src/shared/contracts';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
// @ts-expect-error Shared local-only JavaScript protocol fixture.
import { providerFixture } from '../scripts/provider-fixture.mjs';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup(kind: 'anthropic' | 'openai' | 'responses') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localcode-thinking-')); roots.push(root);
  const projectPath = path.join(root, 'project'); const dataDir = path.join(root, 'data');
  await Promise.all([fs.mkdir(projectPath), fs.mkdir(dataDir)]); await fs.writeFile(path.join(projectPath, 'sample.txt'), 'fixture');
  const key = 'private-key-split-across-reasoning-fragments';
  const fixture = await providerFixture(key);
  const req: RunRequest = { type: 'run', sessionId: 'session', runId: `run-${kind}`, ...workspaceContext(await fs.realpath(projectPath), dataDir), prompt: 'fixture', provider: { id: 'fixture', name: 'fixture', kind, baseUrl: fixture.baseUrl, model: 'fixture-model', contextWindow: 8192, maxTokens: 1024, hasKey: true, apiKey: key } };
  const events: AgentEvent[] = []; const engine = new AgentEngine(e => events.push(e));
  return { root, key, fixture, req, events, engine };
}
for (const kind of ['anthropic', 'openai', 'responses'] as const) {
  it(`${kind}: streams thinking, redacts each channel, executes a tool once across HTTP recovery and resumes`, async () => {
    const f = await setup(kind);
    f.fixture.queue.push({ thinking: `正在分析。${f.key}。准备读取。`, tool: { name: 'read_file', args: { path: 'sample.txt' } } }, { error: 429, headers: { 'retry-after-ms': '0' } }, { thinking: '继续分析。', text: '完成。' });
    try {
      await f.engine.handle(f.req);
      expect(f.events.at(-1)).toMatchObject({ type: 'settled', status: 'completed' });
      expect(f.events.filter(e => e.type === 'tool_start')).toHaveLength(1);
      expect(f.fixture.requests).toHaveLength(3);
      expect(f.fixture.requests[1].body).toEqual(f.fixture.requests[2].body);
      expect(f.fixture.requests[0].body).not.toHaveProperty('thinking');
      expect(f.fixture.requests[0].body).not.toHaveProperty('reasoning_effort');
      const thinking = f.events.filter(e => e.type === 'part_delta').map(e => e.delta).join('');
      expect(thinking).toContain('[API 密钥已隐藏]'); expect(JSON.stringify(f.events)).not.toContain(f.key);
      const sessionEvent = f.events.find(e => e.type === 'session_file');
      if (sessionEvent?.type !== 'session_file') throw new Error('session not published');
      const transcript = await fs.readFile(sessionEvent.file, 'utf8'); expect(transcript).not.toContain(f.key);
      expect(transcript).toContain('正在分析');
      const before = f.events.length;
      f.fixture.queue.push({ text: '恢复成功。' });
      await f.engine.handle({ ...f.req, runId: 'resumed', piFile: sessionEvent.file });
      expect(f.events.at(-1)).toMatchObject({ status: 'completed' });
      expect(f.events.slice(before).some(e => e.type === 'part_delta')).toBe(true);
      for (const log of await fs.readdir(path.join(f.req.dataDir, 'logs'))) { const text = await fs.readFile(path.join(f.req.dataDir, 'logs', log), 'utf8'); expect(text).not.toContain('正在分析'); expect(text).not.toContain(f.key); }
    } finally { await f.engine.shutdown(); f.fixture.close(); }
  }, 30000);
}
it('preserves partial thinking on cancel and does not retry accepted streams', async () => {
  const f = await setup('anthropic'); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.fixture.queue.push({ thinking: '部分思考内容。'.repeat(30), thinkingGate: gate, text: '不应显示' });
  try {
    const done = f.engine.handle(f.req);
    await vi.waitFor(() => expect(f.events.some(e => e.type === 'part_delta')).toBe(true));
    await f.engine.abort(); await done;
    expect(f.events.at(-1)).toMatchObject({ status: 'interrupted' });
    expect(f.events.some(e => e.type === 'part_end' && e.interrupted)).toBe(true);
    expect(f.fixture.requests).toHaveLength(1);
  } finally { release(); await f.engine.shutdown(); f.fixture.close(); }
});
it('persists live parts within 500ms, uses the same reducer, and recovers interrupted blocks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localcode-thinking-store-')); roots.push(root);
  const store = new Store(path.join(root, 'data')); await store.init(); const p = await store.addProject(root); const s = await store.createSession(p.id);
  const begun = await store.beginRun(s.id, 'legacy compatible', 'local'); const runId = begun.runId!; const at = new Date().toISOString();
  const events: AgentEvent[] = [
    { type: 'message_start', runId, sessionId: s.id, messageId: 'm' },
    { type: 'part_start', runId, sessionId: s.id, messageId: 'm', index: 0, kind: 'thinking', at },
    { type: 'part_delta', runId, sessionId: s.id, messageId: 'm', index: 0, delta: 'live partial' },
  ];
  let frontend = begun;
  for (const event of events) {
    const canonical = await store.event(event);
    expect(canonical?.recordedAt).toEqual(expect.any(String));
    frontend = reduceAgentEvent(frontend, canonical!);
    expect(frontend.updatedAt).toBe(canonical!.recordedAt);
    expect(store.session(s.id).updatedAt).toBe(canonical!.recordedAt);
  }
  expect(store.session(s.id).messages).toEqual(frontend.messages);
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(await fs.readFile(store.indexFile, 'utf8')).toContain('live partial');
  const restarted = new Store(store.dataDir); await restarted.init();
  expect(restarted.session(s.id).status).toBe('interrupted');
  expect(restarted.session(s.id).messages.at(-1)?.parts?.[0]).toMatchObject({ text: 'live partial', state: 'interrupted' });
  const before = structuredClone(restarted.session(s.id));
  expect(reduceAgentEvent(before, { type: 'part_delta', sessionId: s.id, runId: 'stale', messageId: 'm', index: 0, delta: 'BAD' })).toBe(before);
  await store.flush(); await restarted.flush();
});
it('orders interleaved parts and excludes opaque/redacted reasoning while retaining legacy text', async () => {
  const f = await setup('anthropic'); const events: AgentEvent[] = [];
  let listener!: (event: AgentSessionEvent) => void;
  const emit = (event: unknown) => listener(event as AgentSessionEvent);
  const engine = new AgentEngine(e => events.push(e), { createSession: async () => ({
    subscribe(fn) { listener = fn; return () => {}; },
    async prompt() {
      emit({ type: 'message_start', message: { role: 'assistant' } });
      const update = (value: unknown) => emit({ type: 'message_update', assistantMessageEvent: value });
      update({ type: 'thinking_start', contentIndex: 0, partial: { content: [{ type: 'thinking', thinking: 'OPAQUE_MUST_NOT_DISPLAY', redacted: true, thinkingSignature: 'ENCRYPTED_SECRET' }] } });
      update({ type: 'thinking_delta', contentIndex: 0, delta: 'OPAQUE_MUST_NOT_DISPLAY', partial: { content: [{ type: 'thinking', redacted: true }] } });
      for (const [index, kind, text] of [[1, 'text', '前文'], [2, 'thinking', '可见摘要'], [3, 'text', '后文']] as const) {
        update({ type: `${kind}_start`, contentIndex: index, partial: { content: [] } });
        update({ type: `${kind}_delta`, contentIndex: index, delta: text, partial: { content: [] } });
        update({ type: `${kind}_end`, contentIndex: index, content: text });
      }
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '前文' }, { type: 'text', text: '后文' }], stopReason: 'stop', usage: {} } });
      emit({ type: 'agent_settled' });
    }, clearQueue() {}, async abort() {}, async waitForIdle() {}, dispose() {}, sessionManager: { getSessionFile: () => undefined },
  }) });
  try {
    await engine.handle(f.req);
    expect(JSON.stringify(events)).not.toContain('OPAQUE'); expect(JSON.stringify(events)).not.toContain('ENCRYPTED_SECRET');
    let view: SessionView = { id: f.req.sessionId, runId: f.req.runId, projectId: 'p', title: '', createdAt: '', updatedAt: '', providerId: 'fixture', status: 'running', messages: [], tools: [] };
    for (const e of events) view = reduceAgentEvent(view, e);
    expect(view.messages[0].parts?.map(p => [p.index, p.type, p.text])).toEqual([[1, 'text', '前文'], [2, 'thinking', '可见摘要'], [3, 'text', '后文']]);
    expect(view.messages[0].text).toBe('前文\n后文');
    const legacy = reduceAgentEvent(view, { type: 'message_end', runId: f.req.runId, sessionId: f.req.sessionId, messageId: 'legacy', text: '旧格式正文' });
    expect(legacy.messages.at(-1)?.parts).toBeUndefined(); expect(legacy.messages.at(-1)?.text).toBe('旧格式正文');
  } finally { await engine.shutdown(); f.fixture.close(); }
});
