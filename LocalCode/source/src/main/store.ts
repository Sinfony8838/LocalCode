import { workspaceContext, workspaceBoundary, isWorkspaceAccessError, pathKey } from '../core/workspace-context';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent, AppSettings, Project, ProviderConfig, SessionView, Theme, SidebarPreferences, AttachmentInfo, ApprovalMode, WorkMode, GoalState } from '../shared/contracts';
import { localOllamaUrl, MANAGED_OLLAMA_URL } from '../shared/providers';
import { reduceAgentEvent } from '../shared/session-events';
import { DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_SIDEBAR } from '../shared/contracts';
import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from '../shared/i18n';
import { beginRunChanges, discardRunChanges, finishRunChanges, recoverRunChanges } from '../core/run-changes';

interface Index { version: 1; projects: Project[]; sessions: SessionView[]; settings: AppSettings; keys: Record<string, string> }
const local: ProviderConfig = { id: 'local', name: 'Ollama 本地模型', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'localcode-agent:latest', contextWindow: 8192, maxTokens: 1024, hasKey: false };
export class Store {
  private state!: Index;
  private writes = Promise.resolve();
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private backgroundError?: unknown;
  private discardedRunSnapshots = new Set<string>();
  readonly indexFile: string;
  constructor(readonly dataDir: string) { this.indexFile = path.join(dataDir, 'index.json'); }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const text = await fs.readFile(this.indexFile, 'utf8');
      this.state = JSON.parse(text);
      if (this.state.version !== 1 || !Array.isArray(this.state.projects) || !Array.isArray(this.state.sessions) || !Array.isArray(this.state.settings?.providers) || !this.state.keys) throw new Error('数据索引格式不正确，原文件已保留。');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      let profile = { contextWindow: 8192, maxTokens: 1024 };
      try {
        const schema = z.object({ contextWindow: z.number().int().min(4096).max(131072), maxTokens: z.number().int().min(128).max(32768) }).strict().refine(v => v.maxTokens + 1536 < v.contextWindow);
        profile = schema.parse(JSON.parse(await fs.readFile(path.join(this.dataDir, '..', 'model-profile.json'), 'utf8')));
      } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('本地模型配置无效，请检查 model-profile.json。'); }
      this.state = { version: 1, projects: [], sessions: [], settings: { theme: 'light', fontSize: DEFAULT_FONT_SIZE, locale: DEFAULT_LOCALE, defaultProviderId: 'local', providers: [{ ...local, ...profile, id: 'local' }] }, keys: {} };
    }
    if (!isAppLocale(this.state.settings.locale)) this.state.settings.locale = DEFAULT_LOCALE;
    const fontSize = this.state.settings.fontSize;
    if (!Number.isInteger(fontSize) || fontSize < MIN_FONT_SIZE || fontSize > MAX_FONT_SIZE) this.state.settings.fontSize = DEFAULT_FONT_SIZE;
    this.state.settings.sidebar = { ...DEFAULT_SIDEBAR, ...this.state.settings.sidebar, collapsedProjects: this.state.settings.sidebar?.collapsedProjects || [] };
    for (const session of this.state.sessions) {
      session.projectId ??= null;
      session.approvalMode ??= 'ask'; session.workMode ??= 'execute';
      if (session.goal?.status === 'active') { session.goal.status = 'paused'; session.goal.reason = '应用重启，目标已暂停。'; }
      delete session.question;
      if (['running', 'awaiting_approval', 'awaiting_input'].includes(session.status)) {
        session.status = 'interrupted'; session.error = '上次运行被中断。不会自动重放命令，可以发送新消息继续。';
      }
      for (const run of session.runs ?? []) if (run.status === 'running') {
        run.status = 'interrupted'; run.endedAt = session.updatedAt;
        delete run.finalMessageId;
        run.durationMs = Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
        Object.assign(run, session.projectId ? await recoverRunChanges(this.sessionWorkspace(session.id), session.id, run.runId) : { changes: [], changeScope: 'file_tools' as const });
      }
      session.messages.filter(m => m.partial).forEach(m => { m.partial = false; });
      for (const message of session.messages) for (const part of message.parts ?? []) if (part.state === 'streaming') { part.state = 'interrupted'; part.endedAt = new Date().toISOString(); }
      delete session.progress;
      session.tools.filter(t => t.status === 'running').forEach(t => { t.status = 'failed'; t.isError = true; t.result = '应用退出，执行状态未确认。不会自动重试。'; });
      delete session.approval;
    }
    await this.persist();
  }
  persist() {
    clearTimeout(this.deltaTimer); this.deltaTimer = undefined;
    const snapshot = JSON.stringify(this.state, null, 2);
    // Capture the same terminal rounds as the queued index, not later mutable state.
    // This also retires pre-upgrade snapshots and recovered interrupted rounds on init.
    const terminalRuns = this.state.sessions.flatMap(session => (session.runs ?? [])
      .filter(run => run.status !== 'running')
      .map(run => ({ sessionId: session.id, runId: run.runId })));
    const write = async () => {
      const tmp = this.indexFile + '.' + randomUUID() + '.tmp';
      await fs.writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, this.indexFile); break; }
        catch (error: any) {
          // Windows readers/scanners can briefly hold a file without FILE_SHARE_DELETE.
          // Keep the previous index intact; never replace atomic rename with truncating writes.
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 30) throw error;
          await new Promise(resolve => setTimeout(resolve, 50 + attempt * 10));
        }
      }
      for (const { sessionId, runId } of terminalRuns) {
        const key = `${sessionId}/${runId}`;
        if (this.discardedRunSnapshots.has(key)) continue;
        try {
          await discardRunChanges(this.dataDir, sessionId, runId);
          this.discardedRunSnapshots.add(key);
        } catch { /* Keep the durable summary; retry cleanup on the next write/startup. */ }
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
  async flush() { if (this.deltaTimer) await this.persist(); await this.writes; if (this.backgroundError) throw this.backgroundError; }
  projects() { return structuredClone(this.state.projects); }
  sessions() { return structuredClone(this.state.sessions); }
  settings() { return structuredClone(this.state.settings); }
  project(id: string) { const p = this.state.projects.find(p => p.id === id); if (!p) throw new Error('项目不存在'); return p; }
  session(id: string) { const s = this.state.sessions.find(s => s.id === id); if (!s) throw new Error('会话不存在'); return s; }
  provider(id: string) { const p = this.state.settings.providers.find(p => p.id === id); if (!p) throw new Error('模型配置不存在'); return p; }
  workspace(projectId: string) { return workspaceContext(this.project(projectId).path, this.dataDir); }
  sessionWorkspace(sessionId: string) { const id = this.session(sessionId).projectId; return id ? this.workspace(id) : workspaceContext('', this.dataDir); }
  encryptedKey(id: string) { return this.state.keys[id]; }
  async addProject(folder: string) {
    const canonical = await fs.realpath(folder);
    await workspaceBoundary(workspaceContext(canonical, this.dataDir));
    const existing = this.state.projects.find(p => pathKey(p.path) === pathKey(canonical));
    if (existing) return structuredClone(existing);
    const project = { id: randomUUID(), name: path.basename(canonical) || canonical, path: canonical, createdAt: new Date().toISOString() };
    this.state.projects.push(project); await this.persist(); return structuredClone(project);
  }
  async createSession(projectId: string | null = null) {
    if (projectId !== null) this.project(projectId);
    const now = new Date().toISOString();
    const session: SessionView = { id: randomUUID(), projectId, title: '新会话', createdAt: now, updatedAt: now, providerId: 'local', status: 'idle', approvalMode: 'ask', workMode: 'execute', messages: [], tools: [] };
    this.state.sessions.unshift(session); await this.persist(); return structuredClone(session);
  }
  async moveSession(sessionId: string, projectId: string) {
    this.project(projectId);
    const session = this.session(sessionId);
    if (['running', 'awaiting_approval', 'awaiting_input'].includes(session.status)) throw new Error('请等待任务结束后再移入项目。');
    if (session.projectId === projectId) return structuredClone(session);
    // A projectless transcript has no workspace journal to rebind or move.
    if (session.projectId) throw new Error('此任务已属于项目；可在目标项目中新建任务。');
    session.projectId = projectId; session.updatedAt = new Date().toISOString();
    await this.persist(); return structuredClone(session);
  }
  async setProjectPinned(projectId: string, pinned: boolean) {
    const project = this.project(projectId); project.pinned = pinned;
    await this.persist(); return structuredClone(project);
  }
  async setSidebar(patch: Partial<SidebarPreferences>) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'collapsedProjects') { if (!Array.isArray(value)) throw new Error('折叠项目设置无效'); value.forEach(id => this.project(id)); }
      else if (!['pinnedCollapsed', 'projectsCollapsed', 'recentCollapsed', 'archivedCollapsed'].includes(key) || typeof value !== 'boolean') throw new Error('侧栏设置无效');
    }
    this.state.settings.sidebar = { ...DEFAULT_SIDEBAR, ...this.state.settings.sidebar, ...patch };
    await this.persist(); return structuredClone(this.state.settings.sidebar);
  }
  async renameSession(id: string, title: string) { const s = this.session(id); s.title = title; await this.persist(); return structuredClone(s); }
  async archiveSession(id: string, archived: boolean) {
    const session = this.session(id);
    if (archived) {
      if (['running', 'awaiting_approval', 'awaiting_input'].includes(session.status)) throw new Error('请等待任务结束后再归档。');
      session.archivedAt = new Date().toISOString();
    } else delete session.archivedAt;
    await this.persist(); return structuredClone(session);
  }
  async deleteSession(id: string) {
    const session = this.session(id);
    if (['running', 'awaiting_approval', 'awaiting_input'].includes(session.status)) throw new Error('请等待任务结束后再删除。');
    this.state.sessions = this.state.sessions.filter(s => s.id !== id);
    await this.persist();
    return structuredClone(session);
  }
  async beginRun(sessionId: string, prompt: string, providerId: string, modelId?: string, options: { attachments?: AttachmentInfo[]; approvalMode?: ApprovalMode; workMode?: WorkMode; automatic?: boolean } = {}) {
    const s = this.session(sessionId); this.provider(providerId);
    const workspace = this.sessionWorkspace(sessionId);
    if (s.projectId) await workspaceBoundary(workspace);
    // Main-process guards prevent overlap; retain a truthful boundary if callers
    // replace an unfinished round (for example during recovery).
    for (const previous of s.runs ?? []) if (previous.status === 'running') {
      previous.status = 'interrupted'; previous.endedAt = new Date().toISOString();
      delete previous.finalMessageId;
      previous.durationMs = Math.max(0, Date.parse(previous.endedAt) - Date.parse(previous.startedAt));
      Object.assign(previous, s.projectId ? await recoverRunChanges(workspace, sessionId, previous.runId) : { changes: [], changeScope: 'file_tools' as const });
    }
    s.runId = randomUUID(); s.status = 'running'; s.providerId = providerId; s.error = undefined; s.approval = undefined;
    delete s.progress;
    delete s.question;
    s.approvalMode = options.approvalMode ?? s.approvalMode ?? 'ask';
    s.workMode = options.workMode ?? s.workMode ?? 'execute';
    s.modelId = modelId;
    s.updatedAt = new Date().toISOString();
    if (s.title === '新会话') s.title = (prompt.trim() || options.attachments?.[0]?.name || '附件任务').replace(/\s+/g, ' ').slice(0, 36);
    s.messages.push({ id: randomUUID(), role: 'user', text: prompt, createdAt: s.updatedAt, runId: s.runId, ...(options.attachments?.length ? { attachments: options.attachments } : {}), ...(options.automatic ? { automatic: true } : {}) });
    const run = { runId: s.runId, startedAt: s.updatedAt, status: 'running' as const, changes: [], changeScope: 'workspace_snapshot' as const };
    (s.runs ??= []).push(run);
    try { if (s.projectId) await beginRunChanges(workspace, sessionId, s.runId); }
    catch (error) { if (isWorkspaceAccessError(error)) throw error; /* Ordinary snapshot failures remain visible in the summary. */ }
    await this.persist(); return structuredClone(s);
  }
  async event(event: AgentEvent): Promise<AgentEvent | undefined> {
    const index = this.state.sessions.findIndex(s => s.id === event.sessionId);
    if (index === -1 || this.state.sessions[index].runId !== event.runId) return;
    // One authoritative receipt timestamp is persisted and broadcast to the UI.
    // Reducers must not independently call the clock for the same event.
    event = { ...event, recordedAt: new Date().toISOString() };
    const current = this.state.sessions[index];
    const run = current.runs?.find(run => run.runId === event.runId);
    if (run && run.status !== 'running') return event;
    if (event.type === 'settled' && run) {
      const endedAt = event.recordedAt!;
      const evidence = current.projectId ? await finishRunChanges(this.sessionWorkspace(event.sessionId), event.sessionId, event.runId) : { changes: [], changeScope: 'file_tools' as const };
      const finalMessageId = event.status === 'completed' ? run.finalMessageId : undefined;
      event = { ...event, summary: { ...run, ...evidence, status: event.status, endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)), finalMessageId } };
    }
    this.state.sessions[index] = reduceAgentEvent(this.state.sessions[index], event);
    if (event.type === 'part_delta' || event.type === 'text_delta' || event.type === 'progress') {
      this.deltaTimer ??= setTimeout(() => { this.deltaTimer = undefined; void this.persist().catch(error => { this.backgroundError = error; }); }, 500);
      return event;
    }
    await this.persist();
    return event;
  }
  async saveProvider(provider: ProviderConfig, encryptedKey?: string | null) {
    if (provider.kind === 'ollama' && provider.id !== 'local') throw new Error('Ollama 使用内置本地配置；其他服务请添加兼容 API。');
    if (provider.id === 'local') {
      if (provider.kind !== 'ollama') throw new Error('内置本地配置必须使用 Ollama。');
      provider = { ...provider, baseUrl: localOllamaUrl(provider.baseUrl) };
      if (provider.ollamaMode !== 'existing' && provider.baseUrl !== MANAGED_OLLAMA_URL) throw new Error('请显式选择已有 Ollama 后再修改地址。');
      if (!Number.isInteger(provider.contextWindow) || provider.contextWindow < 2048 || provider.contextWindow > 2097152 || !Number.isInteger(provider.maxTokens) || provider.maxTokens < 128 || provider.maxTokens > 131072 || provider.maxTokens + 1536 >= provider.contextWindow) throw new Error('本地模型上下文和输出预算无效。');
      if (!provider.model.trim() || provider.model.length > 200) throw new Error('请填写已安装的本地模型名称。');
      provider.model = provider.model.trim();
      if (encryptedKey) throw new Error('本地 Ollama 不保存 API Key。');
      provider.enabled = true;
      delete provider.models;
    }
    if (encryptedKey === null) delete this.state.keys[provider.id];
    else if (encryptedKey !== undefined) this.state.keys[provider.id] = encryptedKey;
    provider.hasKey = !!this.state.keys[provider.id];
    const i = this.state.settings.providers.findIndex(p => p.id === provider.id);
    if (i >= 0) this.state.settings.providers[i] = provider; else this.state.settings.providers.push(provider);
    await this.persist(); return structuredClone(provider);
  }
  /** Compare the identity before mutating: late workers cannot update a replacement goal. */
  async updateGoal(sessionId: string, expectedId: string, patch: Partial<Omit<GoalState, 'id'>>) {
    const session = this.session(sessionId);
    if (session.goal?.id !== expectedId) return false;
    if (session.goal.status === 'budget_limited' && patch.status && patch.status !== 'budget_limited') return false;
    session.goal = { ...session.goal, ...patch, updatedAt: new Date().toISOString() };
    await this.persist(); return true;
  }
  async replaceGoal(sessionId: string, goal?: GoalState) { const session = this.session(sessionId); session.goal = goal; await this.persist(); }
  async acceptPlan(sessionId: string, planId: string) {
    const session = this.session(sessionId);
    if (!session.plan || session.plan.id !== planId || session.plan.status !== 'proposed') throw new Error('计划已失效。');
    session.plan.status = 'accepted'; session.workMode = 'execute'; await this.persist();
  }
  async deleteProvider(id: string) {
    if (id === 'local') throw new Error('内置本地模型不可删除。');
    this.provider(id);
    this.state.settings.providers = this.state.settings.providers.filter(p => p.id !== id);
    delete this.state.keys[id];
    if (this.state.settings.defaultProviderId === id) this.state.settings.defaultProviderId = 'local';
    await this.persist();
  }
  async setTheme(theme: Theme) { this.state.settings.theme = theme; await this.persist(); }
  async setLocale(locale: AppLocale) {
    if (!isAppLocale(locale)) throw new Error('语言设置无效。');
    this.state.settings.locale = locale;
    await this.persist();
  }
  async setFontSize(fontSize: number) {
    if (!Number.isInteger(fontSize) || fontSize < MIN_FONT_SIZE || fontSize > MAX_FONT_SIZE) throw new Error('字号必须是 12–20 之间的整数。');
    this.state.settings.fontSize = fontSize;
    await this.persist();
  }
}
