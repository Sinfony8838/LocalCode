import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/store';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const base = path.resolve('../cache/tests'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'localcode-store-')); roots.push(root);
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const store = new Store(path.join(root, 'data')); await store.init();
  const p = await store.addProject(project); const s = await store.createSession(p.id);
  return { root, project, store, p, s };
}
describe('durable UI index', () => {
  it('creates idle sessions with durable mode defaults so a restart does not mutate them', async () => {
    const { store } = await setup();
    const idle = await store.createSession();
    expect(idle).toMatchObject({approvalMode:'ask',workMode:'execute',status:'idle'});
    const reopened = new Store(store.dataDir); await reopened.init();
    expect(reopened.session(idle.id)).toEqual(idle);
  });
  it('migrates missing or invalid language settings and persists valid settings without changing history', async () => {
    const { store, s } = await setup();
    expect(store.settings().locale).toBe('zh-CN');
    for (const legacyLocale of [undefined, 'fr', null, 123]) {
      const legacy = JSON.parse(await fs.readFile(store.indexFile, 'utf8'));
      if (legacyLocale === undefined) delete legacy.settings.locale; else legacy.settings.locale = legacyLocale;
      await fs.writeFile(store.indexFile, JSON.stringify(legacy));
      const reopened = new Store(store.dataDir); await reopened.init();
      expect(reopened.settings().locale).toBe('zh-CN');
      expect(reopened.session(s.id).id).toBe(s.id);
    }
    for (const locale of ['en', 'ja', 'ko', 'zh-CN'] as const) {
      await store.setLocale(locale);
      const reopened = new Store(store.dataDir); await reopened.init();
      expect(reopened.settings().locale).toBe(locale);
      expect(reopened.session(s.id).id).toBe(s.id);
    }
    for (const invalid of ['fr', '', null, 123, undefined]) await expect(store.setLocale(invalid as any)).rejects.toThrow('语言设置无效');
    expect(store.settings().locale).toBe('zh-CN');
  });
  it('loads fresh local budgets and refuses credential or endpoint injection through the deployment profile', async () => {
    const { root } = await setup();
    const fresh = path.join(root, 'fresh'); await fs.mkdir(fresh);
    await fs.writeFile(path.join(fresh, 'model-profile.json'), JSON.stringify({ contextWindow: 16384, maxTokens: 2048 }));
    const store = new Store(path.join(fresh, 'data')); await store.init();
    expect(store.provider('local')).toMatchObject({ model: 'localcode-agent:latest', contextWindow: 16384, maxTokens: 2048, baseUrl: 'http://127.0.0.1:11434/v1' });
    const bad = path.join(root, 'bad'); await fs.mkdir(bad);
    await fs.writeFile(path.join(bad, 'model-profile.json'), JSON.stringify({ contextWindow: 8192, maxTokens: 1024, baseUrl: 'https://example.com', hasKey: true }));
    await expect(new Store(path.join(bad, 'data')).init()).rejects.toThrow('本地模型配置无效');
    await expect(fs.access(path.join(bad, 'data/index.json'))).rejects.toThrow();
  });
  it('persists attachments and plans, pauses goals on restart and ignores old goal identities', async () => {
    const { store, s } = await setup();
    const goal = { id: randomUUID(), objective:'完成验证', status:'active' as const, budgetMs:7200000, activeMs:1200, updatedAt:new Date().toISOString() };
    await store.replaceGoal(s.id,goal);
    expect(await store.updateGoal(s.id,'old-goal',{status:'complete'})).toBe(false);
    const attachment = {id:randomUUID(),name:'示例.png',kind:'image' as const,size:128,mimeType:'image/png',previewUrl:'localcode-attachment://asset/example'};
    const run = await store.beginRun(s.id,'附件分析','local',undefined,{attachments:[attachment],workMode:'plan',approvalMode:'full'});
    const base = {sessionId:s.id,runId:run.runId!};
    await store.event({...base,type:'plan',plan:{id:'plan-1',runId:run.runId!,text:'只读分析结果',status:'proposed'}});
    await store.event({...base,type:'question',question:{id:'q-1',...base,questions:[{header:'范围',question:'选择范围',options:[{label:'小'}]}]}});
    const recovered = new Store(store.dataDir); await recovered.init(); const session = recovered.session(s.id);
    expect(session.status).toBe('interrupted'); expect(session.question).toBeUndefined();
    expect(session.goal).toMatchObject({id:goal.id,status:'paused',activeMs:1200});
    expect(session.messages[0].attachments).toEqual([attachment]); expect(session.plan?.text).toBe('只读分析结果');
    expect(session.workMode).toBe('plan'); expect(session.approvalMode).toBe('full');
    await recovered.updateGoal(s.id,goal.id,{status:'budget_limited'});
    expect(await recovered.updateGoal(s.id,goal.id,{status:'complete'})).toBe(false);
    expect(recovered.session(s.id).goal?.status).toBe('budget_limited');
  });
  it('starts projectless conversations without a workspace snapshot, then moves the same transcript into a project', async () => {
    const { root, project } = await setup();
    const store = new Store(path.join(root, 'chat-data')); await store.init();
    const chat = await store.createSession(); expect(store.projects()).toEqual([]); expect(chat.projectId).toBeNull();
    const run = await store.beginRun(chat.id, '先讨论想法', 'local');
    const base = { sessionId: chat.id, runId: run.runId! };
    await store.event({ ...base, type: 'message_end', messageId: 'chat-answer', text: '可以先聊，不需要文件夹。' });
    await store.event({ ...base, type: 'session_file', file: 'private-chat-transcript.jsonl' });
    await store.event({ ...base, type: 'settled', status: 'completed' });
    const completed = structuredClone(store.session(chat.id));
    expect(completed.runs?.[0]).toMatchObject({ status: 'completed', changes: [], changeScope: 'file_tools' });
    expect(completed.runs?.[0].changesError).toBeUndefined();
    await expect(fs.stat(path.join(store.dataDir, 'changes', chat.id, 'runs'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.moveSession(chat.id, randomUUID())).rejects.toThrow('项目不存在');
    expect(store.session(chat.id).projectId).toBeNull();
    const target = await store.addProject(project);
    const moved = await store.moveSession(chat.id, target.id);
    expect(moved.id).toBe(chat.id); expect(moved.messages).toEqual(completed.messages);
    expect(moved.runs).toEqual(completed.runs); expect(moved.piFile).toBe(completed.piFile);
    expect(await store.moveSession(chat.id, target.id)).toEqual(moved);
    const reopened = new Store(store.dataDir); await reopened.init();
    expect(reopened.session(chat.id)).toEqual(moved);
    const otherPath = path.join(root, 'other-project'); await fs.mkdir(otherPath);
    const other = await reopened.addProject(otherPath);
    await expect(reopened.moveSession(chat.id, other.id)).rejects.toThrow('已属于项目');
  });
  it('persists project pinning and collapsed sections without changing historical project ownership', async () => {
    const { store, p, s } = await setup();
    await store.setProjectPinned(p.id, true);
    await store.setSidebar({ projectsCollapsed: true, recentCollapsed: true, collapsedProjects: [p.id] });
    const reopened = new Store(store.dataDir); await reopened.init();
    expect(reopened.project(p.id).pinned).toBe(true);
    expect(reopened.settings().sidebar).toMatchObject({ projectsCollapsed: true, recentCollapsed: true, collapsedProjects: [p.id] });
    expect(reopened.session(s.id).projectId).toBe(p.id);
    await reopened.setProjectPinned(p.id, false); expect(reopened.project(p.id).pinned).toBe(false);
    await expect(reopened.setSidebar({ collapsedProjects: [randomUUID()] })).rejects.toThrow('项目不存在');
    const standalone = await reopened.createSession(null); await reopened.beginRun(standalone.id, 'running', 'local');
    await expect(reopened.moveSession(standalone.id, p.id)).rejects.toThrow('任务结束');
    expect(reopened.session(standalone.id).projectId).toBeNull();
  });
  it('persists multiple models and toggles, preserves blank-key edits, and deletes only provider credentials', async () => {
    const { store, p, s } = await setup();
    await store.saveProvider({ id: 'ark', name: 'Ark', kind: 'anthropic', baseUrl: 'https://example.com', model: 'one', contextWindow: 32768, maxTokens: 4096, hasKey: false, enabled: true,
      models: [{ id: 'one', contextWindow: 32768, maxTokens: 4096, enabled: true }, { id: 'two', contextWindow: 65536, maxTokens: 8192, enabled: false }] }, 'encrypted-ark-key');
    await store.beginRun(s.id, 'cloud history', 'ark', 'one');
    await store.saveProvider({ ...store.provider('ark'), enabled: false });
    const reopened = new Store(store.dataDir); await reopened.init();
    expect(reopened.provider('ark')).toMatchObject({ enabled: false, hasKey: true, models: [expect.objectContaining({ id: 'one' }), expect.objectContaining({ id: 'two', enabled: false })] });
    expect(reopened.encryptedKey('ark')).toBe('encrypted-ark-key');
    expect(reopened.session(s.id).modelId).toBe('one');
    await reopened.deleteProvider('ark');
    expect(reopened.encryptedKey('ark')).toBeUndefined();
    expect(reopened.sessions()).toHaveLength(1); expect(reopened.project(p.id)).toBeTruthy();
    await expect(reopened.deleteProvider('local')).rejects.toThrow('不可删除');
    await reopened.saveProvider({ ...reopened.provider('local'), enabled: false, models: [{ id: 'injected', contextWindow: 65536, maxTokens: 8192, enabled: true }] });
    expect(reopened.provider('local')).toMatchObject({ enabled: true, model: 'localcode-agent:latest' });
    expect(reopened.provider('local').models).toBeUndefined();
  });
  it('migrates legacy font settings, persists size, and rejects invalid changes', async () => {
    const { store, s } = await setup();
    const legacy = JSON.parse(await fs.readFile(store.indexFile, 'utf8'));
    delete legacy.settings.fontSize;
    await fs.writeFile(store.indexFile, JSON.stringify(legacy));
    const migrated = new Store(store.dataDir); await migrated.init();
    expect(migrated.settings().fontSize).toBe(14);
    expect(migrated.session(s.id).id).toBe(s.id);
    await migrated.setFontSize(20);
    const reopened = new Store(store.dataDir); await reopened.init();
    expect(reopened.settings().fontSize).toBe(20);
    for (const value of [11, 21, 14.5, NaN, Infinity]) await expect(reopened.setFontSize(value)).rejects.toThrow('字号');
    expect(reopened.settings().fontSize).toBe(20);
    const invalid = JSON.parse(await fs.readFile(store.indexFile, 'utf8'));
    invalid.settings.fontSize = 'huge';
    await fs.writeFile(store.indexFile, JSON.stringify(invalid));
    const recovered = new Store(store.dataDir); await recovered.init();
    expect(recovered.settings().fontSize).toBe(14);
    expect(recovered.session(s.id).id).toBe(s.id);
  });
  it('recovers interrupted history, drops approval, and never replays a command', async () => {
    const { store, s } = await setup();
    const run = await store.beginRun(s.id, '修复中文测试', 'local');
    const base = { sessionId: s.id, runId: run.runId! };
    await store.event({ ...base, type: 'tool_start', toolCallId: 't1', name: 'powershell', args: { command: 'Write-Output test' } });
    await store.event({ ...base, type: 'approval', approval: { id: 'approve-1', ...base, command: 'Write-Output test', cwd: 'D:\\fixture' } });
    await store.event({ ...base, type: 'session_file', file: 'durable-pi-session.jsonl' });
    const reopened = new Store(store.dataDir); await reopened.init();
    const recovered = reopened.session(s.id);
    expect(recovered.status).toBe('interrupted'); expect(recovered.approval).toBeUndefined();
    expect(recovered.tools[0].status).toBe('failed'); expect(recovered.messages[0].text).toBe('修复中文测试');
    expect(recovered.piFile).toBe('durable-pi-session.jsonl');
  });
  it('ignores old task events after a new task and persists completed transcript', async () => {
    const { store, s } = await setup();
    const first = await store.beginRun(s.id, 'first', 'local');
    const second = await store.beginRun(s.id, 'second', 'local');
    await store.event({ type: 'approval', sessionId: s.id, runId: first.runId!, approval: { id: 'old', sessionId: s.id, runId: first.runId!, command: 'bad', cwd: '.' } });
    expect(store.session(s.id).approval).toBeUndefined();
    const base = { sessionId: s.id, runId: second.runId! }; const messageId = randomUUID();
    await store.event({ ...base, type: 'message_start', messageId });
    await store.event({ ...base, type: 'text_delta', messageId, delta: '中文' });
    await store.event({ ...base, type: 'message_end', messageId, text: '中文已完成' });
    await store.event({ ...base, type: 'settled', status: 'completed' });
    const reopened = new Store(store.dataDir); await reopened.init();
    expect(reopened.session(s.id).status).toBe('completed'); expect(reopened.session(s.id).messages.at(-1)?.text).toBe('中文已完成');
  });
  it('keeps encrypted key out of public bootstrap and respects validated local profile', async () => {
    const { store, root } = await setup();
    await store.saveProvider({ id: 'mock', name: 'Mock', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'fixture', contextWindow: 8192, maxTokens: 1024, hasKey: false }, 'encrypted-only');
    expect(JSON.stringify(store.settings())).not.toContain('encrypted-only');
    expect(store.provider('mock').hasKey).toBe(true);
    await store.saveProvider({ ...store.provider('mock'), name: 'Renamed' });
    expect(store.encryptedKey('mock')).toBe('encrypted-only');
    await store.saveProvider({ ...store.provider('local'), contextWindow: 4096, maxTokens: 512 });
    expect(store.provider('local').contextWindow).toBe(4096);
    await fs.writeFile(path.join(root, 'model-profile.json'), JSON.stringify({ contextWindow: 4096, maxTokens: 512 }));
    const fresh = new Store(path.join(root, 'other')); await fresh.init();
    expect(fresh.provider('local').maxTokens).toBe(512);
  });
  it('edits local model and budgets without replacing history, keys or an in-flight provider snapshot', async () => {
    const { store, s } = await setup();
    await store.beginRun(s.id, 'keep this history', 'local', 'localcode-agent:latest');
    const snapshot = { ...store.provider('local') };
    await store.saveProvider({ ...store.provider('local'), model: 'small:latest', contextWindow: 4096, maxTokens: 512, baseUrl: 'http://localhost:11500/v1', ollamaMode: 'existing' });
    expect(snapshot).toMatchObject({ model: 'localcode-agent:latest', contextWindow: 8192, baseUrl: 'http://127.0.0.1:11434/v1' });
    const reopened = new Store(store.dataDir); await reopened.init();
    expect(reopened.provider('local')).toMatchObject({ model: 'small:latest', contextWindow: 4096, maxTokens: 512, baseUrl: 'http://127.0.0.1:11500/v1', ollamaMode: 'existing', hasKey: false });
    expect(reopened.session(s.id).messages[0].text).toBe('keep this history');
    expect(reopened.session(s.id).modelId).toBe('localcode-agent:latest');
    for (const patch of [{ baseUrl: 'https://example.com/v1' }, { baseUrl: 'http://127.0.0.1:11500/v1', ollamaMode: 'managed' as const }, { contextWindow: 4096, maxTokens: 4096 }]) {
      await expect(reopened.saveProvider({ ...reopened.provider('local'), ...patch })).rejects.toThrow();
    }
    expect(reopened.provider('local').model).toBe('small:latest');
    await expect(reopened.saveProvider({ ...reopened.provider('local') }, 'encrypted-unwanted')).rejects.toThrow('不保存');
    expect(reopened.encryptedKey('local')).toBeUndefined();
  });
  it('preserves a corrupt index instead of silently replacing user history', async () => {
    const { store } = await setup(); await fs.writeFile(store.indexFile, '{damaged');
    await expect(new Store(store.dataDir).init()).rejects.toThrow();
    expect(await fs.readFile(store.indexFile, 'utf8')).toBe('{damaged');
  });
});
